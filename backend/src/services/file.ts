import Docker from "dockerode";
import crypto from "crypto";
import path from "path";
import { Writable } from "stream";
import { ensureProjectContainerRunning } from "./docker";
import { docker as dockerClient } from "./dockerClient";

const BASE_PATH = "/app/my-nextjs-app";
const MAX_FILE_WRITE_BYTES = 10_000_000;

type FindEntry = {
  type: "file" | "directory";
  path: string;
};

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

function splitTarPath(entryName: string): { name: string; prefix: string } {
  if (entryName.length <= 100) {
    return { name: entryName, prefix: "" };
  }

  const splitIndex = entryName.lastIndexOf("/");
  if (splitIndex <= 0) {
    throw new Error("Generated file path is too long for archive copy");
  }

  const prefix = entryName.slice(0, splitIndex);
  const name = entryName.slice(splitIndex + 1);
  if (!name || name.length > 100 || prefix.length > 155) {
    throw new Error("Generated file path is too long for archive copy");
  }

  return { name, prefix };
}

function createTarHeader(
  entryName: string,
  size: number,
  typeFlag: "0" | "5",
  mode: number
): Buffer {
  const normalizedEntryName =
    typeFlag === "5" ? entryName.replace(/\/+$/g, "") : entryName;
  if (
    !normalizedEntryName ||
    normalizedEntryName.includes("\0") ||
    normalizedEntryName.startsWith("/") ||
    normalizedEntryName.split("/").some((part) => part === "..")
  ) {
    throw new Error("Invalid archive entry path");
  }

  const { name, prefix } = splitTarPath(normalizedEntryName);
  const header = Buffer.alloc(512, 0);

  header.write(name, 0, 100, "utf8");
  writeOctalHeader(header, mode, 100, 8);
  writeOctalHeader(header, 0, 108, 8);
  writeOctalHeader(header, 0, 116, 8);
  writeOctalHeader(header, size, 124, 12);
  writeOctalHeader(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(" ", 148, 156);
  header.write(typeFlag, 156, 1, "ascii");
  header.write("ustar", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

function createTarArchiveForProjectFile(
  absolutePath: string,
  content: string
): Buffer {
  const relativePath = path.posix.relative(BASE_PATH, absolutePath);
  if (
    !relativePath ||
    relativePath.startsWith("../") ||
    relativePath === ".." ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new Error("File path must stay inside the project workspace");
  }

  const contentBuffer = Buffer.from(content, "utf8");
  const entries: Buffer[] = [];
  const parts = relativePath.split("/");
  const directoryParts = parts.slice(0, -1);
  let currentDir = "";

  for (const part of directoryParts) {
    currentDir = currentDir ? `${currentDir}/${part}` : part;
    entries.push(createTarHeader(`${currentDir}/`, 0, "5", 0o755));
  }

  entries.push(createTarHeader(relativePath, contentBuffer.length, "0", 0o644));
  entries.push(contentBuffer);

  const paddingSize = (512 - (contentBuffer.length % 512)) % 512;
  if (paddingSize > 0) {
    entries.push(Buffer.alloc(paddingSize, 0));
  }

  entries.push(Buffer.alloc(1024, 0));

  return Buffer.concat(entries);
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  return Buffer.concat(chunks);
}

function parseTarString(buffer: Buffer, start: number, length: number): string {
  return buffer
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/s, "")
    .trim();
}

function extractFirstRegularFileFromTar(archive: Buffer): Buffer {
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const isEmptyBlock = header.every((byte) => byte === 0);
    if (isEmptyBlock) break;

    const rawSize = parseTarString(header, 124, 12);
    const size = Number.parseInt(rawSize || "0", 8);
    const typeFlag = header.toString("ascii", 156, 157) || "0";
    const contentStart = offset + 512;
    const contentEnd = contentStart + (Number.isFinite(size) ? size : 0);

    if ((typeFlag === "0" || typeFlag === "\0" || typeFlag === "") && size >= 0) {
      return archive.subarray(contentStart, contentEnd);
    }

    const paddedSize = Math.ceil(size / 512) * 512;
    offset = contentStart + paddedSize;
  }

  throw new Error("file_archive_extract_failed");
}

async function runContainerCommand(
  containerId: string,
  command: string[],
  workingDir: string = BASE_PATH
): Promise<string> {
  assertSafeContainerId(containerId);

  const container = await ensureProjectContainerRunning(containerId);
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

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

async function getContainerFileDigest(
  containerId: string,
  absolutePath: string
): Promise<{ bytes: number; sha256: string }> {
  const fileBuffer = await readContainerFileBuffer(containerId, absolutePath);
  const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error(`file_digest_failed: ${absolutePath}`);
  }

  return { bytes: fileBuffer.length, sha256: sha256.toLowerCase() };
}

async function readContainerFileBuffer(
  containerId: string,
  absolutePath: string
): Promise<Buffer> {
  assertSafeContainerId(containerId);
  const safePath = toSafeMutablePath(absolutePath);
  const container = await ensureProjectContainerRunning(containerId);
  const archiveStream = await container.getArchive({ path: safePath });
  const archiveBuffer = await streamToBuffer(archiveStream);

  return extractFirstRegularFileFromTar(archiveBuffer);
}

export async function getFileTree(
  docker: Docker,
  containerId: string,
  containerPath: string = BASE_PATH
): Promise<FileItem[]> {
  assertSafeContainerId(containerId);
  const safeContainerPath = toSafeContainerPath(containerPath);
  const container = await ensureProjectContainerRunning(containerId);
  const quotedPath = shellQuote(safeContainerPath);

  const findCommand = [
    "sh",
    "-c",
    `({ find ${quotedPath} \\( -name node_modules -o -name .next \\) -prune -o -type f -print | awk '{ print "f\\t" $0 }'; find ${quotedPath} \\( -name node_modules -o -name .next \\) -prune -o -type d -print | awk '{ print "d\\t" $0 }'; }) | sort -k2`,
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

  const entries = output
    .trim()
    .split("\n")
    .map(parseFindEntry)
    .filter((entry): entry is FindEntry => Boolean(entry))
    .filter((entry) => entry.path !== safeContainerPath);
  const fileTree: Map<string, FileItem> = new Map();

  fileTree.set(safeContainerPath, {
    name: "root",
    path: safeContainerPath,
    type: "directory",
    children: [],
  });

  for (const entry of entries) {
    const filePath = entry.path;
    const relativePath = filePath.replace(safeContainerPath + "/", "");
    const parts = relativePath.split("/");
    const fileName = parts[parts.length - 1] || "";

    const fileItem: FileItem = {
      name: fileName,
      path: filePath,
      type: entry.type,
    };

    if (entry.type === "directory") {
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
  const container = await ensureProjectContainerRunning(containerId);
  const quotedPath = shellQuote(safeContainerPath);

  const findCommand = [
    "sh",
    "-c",
    `({ find ${quotedPath} \\( -name node_modules -o -name .next -o -path "*/components/ui" \\) -prune -o -type f -print | awk '{ print "f\\t" $0 }'; find ${quotedPath} \\( -name node_modules -o -name .next -o -path "*/components/ui" \\) -prune -o -type d -print | awk '{ print "d\\t" $0 }'; }) | grep -v -E "(node_modules|\\.next|components/ui|bun\\.lock|components\\.json|next-env\\.d\\.ts|package-lock\\.json|postcss\\.config\\.mjs|favicon\\.ico|\\.gitignore)" | sort -k2`,
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

  const entries = output
    .trim()
    .split("\n")
    .map(parseFindEntry)
    .filter((entry): entry is FindEntry => Boolean(entry))
    .filter((entry) => entry.path !== safeContainerPath);

  const fileTree: Map<string, FileContentItem> = new Map();

  fileTree.set(safeContainerPath, {
    name: "root",
    path: safeContainerPath,
    type: "directory",
    children: [],
  });

  const filesToRead: string[] = [];
  const pathToItemMap: Map<string, FileContentItem> = new Map();

  for (const entry of entries) {
    const filePath = entry.path;
    const relativePath = filePath.replace(safeContainerPath + "/", "");
    const parts = relativePath.split("/");
    const fileName = parts[parts.length - 1] || "";

    const fileItem: FileContentItem = {
      name: fileName,
      path: filePath,
      type: entry.type,
    };

    if (entry.type === "directory") {
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

function parseFindEntry(line: string): FindEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const separatorIndex = trimmed.indexOf("\t");
  if (separatorIndex <= 0) return null;

  const kind = trimmed.slice(0, separatorIndex);
  const filePath = trimmed.slice(separatorIndex + 1);
  if (!filePath) return null;

  return {
    type: kind === "d" ? "directory" : "file",
    path: filePath,
  };
}

export async function readFile(
  docker: Docker,
  containerId: string,
  filePath: string
): Promise<string> {
  assertSafeContainerId(containerId);
  const safePath = toSafeMutablePath(filePath);
  const output = await readContainerFileBuffer(containerId, safePath);

  return output.toString("utf8").replace(/^\uFEFF/, "");
}

export async function listFiles(
  docker: Docker,
  containerId: string,
  containerPath: string = BASE_PATH
): Promise<any[]> {
  assertSafeContainerId(containerId);
  const safeContainerPath = toSafeContainerPath(containerPath);
  const container = await ensureProjectContainerRunning(containerId);
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
  const container = await ensureProjectContainerRunning(containerId);

  try {
    await container.putArchive(createTarArchiveForProjectFile(absolutePath, content), {
      path: BASE_PATH,
    });

    const { bytes: actualBytes, sha256: actualHash } =
      await getContainerFileDigest(containerId, absolutePath);

    if (actualBytes !== expectedBytes || actualHash !== expectedHash) {
      const writtenContent = await readFile(dockerClient, containerId, absolutePath);
      const lineEndingEquivalent =
        normalizeLineEndings(writtenContent) === normalizeLineEndings(content);

      if (lineEndingEquivalent) {
        console.warn("container_file_write_verified_line_endings_normalized", {
          containerId,
          trace: "file_write_verified_line_endings_normalized",
          path: filePath,
          absolutePath,
          expectedBytes,
          actualBytes,
          expectedSha256: expectedHash.slice(0, 16),
          actualSha256: actualHash.slice(0, 16),
        });

        return {
          path: filePath,
          absolutePath,
          bytes: actualBytes,
          sha256: actualHash,
        };
      }

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
