import crypto from "crypto";
import path from "path";
import { FileType, type EntryInfo } from "e2b";
import {
  PROJECT_WORKSPACE_PATH,
  getSandbox,
  runSandboxCommand,
} from "./sandbox";

const BASE_PATH = PROJECT_WORKSPACE_PATH;
const MAX_FILE_WRITE_BYTES = 10_000_000;
const MAX_CONTENT_TREE_FILE_BYTES = Number(
  process.env.KLAWPEN_FILE_CONTENT_MAX_BYTES || "600000"
);

const FILE_TREE_EXCLUDED_NAMES = new Set(["node_modules", ".next", ".git"]);
const CONTENT_TREE_EXCLUDED_NAMES = new Set([
  ...FILE_TREE_EXCLUDED_NAMES,
  "components.json",
  "next-env.d.ts",
  "package-lock.json",
  "bun.lock",
  "favicon.ico",
]);

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

  if (normalizedPath !== BASE_PATH && !normalizedPath.startsWith(`${BASE_PATH}/`)) {
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

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function entryType(entry: EntryInfo): "file" | "directory" {
  return entry.type === FileType.DIR || String(entry.type) === "dir"
    ? "directory"
    : "file";
}

function entryPath(parentPath: string, entry: EntryInfo): string {
  if (entry.path?.startsWith("/")) return path.posix.normalize(entry.path);
  return path.posix.join(parentPath, entry.name || entry.path || "");
}

function shouldSkipPath(absolutePath: string, excludedNames: Set<string>) {
  const relativePath = path.posix.relative(BASE_PATH, absolutePath);
  return relativePath
    .split("/")
    .filter(Boolean)
    .some((part) => excludedNames.has(part));
}

async function listEntryInfos(
  containerId: string,
  containerPath: string,
  depth = 25
): Promise<EntryInfo[]> {
  const sandbox = await getSandbox(containerId);
  const safePath = toSafeContainerPath(containerPath);
  return sandbox.files.list(safePath, {
    depth,
    requestTimeoutMs: Number(process.env.E2B_FILE_LIST_TIMEOUT_MS || "60000"),
  });
}

function buildTree<T extends FileItem | FileContentItem>(
  rootPath: string,
  items: T[]
): T[] {
  const byPath = new Map<string, T & { children?: T[] }>();
  const roots: T[] = [];

  for (const item of items.sort((a, b) => a.path.localeCompare(b.path))) {
    if (item.type === "directory") {
      item.children = item.children || [];
    }
    byPath.set(item.path, item as T & { children?: T[] });
  }

  for (const item of byPath.values()) {
    const parentPath = path.posix.dirname(item.path);
    const parent = byPath.get(parentPath);

    if (parent && parent.children) {
      parent.children.push(item as T);
    } else if (parentPath === rootPath || item.path !== rootPath) {
      roots.push(item as T);
    }
  }

  return roots.filter((item) => item.path !== rootPath);
}

export async function runProjectCommand(
  containerId: string,
  command: string[]
): Promise<string> {
  assertSafeContainerId(containerId);
  return runSandboxCommand(containerId, command, { cwd: BASE_PATH });
}

export async function getFileTree(
  _docker: unknown,
  containerId: string,
  containerPath: string = BASE_PATH
): Promise<FileItem[]> {
  assertSafeContainerId(containerId);
  const safeContainerPath = toSafeContainerPath(containerPath);
  const entries = await listEntryInfos(containerId, safeContainerPath, 25);

  const items = entries
    .map<FileItem | null>((entry) => {
      const absolutePath = entryPath(safeContainerPath, entry);
      if (absolutePath === safeContainerPath) return null;
      if (shouldSkipPath(absolutePath, FILE_TREE_EXCLUDED_NAMES)) return null;

      const type = entryType(entry);
      const item: FileItem = {
        name: entry.name || path.posix.basename(absolutePath),
        path: absolutePath,
        type,
      };
      if (type === "directory") {
        item.children = [];
      }
      return item;
    })
    .filter((item): item is FileItem => Boolean(item));

  return buildTree(safeContainerPath, items);
}

export async function getFileContentTree(
  _docker: unknown,
  containerId: string,
  containerPath: string = BASE_PATH
): Promise<FileContentItem[]> {
  assertSafeContainerId(containerId);
  const safeContainerPath = toSafeContainerPath(containerPath);
  const entries = await listEntryInfos(containerId, safeContainerPath, 25);
  const sandbox = await getSandbox(containerId);

  const items: FileContentItem[] = [];

  for (const entry of entries) {
    const absolutePath = entryPath(safeContainerPath, entry);
    if (absolutePath === safeContainerPath) continue;
    if (shouldSkipPath(absolutePath, CONTENT_TREE_EXCLUDED_NAMES)) continue;
    if (absolutePath.includes("/components/ui/")) continue;

    const type = entryType(entry);
    const item: FileContentItem = {
      name: entry.name || path.posix.basename(absolutePath),
      path: absolutePath,
      type,
      ...(type === "directory" ? { children: [] } : {}),
    };

    if (type === "file") {
      if (entry.size > MAX_CONTENT_TREE_FILE_BYTES) {
        item.content = `/* File omitted from snapshot: ${entry.size} bytes exceeds the read limit. */`;
      } else {
        try {
          item.content = await sandbox.files.read(absolutePath, {
            requestTimeoutMs: Number(process.env.E2B_FILE_READ_TIMEOUT_MS || "60000"),
          });
        } catch (error) {
          item.content = `Error reading file: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
      }
    }

    items.push(item);
  }

  return buildTree(safeContainerPath, items);
}

export async function readFile(
  _docker: unknown,
  containerId: string,
  filePath: string
): Promise<string> {
  assertSafeContainerId(containerId);
  const safePath = toSafeMutablePath(filePath);
  const sandbox = await getSandbox(containerId);
  const output = await sandbox.files.read(safePath, {
    requestTimeoutMs: Number(process.env.E2B_FILE_READ_TIMEOUT_MS || "60000"),
  });

  return output.replace(/^\uFEFF/, "");
}

export async function listFiles(
  _docker: unknown,
  containerId: string,
  containerPath: string = BASE_PATH
): Promise<any[]> {
  assertSafeContainerId(containerId);
  const safeContainerPath = toSafeContainerPath(containerPath);
  const entries = await listEntryInfos(containerId, safeContainerPath, 1);

  return entries
    .filter((entry) => entryPath(safeContainerPath, entry) !== safeContainerPath)
    .filter((entry) => !shouldSkipPath(entryPath(safeContainerPath, entry), FILE_TREE_EXCLUDED_NAMES))
    .map((entry) => ({
      name: entry.name || path.posix.basename(entry.path),
      type: entryType(entry),
      permissions: entry.permissions,
      size: String(entry.size),
      modified: entry.modifiedTime?.toISOString?.() || "",
    }));
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
  const absolutePath = toSafeMutablePath(filePath);
  const sandbox = await getSandbox(containerId);

  console.log("sandbox_file_write_started", {
    containerId,
    trace: "e2b_file_write_started",
    path: filePath,
    absolutePath,
    bytes: expectedBytes,
    sha256: expectedHash.slice(0, 16),
  });

  try {
    await sandbox.files.write(absolutePath, content, {
      requestTimeoutMs: Number(process.env.E2B_FILE_WRITE_TIMEOUT_MS || "60000"),
    });

    const writtenContent = await sandbox.files.read(absolutePath, {
      requestTimeoutMs: Number(process.env.E2B_FILE_READ_TIMEOUT_MS || "60000"),
    });
    const actualBytes = Buffer.byteLength(writtenContent, "utf8");
    const actualHash = hashContent(writtenContent);

    if (actualBytes !== expectedBytes || actualHash !== expectedHash) {
      const lineEndingEquivalent =
        normalizeLineEndings(writtenContent) === normalizeLineEndings(content);

      if (!lineEndingEquivalent) {
        console.error("sandbox_file_write_verification_failed", {
          containerId,
          trace: "e2b_file_write_verification_failed",
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
    }

    console.log("sandbox_file_write_verified", {
      containerId,
      trace: "e2b_file_write_verified",
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
    const trace = /permission denied|read-only|EROFS|operation not permitted/i.test(message)
      ? "staged_ai_failed_due_to_permission"
      : /no space left|ENOSPC|quota/i.test(message)
        ? "staged_ai_failed_due_to_storage"
        : "e2b_file_write_failed";

    console.error("sandbox_file_write_failed", {
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
  const sandbox = await getSandbox(containerId);
  await sandbox.files.rename(absoluteOldPath, absoluteNewPath, {
    requestTimeoutMs: Number(process.env.E2B_FILE_WRITE_TIMEOUT_MS || "60000"),
  });
}

export async function removeFile(
  containerId: string,
  filePath: string
): Promise<void> {
  assertSafeContainerId(containerId);
  const absolutePath = toSafeMutablePath(filePath);
  const sandbox = await getSandbox(containerId);
  await sandbox.files.remove(absolutePath, {
    requestTimeoutMs: Number(process.env.E2B_FILE_WRITE_TIMEOUT_MS || "60000"),
  });
}
