import { execFile } from "child_process";
import Docker from "dockerode";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";

const execFileAsync = promisify(execFile);
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
): Promise<void> {
  assertSafeContainerId(containerId);
  if (typeof content !== "string") {
    throw new Error("File content must be a string");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_WRITE_BYTES) {
    throw new Error("File content exceeds the 10MB write limit");
  }
  console.log(`Writing file: ${filePath} (${content.length} characters)`);

  const tempFile = `/tmp/file-${uuidv4()}`;

  try {
    await fs.writeFile(tempFile, content, "utf8");
    console.log(`Temporary file created: ${tempFile}`);

    const absolutePath = toSafeMutablePath(filePath);
    console.log(`Target path: ${absolutePath}`);

    try {
      const { stdout, stderr } = await execFileAsync("docker", [
        "cp",
        tempFile,
        `${containerId}:${absolutePath}`,
      ]);

      if (stderr) {
        console.log(`Copy stderr: ${stderr}`);
      }
      if (stdout) {
        console.log(`Copy stdout: ${stdout}`);
      }

      console.log("File copied successfully");
    } catch (copyError) {
      console.log("Copy failed, trying to create directory first:", copyError);

      const dirPath = absolutePath.substring(0, absolutePath.lastIndexOf("/"));

      await execFileAsync("docker", ["exec", containerId, "mkdir", "-p", dirPath]);
      console.log("Directory created");

      const { stdout, stderr } = await execFileAsync("docker", [
        "cp",
        tempFile,
        `${containerId}:${absolutePath}`,
      ]);
      if (stderr) {
        console.log(`Retry stderr: ${stderr}`);
      }
      if (stdout) {
        console.log(`Retry stdout: ${stdout}`);
      }

      console.log("File copied successfully on retry");
    }

    try {
      const { stdout: verifyOutput } = await execFileAsync("docker", [
        "exec",
        containerId,
        "head",
        "-n",
        "5",
        absolutePath,
      ]);
      console.log(`File verification (first 5 lines):\n${verifyOutput}`);
    } catch (verifyError) {
      console.log("Could not verify file content:", verifyError);
    }

    await fs.unlink(tempFile);
    console.log("Temporary file cleaned up");
  } catch (error) {
    console.error("Write file error:", error);
    try {
      await fs.unlink(tempFile);
    } catch (unlinkError) {
      console.error("Failed to clean up temp file:", unlinkError);
    }
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
  await execFileAsync("docker", ["exec", containerId, "mkdir", "-p", newDir]);

  await execFileAsync("docker", [
    "exec",
    containerId,
    "mv",
    absoluteOldPath,
    absoluteNewPath,
  ]);
}

export async function removeFile(
  containerId: string,
  filePath: string
): Promise<void> {
  assertSafeContainerId(containerId);
  const absolutePath = toSafeMutablePath(filePath);
  await execFileAsync("docker", ["exec", containerId, "rm", "-rf", absolutePath]);
}
