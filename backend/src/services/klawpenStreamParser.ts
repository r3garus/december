export type KlawpenActionKind = "file" | "shell";

export interface KlawpenActionOperation {
  type: "write" | "shell";
  index: number;
  path?: string;
  content?: string;
  command?: string;
  artifactId?: string;
  artifactTitle?: string;
}

export interface KlawpenParserDiagnostics {
  openArtifactTags: number;
  closeArtifactTags: number;
  unbalancedArtifactTags: number;
  openActionTags: number;
  closeActionTags: number;
  unbalancedActionTags: number;
  openFileActionTags: number;
  closeFileActionTags: number;
  unbalancedFileActionTags: number;
}

const ARTIFACT_OPEN_PATTERN = /<klawpenArtifact\b([^>]*)>/gi;
const ARTIFACT_CLOSE_PATTERN = /<\/klawpenArtifact>/gi;
const ACTION_OPEN_PATTERN = /<klawpenAction\b([^>]*)>/gi;
const ACTION_CLOSE_PATTERN = /<\/klawpenAction>/gi;
const ACTION_PATTERN = /<klawpenAction\b([^>]*)>([\s\S]*?)<\/klawpenAction>/gi;
const PARTIAL_ACTION_OPEN_PATTERN = /<klawpenAction\b([^>]*)>/gi;
const NEXT_KLAWPEN_TAG_PATTERN = /<klawpenAction\b|<\/klawpenArtifact>/gi;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`${name}=(['"])([\\s\\S]*?)\\1`, "i");
  const match = tag.match(pattern);
  return match?.[2] ? decodeXmlEntities(match[2]) : null;
}

function normalizeActionContent(content: string): string {
  return decodeXmlEntities(content)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n[ \t]*$/, "");
}

function countMatches(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length;
}

function getArtifactMetadataBefore(text: string, index: number) {
  let artifactId: string | undefined;
  let artifactTitle: string | undefined;
  const before = text.slice(0, index);
  let match: RegExpExecArray | null;
  ARTIFACT_OPEN_PATTERN.lastIndex = 0;

  while ((match = ARTIFACT_OPEN_PATTERN.exec(before)) !== null) {
    artifactId = extractAttribute(match[1] || "", "id") || artifactId;
    artifactTitle = extractAttribute(match[1] || "", "title") || artifactTitle;
  }

  return { artifactId, artifactTitle };
}

function toOperation(
  attributeText: string,
  content: string,
  index: number,
  metadata: { artifactId?: string; artifactTitle?: string }
): KlawpenActionOperation | null {
  const actionType = extractAttribute(attributeText, "type")?.toLowerCase();
  const normalizedContent = normalizeActionContent(content);

  if (actionType === "file") {
    const path =
      extractAttribute(attributeText, "filePath") ||
      extractAttribute(attributeText, "filepath") ||
      extractAttribute(attributeText, "path") ||
      extractAttribute(attributeText, "file_path");

    if (!path || normalizedContent.length === 0) return null;

    return {
      type: "write",
      index,
      path,
      content: normalizedContent,
      ...metadata,
    };
  }

  if (actionType === "shell") {
    const command = normalizedContent.trim();
    if (!command) return null;

    return {
      type: "shell",
      index,
      command,
      content: command,
      ...metadata,
    };
  }

  return null;
}

export function getKlawpenParserDiagnostics(text: string): KlawpenParserDiagnostics {
  const openArtifactTags = countMatches(text, /<klawpenArtifact\b/gi);
  const closeArtifactTags = countMatches(text, /<\/klawpenArtifact>/gi);
  const openActionTags = countMatches(text, /<klawpenAction\b/gi);
  const closeActionTags = countMatches(text, /<\/klawpenAction>/gi);
  const openFileActionTags = countMatches(
    text,
    /<klawpenAction\b(?=[^>]*\btype=(['"])file\1)/gi
  );
  const closeFileActionTags = Math.min(openFileActionTags, closeActionTags);

  return {
    openArtifactTags,
    closeArtifactTags,
    unbalancedArtifactTags: Math.max(0, openArtifactTags - closeArtifactTags),
    openActionTags,
    closeActionTags,
    unbalancedActionTags: Math.max(0, openActionTags - closeActionTags),
    openFileActionTags,
    closeFileActionTags,
    unbalancedFileActionTags: Math.max(0, openFileActionTags - closeFileActionTags),
  };
}

export function extractKlawpenActionOperations(text: string): KlawpenActionOperation[] {
  const operations: KlawpenActionOperation[] = [];
  let match: RegExpExecArray | null;
  ACTION_PATTERN.lastIndex = 0;

  while ((match = ACTION_PATTERN.exec(text)) !== null) {
    const metadata = getArtifactMetadataBefore(text, match.index);
    const operation = toOperation(match[1] || "", match[2] || "", match.index, metadata);
    if (operation) operations.push(operation);
  }

  return operations.sort((left, right) => left.index - right.index);
}

export function extractPartialKlawpenActionOperations(text: string): KlawpenActionOperation[] {
  const operations: KlawpenActionOperation[] = [];
  let match: RegExpExecArray | null;
  PARTIAL_ACTION_OPEN_PATTERN.lastIndex = 0;

  while ((match = PARTIAL_ACTION_OPEN_PATTERN.exec(text)) !== null) {
    const tag = match[0] || "";
    const attributeText = match[1] || "";
    const contentStart = match.index + tag.length;
    const closeIndex = text.indexOf("</klawpenAction>", contentStart);
    if (closeIndex !== -1) continue;

    NEXT_KLAWPEN_TAG_PATTERN.lastIndex = contentStart;
    const nextTag = NEXT_KLAWPEN_TAG_PATTERN.exec(text);
    const contentEnd = nextTag?.index ?? text.length;
    const content = text.slice(contentStart, contentEnd);
    const metadata = getArtifactMetadataBefore(text, match.index);
    const operation = toOperation(attributeText, content, match.index, metadata);

    if (!operation) continue;
    if (operation.type === "write" && (operation.content || "").length < 40) continue;
    operations.push(operation);
  }

  return operations.sort((left, right) => left.index - right.index);
}

export class KlawpenActionStreamParser {
  private buffer = "";

  push(chunk: string): KlawpenActionOperation[] {
    this.buffer += chunk;
    const completed: KlawpenActionOperation[] = [];

    while (true) {
      const openMatch = /<klawpenAction\b([^>]*)>/i.exec(this.buffer);
      if (!openMatch || openMatch.index === undefined) {
        this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - 512));
        return completed;
      }

      const openIndex = openMatch.index;
      const contentStart = openIndex + openMatch[0].length;
      const closeIndex = this.buffer.indexOf("</klawpenAction>", contentStart);
      if (closeIndex === -1) {
        if (openIndex > 0) this.buffer = this.buffer.slice(openIndex);
        return completed;
      }

      const blockEnd = closeIndex + "</klawpenAction>".length;
      const content = this.buffer.slice(contentStart, closeIndex);
      const operation = toOperation(openMatch[1] || "", content, openIndex, {});
      if (operation) completed.push(operation);
      this.buffer = this.buffer.slice(blockEnd);
    }
  }

  flushPartial(): KlawpenActionOperation[] {
    const partial = extractPartialKlawpenActionOperations(this.buffer);
    this.buffer = "";
    return partial;
  }

  getBuffer(): string {
    return this.buffer;
  }
}
