import { getBackendAuthHeaders } from "@/lib/backend/auth";

interface FileTreeItem {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeItem[];
}

interface ZipEntry {
  path: string;
  data: Uint8Array;
  isDirectory: boolean;
  modifiedAt: Date;
}

const PROJECT_ROOT = "/app/my-nextjs-app/";
const ZIP_UTF8_FLAG = 0x0800;

const textEncoder = new TextEncoder();
const crcTable = new Uint32Array(256);

for (let tableIndex = 0; tableIndex < 256; tableIndex += 1) {
  let value = tableIndex;

  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  crcTable[tableIndex] = value >>> 0;
}

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;

  for (const byte of bytes) {
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

const createBuffer = (size: number) => {
  const buffer = new ArrayBuffer(size);
  return {
    bytes: new Uint8Array(buffer),
    view: new DataView(buffer),
  };
};

const normalizeExportPath = (filePath: string) => {
  const normalizedPath = filePath.replace(/\\/g, "/");

  return normalizedPath.startsWith(PROJECT_ROOT)
    ? normalizedPath.slice(PROJECT_ROOT.length)
    : normalizedPath.replace(/^\/+/, "");
};

const concatBytes = (parts: Uint8Array[]) => {
  const totalLength = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
};

const flattenFileTree = (items: FileTreeItem[]): FileTreeItem[] =>
  items.flatMap((item) => [
    item,
    ...(item.children ? flattenFileTree(item.children) : []),
  ]);

const createZipBlob = (entries: ZipEntry[]) => {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const fileName = textEncoder.encode(entry.path);
    const fileCrc = crc32(entry.data);
    const { dosDate, dosTime } = toDosDateTime(entry.modifiedAt);
    const localHeader = createBuffer(30 + fileName.length);

    localHeader.view.setUint32(0, 0x04034b50, true);
    localHeader.view.setUint16(4, 20, true);
    localHeader.view.setUint16(6, ZIP_UTF8_FLAG, true);
    localHeader.view.setUint16(8, 0, true);
    localHeader.view.setUint16(10, dosTime, true);
    localHeader.view.setUint16(12, dosDate, true);
    localHeader.view.setUint32(14, fileCrc, true);
    localHeader.view.setUint32(18, entry.data.length, true);
    localHeader.view.setUint32(22, entry.data.length, true);
    localHeader.view.setUint16(26, fileName.length, true);
    localHeader.view.setUint16(28, 0, true);
    localHeader.bytes.set(fileName, 30);

    localParts.push(localHeader.bytes, entry.data);

    const centralHeader = createBuffer(46 + fileName.length);
    centralHeader.view.setUint32(0, 0x02014b50, true);
    centralHeader.view.setUint16(4, 20, true);
    centralHeader.view.setUint16(6, 20, true);
    centralHeader.view.setUint16(8, ZIP_UTF8_FLAG, true);
    centralHeader.view.setUint16(10, 0, true);
    centralHeader.view.setUint16(12, dosTime, true);
    centralHeader.view.setUint16(14, dosDate, true);
    centralHeader.view.setUint32(16, fileCrc, true);
    centralHeader.view.setUint32(20, entry.data.length, true);
    centralHeader.view.setUint32(24, entry.data.length, true);
    centralHeader.view.setUint16(28, fileName.length, true);
    centralHeader.view.setUint16(30, 0, true);
    centralHeader.view.setUint16(32, 0, true);
    centralHeader.view.setUint16(34, 0, true);
    centralHeader.view.setUint16(36, 0, true);
    centralHeader.view.setUint32(38, entry.isDirectory ? 0x10 : 0, true);
    centralHeader.view.setUint32(42, offset, true);
    centralHeader.bytes.set(fileName, 46);

    centralParts.push(centralHeader.bytes);
    offset += localHeader.bytes.length + entry.data.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce(
    (total, part) => total + part.length,
    0
  );
  const endOfCentralDirectory = createBuffer(22);

  endOfCentralDirectory.view.setUint32(0, 0x06054b50, true);
  endOfCentralDirectory.view.setUint16(4, 0, true);
  endOfCentralDirectory.view.setUint16(6, 0, true);
  endOfCentralDirectory.view.setUint16(8, entries.length, true);
  endOfCentralDirectory.view.setUint16(10, entries.length, true);
  endOfCentralDirectory.view.setUint32(12, centralDirectorySize, true);
  endOfCentralDirectory.view.setUint32(16, centralDirectoryOffset, true);
  endOfCentralDirectory.view.setUint16(20, 0, true);

  return new Blob(
    [concatBytes([...localParts, ...centralParts, endOfCentralDirectory.bytes])],
    { type: "application/zip" }
  );
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, {
    headers: await getBackendAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
};

export const buildProjectZipFromFileApi = async (
  apiBaseUrl: string,
  containerId: string
) => {
  const treeResponse = await fetchJson<{
    success: boolean;
    fileTree: FileTreeItem[];
  }>(`${apiBaseUrl}/containers/${containerId}/file-tree`);

  if (!treeResponse.success) {
    throw new Error("File tree export failed");
  }

  const now = new Date();
  const flattenedItems = flattenFileTree(treeResponse.fileTree);
  const entries: ZipEntry[] = flattenedItems
    .filter((item) => item.type === "directory")
    .map((item) => ({
      path: `${normalizeExportPath(item.path)}/`,
      data: new Uint8Array(0),
      isDirectory: true,
      modifiedAt: now,
    }));

  const fileItems = flattenedItems.filter((item) => item.type === "file");

  for (const fileItem of fileItems) {
    const fileResponse = await fetchJson<{
      success: boolean;
      content: string;
    }>(
      `${apiBaseUrl}/containers/${containerId}/file?path=${encodeURIComponent(
        fileItem.path
      )}`
    );

    if (!fileResponse.success) {
      throw new Error(`Could not export ${fileItem.path}`);
    }

    entries.push({
      path: normalizeExportPath(fileItem.path),
      data: textEncoder.encode(fileResponse.content),
      isDirectory: false,
      modifiedAt: now,
    });
  }

  if (entries.length === 0) {
    throw new Error("Project export is empty");
  }

  return createZipBlob(entries);
};
