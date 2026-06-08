import Docker from "dockerode";
import crypto from "crypto";
import path from "path";
import { Writable } from "stream";
import { docker as dockerClient } from "./dockerClient";

const BASE_PATH = "/app/my-nextjs-app";
const MAX_FILE_WRITE_BYTES = 10_000_000;

function assertSafeContainerId(containerId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerId)) {
    throw new Error("Invalid container id");
  }
}

function toSafeContainerPath(filePath: string = BASE_PATH): string {
  if (typeof filePath !== "string" || filePath.includes("\0")) {
    throw new Error("Invalid file path");
  }

  const trimmedPath = filePath.trim();
  const normalizedPath = path.posix.normalize(
    trimmedPath.startsWith("/")
      ? trimmedPath
      : path.posix.join(BASE_PATH, trimmedPath || ".")
  );

  if (
    normalizedPath !== BASE_PATH &&
    !normalizedPath.startsWith(`${BASE_PATH}/`)
  ) {
    throw new Error("File path must stay inside the project workspace");
  }

  return normalizedPath;
}

function toSafeMutablePath(filePath: string): string {
  const safePath = toSafeContainerPath(filePath);

  if (safePath === BASE_PATH) {
    throw new Error("Refusing to modify the project root");
  }

  return safePath;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function writeOctalHeader(
  header: Buffer,
  value: number,
  offset: number,
  length: number
) {
  const octal = value.toString(8).padStart(length - 1, "0");
  header.write(`${octal}\0`, offset, length, "ascii");
}

function createTarArchive(fileName: string, content: string): Buffer {
  if (!fileName || fileName.includes("/") || fileName.length > 100) {
    throw new Error("Generated file name is too long for archive copy");
  }

  const contentBuffer = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512, 0);

  header.write(fileName, 0, 100, "utf8");
  writeOctalHeader(header, 0o644, 100, 8);
  writeOctalHeader(header, 0, 108, 8);
  writeOctalHeader(header, 0, 116, 8);
  writeOctalHeader(header, contentBuffer.length, 124, 12);
  writeOctalHeader(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(" ", 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;

  const paddingSize = (512 - (contentBuffer.length % 512)) % 512;
  const endBlocks = Buffer.alloc(1024, 0);

  return Buffer.concat([
    header,
    contentBuffer,
    Buffer.alloc(paddingSize, 0),
    endBlocks,
  ]);
}

async function runContainerCommand(
  containerId: string,
  command: string[],
  workingDir: string = BASE_PATH
): Promise<string> {
  assertSafeContainerId(containerId);

  const container = dockerClient.getContainer(containerId);
  const exec = await container.exec({
    Cmd: command,
    WorkingDir: workingDir,
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Detach: false, Tty: false });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(Buffer.from(chunk));
      callback();
    },
  });

  dockerClient.modem.demuxStream(stream, stdout, stderr);

  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const result = await exec.inspect();
  const output = Buffer.concat(stdoutChunks).toString("utf8");
  const errorOutput = Buffer.concat(stderrChunks).toString("utf8");

  if (result.ExitCode !== 0) {
    throw new Error(
      errorOutput.trim() ||
        output.trim() ||
        `Container command failed with exit code ${result.ExitCode}`
    );
  }

  return output || errorOutput;
}

export async function runProjectCommand(
  containerId: string,
  command: string[]
): Promise<string> {
  return runContainerCommand(containerId, command, BASE_PATH);
}

export interface FileItem {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileItem[];
  content?: string;
}

export interface FileContentItem {
  name: string;
  path: string;
  type: "file" | "directory";
  content?: string;
  children?: FileContentItem[];
}

export interface FileWriteVerification {
  path: string;
  absolutePath: string;
  bytes: number;
  sha256: string;
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export async function getFileTree(
  docker: Docker,
  containerId: string,
  containerPath: string = BASE_PATH
): Promise<FileItem[]> {
  assertSafeContainerId(containerId);
  const safeContainerPath = toSafeContainerPath(containerPath);
  const container = docker.getContainer(containerId);
  const quotedPath = shellQuote(safeContainerPath);

  const findCommand = [
    "sh",
    "-c",
    `find ${quotedPath} \\( -name node_modules -o -name .next \\) -prune -o -type f -o -type d | grep -v -E "(node_modules|\\.next)" | sort`,
  ];

  const exec = await container.exec({
    Cmd: findCommand,
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Detach: false, Tty: false });
  const output = await new Promise<string>((resolve, reject) => {
    let data = "";
    stream.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });

  const paths = output
    .trim()
    .split("\n")
    .filter((p) => p && p !== safeContainerPath);
  const fileTree: Map<string, FileItem> = new Map();

  fileTree.set(safeContainerPath, {
    name: "root",
    path: safeContainerPath,
    type: "directory",
    children: [],
  });

  for (const filePath of paths) {
    const stat = await getFileStat(container, filePath);
    const relativePath = filePath.replace(safeContainerPath + "/", "");
    const parts = relativePath.split("/");
    const fileName = parts[parts.length - 1] || "";

    const fileItem: FileItem = {
      name: fileName,
      path: filePath,
      type: stat.isDirectory ? "directory" : "file",
    };

    if (stat.isDirectory) {
      fileItem.children = [];
    }

    fileTree.set(filePath, fileItem);

    const parentPath = filePath.substring(0, filePath.lastIndexOf("/"));
    const parent = fileTree.get(parentPath || safeContainerPath);
    if (parent && parent.children) {
      parent.children.push(fileItem);
    }
  }

  const root = fileTree.get(safeContainerPath);
  return root?.children || [];
}

export async function getFileContentTree(
  docker: Docker,
  containerId: string,
  containerPath: string = BASE_PATH
): Promise<FileContentItem[]> {
  assertSafeContainerId(containerId);
  const safeContainerPath = toSafeContainerPath(containerPath);
  const container = docker.getContainer(containerId);
  const quotedPath = shellQuote(safeContainerPath);

  const findCommand = [
    "sh",
    "-c",
    `find ${quotedPath} \\( -name node_modules -o -name .next -o -path "*/components/ui" \\) -prune -o -type f -o -type d | grep -v -E "(node_modules|\\.next|components/ui|bun\\.lock|components\\.json|next-env\\.d\\.ts|package-lock\\.json|postcss\\.config\\.mjs|favicon\\.ico|\\.gitignore)" | sort`,
  ];

  const exec = await container.exec({
    Cmd: findCommand,
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Detach: false, Tty: false });
  const output = await new Promise<string>((resolve, reject) => {
    let data = "";
    stream.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });

  const paths = output
    .trim()
    .split("\n")
    .filter((p) => p && p !== safeContainerPath);

  const fileTree: Map<string, FileContentItem> = new Map();

  fileTree.set(safeContainerPath, {
    name: "root",
    path: safeContainerPath,
    type: "directory",
    children: [],
  });

  const filesToRead: string[] = [];
  const pathToItemMap: Map<string, FileContentItem> = new Map();

  for (const filePath of paths) {
    const stat = await getFileStat(container, filePath);
    const relativePath = filePath.replace(safeContainerPath + "/", "");
    const parts = relativePath.split("/");
    const fileName = parts[parts.length - 1] || "";

    const fileItem: FileContentItem = {
      name: fileName,
      path: filePath,
      type: stat.isDirectory ? "directory" : "file",
    };

    if (stat.isDirectory) {
      fileItem.children = [];
    } else {
      filesToRead.push(filePath);
    }

    pathToItemMap.set(filePath, fileItem);
    fileTree.set(filePath, fileItem);
  }

  const fileContents = await readFilesBatch(docker, containerId, filesToRead);

  for (const [filePath, content] of fileContents) {
    const fileItem = pathToItemMap.get(filePath);
    if (fileItem) {
      fileItem.content = content;
    }
  }

  for (const fileItem of pathToItemMap.values()) {
    const parentPath = fileItem.path.substring(
      0,
      fileItem.path.lastIndexOf("/")
    );
    const parent = fileTree.get(parentPath || safeContainerPath);
    if (parent && parent.children) {
      parent.children.push(fileItem);
    }
  }

  const root = fileTree.get(safeContainerPath);
  return root?.children || [];
}

async function readFilesBatch(
  docker: Docker,
  containerId: string,
  filePaths: string[]
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const batchSize = 50;

  for (let i = 0; i < filePaths.length; i += batchSize) {
    const batch = filePaths.slice(i, i + batchSize);
    const batchPromises = batch.map(async (filePath) => {
      try {
        const content = await readFile(docker, containerId, filePath);
        return [filePath, content] as [string, string];
      } catch (error) {
        return [
          filePath,
          `Error reading file: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        ] as [string, string];
      }
    });

    const batchResults = await Promise.all(batchPromises);
    for (const [filePath, content] of batchResults) {
      results.set(filePath, content);
    }
  }

  return results;
}

async function getFileStat(
  container: Docker.Container,
  filePath: string
): Promise<{ isDirectory: boolean }> {
  const exec = await container.exec({
    Cmd: ["stat", "-c", "%F", filePath],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Detach: false, Tty: false });
  const output = await new Promise<string>((resolve, reject) => {
    let data = "";
    stream.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });

  return {
    isDirectory: output.trim().includes("directory"),
  };
}

export async function readFile(
  docker: Docker,
  containerId: string,
  filePath: string
): Promise<string> {
  assertSafeContainerId(containerId);
  const safePath = toSafeMutablePath(filePath);
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ["head", "-c", "10000000", safePath],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Detach: false, Tty: false });

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stderr = "";

    stream.on("data", (chunk: Buffer) => {
      if (chunk.length > 8) {
        const header = chunk.slice(0, 8);
        const streamType = header[0];

        if (streamType === 1) {
          chunks.push(chunk.slice(8));
        } else if (streamType === 2) {
          stderr += chunk.slice(8).toString("utf8");
        }
      } else {
        chunks.push(chunk);
      }
    });

    stream.on("end", () => {
      if (stderr && stderr.trim() !== "exec /bin/sh: invalid argument") {
        console.error("File read stderr:", stderr);
      }

      const buffer = Buffer.concat(chunks);
      const content = buffer.toString("utf8");

      const cleanContent = content.replace(/^\uFEFF/, "");
      resolve(cleanContent);
    });

    stream.on("error", (error) => {
      console.error("Stream error:", error);
      reject(error);
    });
  });
}

export async function listFiles(
  docker: Docker,
  containerId: string,
  containerPath: string = BASE_PATH
): Promise<any[]> {
  assertSafeContainerId(containerId);
  const safeContainerPath = toSafeContainerPath(containerPath);
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: ["ls", "-la", safeContainerPath],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Detach: false, Tty: false });
  const output = await new Promise<string>((resolve, reject) => {
    let data = "";
    stream.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });

  const lines = output.trim().split("\n");
  return lines
    .slice(1)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const permissions = parts[0];
      const isDirectory = permissions!.startsWith("d");
      const name = parts.slice(8).join(" ");

      return {
        name,
        type: isDirectory ? "directory" : "file",
        permissions,
        size: parts[4],
        modified: `${parts[5]} ${parts[6]} ${parts[7]}`,
      };
    })
    .filter((item) => item.name !== "." && item.name !== "..");
}

export async function writeFile(
  containerId: string,
  filePath: string,
  content: string
): Promise<FileWriteVerification> {
  assertSafeContainerId(containerId);
  if (typeof content !== "string") {
    throw new Error("File content must be a string");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_WRITE_BYTES) {
    throw new Error("File content exceeds the 10MB write limit");
  }
  const expectedBytes = Buffer.byteLength(content, "utf8");
  const expectedHash = hashContent(content);

  console.log("container_file_write_started", {
    containerId,
    trace: "file_write_started",
    path: filePath,
    bytes: expectedBytes,
    sha256: expectedHash.slice(0, 16),
  });

  const absolutePath = toSafeMutablePath(filePath);
  const dirPath = absolutePath.substring(0, absolutePath.lastIndexOf("/"));
  const fileName = absolutePath.substring(absolutePath.lastIndexOf("/") + 1);
  const container = dockerClient.getContainer(containerId);

  try {
    await runContainerCommand(containerId, ["mkdir", "-p", dirPath], BASE_PATH);
    await container.putArchive(createTarArchive(fileName, content), {
      path: dirPath,
    });

    const writtenContent = await readFile(dockerClient, containerId, absolutePath);
    const actualBytes = Buffer.byteLength(writtenContent, "utf8");
    const actualHash = hashContent(writtenContent);

    if (actualBytes !== expectedBytes || actualHash !== expectedHash) {
      console.error("container_file_write_verification_failed", {
        containerId,
        trace: "file_write_verification_failed",
        path: filePath,
        absolutePath,
        expectedBytes,
        actualBytes,
        expectedSha256: expectedHash,
        actualSha256: actualHash,
      });
      throw new Error(
        `file_write_verification_failed: ${filePath} expected ${expectedBytes}/${expectedHash.slice(
          0,
          12
        )} but found ${actualBytes}/${actualHash.slice(0, 12)}`
      );
    }

    console.log("container_file_write_verified", {
      containerId,
      trace: "file_write_verified",
      path: filePath,
      absolutePath,
      bytes: actualBytes,
      sha256: actualHash.slice(0, 16),
    });

    return {
      path: filePath,
      absolutePath,
      bytes: actualBytes,
      sha256: actualHash,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const trace =
      /permission denied|read-only|EROFS|operation not permitted/i.test(message)
        ? "file_write_failed_due_to_permission"
        : /no space left|ENOSPC|quota/i.test(message)
          ? "file_write_failed_due_to_storage"
          : "file_write_failed";

    console.error("container_file_write_failed", {
      containerId,
      trace,
      path: filePath,
      absolutePath,
      error: message,
    });
    throw error;
  }
}

export async function renameFile(
  containerId: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  assertSafeContainerId(containerId);
  const absoluteOldPath = toSafeMutablePath(oldPath);
  const absoluteNewPath = toSafeMutablePath(newPath);

  const newDir = absoluteNewPath.substring(0, absoluteNewPath.lastIndexOf("/"));
  await runContainerCommand(containerId, ["mkdir", "-p", newDir], BASE_PATH);
  await runContainerCommand(
    containerId,
    ["mv", absoluteOldPath, absoluteNewPath],
    BASE_PATH
  );
}

export async function removeFile(
  containerId: string,
  filePath: string
): Promise<void> {
  assertSafeContainerId(containerId);
  const absolutePath = toSafeMutablePath(filePath);
  await runContainerCommand(containerId, ["rm", "-rf", absolutePath], BASE_PATH);
}
