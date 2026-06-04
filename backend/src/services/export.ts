import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const PROJECT_PATH = "/app/my-nextjs-app";
const ZIP_UTF8_FLAG = 0x0800;

const EXCLUDED_EXPORT_NAMES = new Set([
  ".DS_Store",
  ".git",
  ".next",
  "node_modules",
]);

interface ZipEntry {
  absolutePath: string;
  zipPath: string;
  isDirectory: boolean;
  modifiedAt: Date;
}

const crcTable = new Uint32Array(256);

for (let tableIndex = 0; tableIndex < 256; tableIndex += 1) {
  let value = tableIndex;

  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  crcTable[tableIndex] = value >>> 0;
}

const crc32 = (buffer: Buffer) => {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
};

const toDosDateTime = (date: Date) => {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate =
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  return { dosDate, dosTime };
};

const writeUInt32 = (buffer: Buffer, value: number, offset: number) => {
  buffer.writeUInt32LE(value >>> 0, offset);
};

const normalizeZipPath = (value: string) =>
  value.split(path.sep).join("/").replace(/^\/+/, "");

const shouldSkipExportEntry = (name: string) =>
  EXCLUDED_EXPORT_NAMES.has(name) || name.endsWith(".tmp");

const assertSafeContainerId = (containerId: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerId)) {
    throw new Error("Invalid container id");
  }
};

const removeTempPath = async (targetPath: string, tempRoot: string) => {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(tempRoot);

  if (!resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Refusing to remove path outside temp root: ${targetPath}`);
  }

  await fs.rm(resolvedTarget, { recursive: true, force: true });
};

const collectZipEntries = async (
  rootDir: string,
  currentDir = rootDir
): Promise<ZipEntry[]> => {
  const entries: ZipEntry[] = [];
  const dirEntries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const dirEntry of dirEntries) {
    if (shouldSkipExportEntry(dirEntry.name)) continue;

    const absolutePath = path.join(currentDir, dirEntry.name);
    const relativePath = normalizeZipPath(path.relative(rootDir, absolutePath));

    if (!relativePath) continue;

    if (dirEntry.isDirectory()) {
      const stat = await fs.stat(absolutePath);

      entries.push({
        absolutePath,
        zipPath: `${relativePath}/`,
        isDirectory: true,
        modifiedAt: stat.mtime,
      });
      entries.push(...(await collectZipEntries(rootDir, absolutePath)));
      continue;
    }

    if (!dirEntry.isFile()) continue;

    const stat = await fs.stat(absolutePath);
    entries.push({
      absolutePath,
      zipPath: relativePath,
      isDirectory: false,
      modifiedAt: stat.mtime,
    });
  }

  return entries;
};

const createStoredZip = async (entries: ZipEntry[]) => {
  const localFileParts: Buffer[] = [];
  const centralDirectoryParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const fileData = entry.isDirectory
      ? Buffer.alloc(0)
      : await fs.readFile(entry.absolutePath);
    const fileName = Buffer.from(entry.zipPath, "utf8");
    const fileCrc = crc32(fileData);
    const { dosDate, dosTime } = toDosDateTime(entry.modifiedAt);

    const localHeader = Buffer.alloc(30 + fileName.length);
    writeUInt32(localHeader, 0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    writeUInt32(localHeader, fileCrc, 14);
    writeUInt32(localHeader, fileData.length, 18);
    writeUInt32(localHeader, fileData.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    localHeader.writeUInt16LE(0, 28);
    fileName.copy(localHeader, 30);

    localFileParts.push(localHeader, fileData);

    const centralHeader = Buffer.alloc(46 + fileName.length);
    writeUInt32(centralHeader, 0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    writeUInt32(centralHeader, fileCrc, 16);
    writeUInt32(centralHeader, fileData.length, 20);
    writeUInt32(centralHeader, fileData.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    writeUInt32(centralHeader, entry.isDirectory ? 0x10 : 0, 38);
    writeUInt32(centralHeader, offset, 42);
    fileName.copy(centralHeader, 46);

    centralDirectoryParts.push(centralHeader);
    offset += localHeader.length + fileData.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralDirectoryParts.reduce(
    (total, part) => total + part.length,
    0
  );
  const endOfCentralDirectory = Buffer.alloc(22);

  writeUInt32(endOfCentralDirectory, 0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  writeUInt32(endOfCentralDirectory, centralDirectorySize, 12);
  writeUInt32(endOfCentralDirectory, centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([
    ...localFileParts,
    ...centralDirectoryParts,
    endOfCentralDirectory,
  ]);
};

export async function exportContainerCode(
  containerId: string
): Promise<Buffer> {
  assertSafeContainerId(containerId);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshfire-export-"));
  const projectDir = path.join(tempRoot, "project");

  try {
    await fs.mkdir(projectDir, { recursive: true });

    await execFileAsync("docker", [
      "cp",
      `${containerId}:${PROJECT_PATH}/.`,
      projectDir,
    ]);

    const entries = await collectZipEntries(projectDir);

    if (entries.length === 0) {
      throw new Error("Project export is empty");
    }

    return await createStoredZip(entries);
  } catch (error) {
    throw new Error(
      `Export failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  } finally {
    try {
      await removeTempPath(tempRoot, os.tmpdir());
    } catch {
      // Export cleanup is best effort; download errors should keep the original cause.
    }
  }
}
