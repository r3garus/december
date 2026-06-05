import {
  AlertTriangle,
  BookOpen,
  Brain,
  CheckCircle,
  Clock3,
  Code,
  Edit3,
  FileText,
  GitBranch,
  Image,
  Info,
  Navigation,
  Package,
  Terminal,
  Trash2,
} from "lucide-react";
import { API_BASE_URL } from "@/lib/backend/api";
import { getBackendAuthHeaders } from "@/lib/backend/auth";
import React, { useEffect, useState } from "react";

interface Attachment {
  type: "image" | "document";
  data: string;
  name: string;
  mimeType: string;
  size: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  attachments?: Attachment[];
}

interface ChatMessageProps {
  message: Message;
  formatMessageContent: (content: string) => React.ReactNode[];
  containerId?: string;
  isStreaming?: boolean;
  isDark?: boolean;
  workStartedAt?: string;
  labels?: Partial<Record<string, string>>;
}

interface ChangeSummaryFile {
  path: string;
  name?: string;
  directory?: string;
  operation?: "created" | "updated" | "deleted" | "renamed" | string;
  additions?: number;
  deletions?: number;
  fromPath?: string;
}

interface ChangeSummaryPayload {
  files?: ChangeSummaryFile[];
  folders?: Array<{ path: string; count?: number }>;
  dependencies?: string[];
  totals?: {
    files?: number;
    folders?: number;
    additions?: number;
    deletions?: number;
    dependencies?: number;
  };
}

const operationTagTypes = new Set(["write", "rename", "delete", "dependency"]);

const normalizeDisplayPath = (path: string) =>
  path
    .replace(/\\/g, "/")
    .replace(/^\/app\/my-nextjs-app\/?/, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");

const getFileName = (path: string) => {
  const normalized = normalizeDisplayPath(path);
  return normalized.split("/").filter(Boolean).pop() || normalized || path;
};

const getDirectoryName = (path: string) => {
  const normalized = normalizeDisplayPath(path);
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") || "root";
};

const splitCodeLines = (content: string) => {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmedTrailingNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  return trimmedTrailingNewline ? trimmedTrailingNewline.split("\n") : [];
};

const buildFallbackChangeSummary = (content: string): ChangeSummaryPayload | null => {
  const files: ChangeSummaryFile[] = [];
  const dependencies: string[] = [];
  const folders = new Map<string, number>();
  const addFolder = (path: string) => {
    const directory = getDirectoryName(path);
    folders.set(directory, (folders.get(directory) || 0) + 1);
    return directory;
  };

  const writePattern = /<dec-write\s+(?:path|file_path)="([^"]+)">([\s\S]*?)<\/dec-write>/g;
  const renamePattern = /<dec-rename\s+from="([^"]+)"\s+to="([^"]+)"\s*\/>/g;
  const deletePattern = /<dec-delete\s+(?:path|file_path)="([^"]+)"\s*\/>/g;
  const dependencyPattern =
    /<dec-add-dependency(?:\s+name="([^"]+)"(?:\s+version="([^"]+)")?)?>(.*?)<\/dec-add-dependency>/g;

  let match: RegExpExecArray | null;

  while ((match = writePattern.exec(content)) !== null) {
    const path = normalizeDisplayPath(match[1]);
    files.push({
      path,
      name: getFileName(path),
      directory: addFolder(path),
      operation: "updated",
      additions: splitCodeLines(match[2].trim()).length,
      deletions: 0,
    });
  }

  while ((match = renamePattern.exec(content)) !== null) {
    const path = normalizeDisplayPath(match[2]);
    files.push({
      path,
      name: getFileName(path),
      directory: addFolder(path),
      operation: "renamed",
      fromPath: normalizeDisplayPath(match[1]),
      additions: 0,
      deletions: 0,
    });
  }

  while ((match = deletePattern.exec(content)) !== null) {
    const path = normalizeDisplayPath(match[1]);
    files.push({
      path,
      name: getFileName(path),
      directory: addFolder(path),
      operation: "deleted",
      additions: 0,
      deletions: 0,
    });
  }

  while ((match = dependencyPattern.exec(content)) !== null) {
    const packageName = (match[1] || match[3] || "").trim();
    if (packageName) dependencies.push(packageName);
  }

  if (!files.length && !dependencies.length) return null;

  return {
    files,
    dependencies,
    folders: Array.from(folders.entries()).map(([path, count]) => ({ path, count })),
    totals: {
      files: files.length,
      folders: folders.size,
      additions: files.reduce((total, file) => total + (file.additions || 0), 0),
      deletions: files.reduce((total, file) => total + (file.deletions || 0), 0),
      dependencies: dependencies.length,
    },
  };
};

const getChangeSummary = (content: string): ChangeSummaryPayload | null => {
  const summaryMatch = content.match(
    /<dec-change-summary>([\s\S]*?)<\/dec-change-summary>/
  );

  if (summaryMatch) {
    try {
      return JSON.parse(summaryMatch[1]) as ChangeSummaryPayload;
    } catch {
      return buildFallbackChangeSummary(content);
    }
  }

  return buildFallbackChangeSummary(content);
};

const renderChangeSummary = (
  summary: ChangeSummaryPayload | null,
  isDark: boolean,
  labels: Partial<Record<string, string>>
) => {
  if (!summary) return null;

  const label = (key: string, fallback: string) => labels[key] || fallback;
  const files = summary.files || [];
  const dependencies = summary.dependencies || [];
  const folders = summary.folders || [];
  const totalFiles = summary.totals?.files ?? files.length;
  const totalFolders = summary.totals?.folders ?? folders.length;
  const additions =
    summary.totals?.additions ??
    files.reduce((total, file) => total + (file.additions || 0), 0);
  const deletions =
    summary.totals?.deletions ??
    files.reduce((total, file) => total + (file.deletions || 0), 0);
  const visibleFiles = files.slice(0, 4);
  const remainingFiles = Math.max(0, files.length - visibleFiles.length);
  const folderText = folders
    .slice(0, 2)
    .map((folder) => normalizeDisplayPath(folder.path))
    .join(", ");

  const operationLabel = (operation?: string) => {
    switch (operation) {
      case "created":
        return label("created", "Created");
      case "deleted":
        return label("deleted", "Deleted");
      case "renamed":
        return label("renamed", "Renamed");
      default:
        return label("updated", "Updated");
    }
  };

  const shell = isDark
    ? "border-[#2d3a35] text-slate-300"
    : "border-emerald-200/70 text-slate-700";
  const muted = isDark ? "text-slate-500" : "text-slate-500";
  const iconWrap = isDark
    ? "bg-emerald-300/[0.07] text-emerald-200/70 ring-1 ring-emerald-300/10"
    : "bg-emerald-50 text-emerald-700/70 ring-1 ring-emerald-200/70";
  const fileText = isDark ? "text-slate-300" : "text-slate-700";
  const fileMeta = isDark ? "text-slate-500" : "text-slate-500";
  const plusText = isDark ? "text-emerald-200/70" : "text-emerald-700/75";
  const minusText = isDark ? "text-rose-200/65" : "text-rose-600/75";

  return (
    <div className={`my-2.5 border-l pl-3 ${shell}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-full ${iconWrap}`}>
          <CheckCircle className="h-3 w-3" />
        </span>
        <span className="font-medium">{label("changeSummary", "Changes")}</span>
        <span className={muted}>
          {totalFiles} {label("fileCountLabel", "files")}
          {totalFolders ? `, ${totalFolders} ${label("folderCountLabel", "folders")}` : ""}
        </span>
        <span className={`font-mono text-[11px] ${plusText}`}>+{additions}</span>
        <span className={`font-mono text-[11px] ${minusText}`}>-{deletions}</span>
      </div>

      {folderText && (
        <div className={`mt-1 text-[11px] ${muted}`}>
          {label("changedIn", "in")} {folderText}
        </div>
      )}

      {visibleFiles.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {visibleFiles.map((file) => (
            <div
              key={`${file.operation || "updated"}-${file.path}`}
              className="flex min-w-0 items-center gap-2 text-[11px]"
              title={normalizeDisplayPath(file.path)}
            >
              <span className={`w-14 shrink-0 ${muted}`}>
                {operationLabel(file.operation)}
              </span>
              <span className={`min-w-0 flex-1 truncate font-mono ${fileText}`}>
                {file.name || getFileName(file.path)}
              </span>
              <span className={`hidden min-w-0 max-w-[92px] truncate sm:inline ${fileMeta}`}>
                {file.directory || getDirectoryName(file.path)}
              </span>
              <span className={`shrink-0 font-mono ${plusText}`}>
                +{file.additions || 0}
              </span>
              <span className={`shrink-0 font-mono ${minusText}`}>
                -{file.deletions || 0}
              </span>
            </div>
          ))}
          {remainingFiles > 0 && (
            <div className={`text-[11px] ${muted}`}>
              +{remainingFiles} {label("moreFiles", "more")}
            </div>
          )}
        </div>
      )}

      {dependencies.length > 0 && (
        <div className={`mt-1.5 flex items-center gap-1.5 text-[11px] ${muted}`}>
          <Package className="h-3 w-3" />
          <span className="truncate">
            {label("dependencies", "Dependencies")}: {dependencies.slice(0, 3).join(", ")}
            {dependencies.length > 3 ? ` +${dependencies.length - 3}` : ""}
          </span>
        </div>
      )}
    </div>
  );
};

const sanitizeAssistantText = (content: string) =>
  content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<dec-code>[\s\S]*?<\/dec-code>/g, "")
    .replace(/<dec-write\s+(?:path|file_path)="[^"]+">[\s\S]*?<\/dec-write>/g, "")
    .replace(/<dec-change-summary>[\s\S]*?<\/dec-change-summary>/g, "")
    .replace(/<\/?dec-[^>]*>/g, "")
    .replace(
      /<\/?(response_format|user_message|ai_message|examples|guidelines|console-logs|useful-context|current-route|instructions-reminder|last-diff)[^>]*>/g,
      ""
    )
    .replace(/^\s*(import|export|const|let|var|function|class|type|interface)\s.+$/gm, "")
    .replace(/^\s*(cevap|yanit|answer|response)\s*:\s*/i, "")
    .trim();

const parseSpecialTags = (
  content: string,
  containerId?: string,
  messageId?: string,
  executeOperations: boolean = true,
  isDark: boolean = true,
  labels: Partial<Record<string, string>> = {}
) => {
  const components: React.ReactNode[] = [];
  let currentIndex = 0;

  const patterns = {
    write: /<dec-write\s+(?:path|file_path)="([^"]+)">([\s\S]*?)<\/dec-write>/g,
    rename: /<dec-rename\s+from="([^"]+)"\s+to="([^"]+)"\s*\/>/g,
    delete: /<dec-delete\s+(?:path|file_path)="([^"]+)"\s*\/>/g,
    dependency:
      /<dec-add-dependency(?:\s+name="([^"]+)"(?:\s+version="([^"]+)")?)?>(.*?)<\/dec-add-dependency>/g,
    code: /<dec-code>([\s\S]*?)<\/dec-code>/g,
    thinking: /<dec-thinking>([\s\S]*?)<\/dec-thinking>/g,
    error: /<dec-error>([\s\S]*?)<\/dec-error>/g,
    success: /<dec-success>([\s\S]*?)<\/dec-success>/g,
    responseFormat: /<response_format>([\s\S]*?)<\/response_format>/g,
    userMessage: /<user_message>([\s\S]*?)<\/user_message>/g,
    aiMessage: /<ai_message>([\s\S]*?)<\/ai_message>/g,
    examples: /<examples>([\s\S]*?)<\/examples>/g,
    guidelines: /<guidelines>([\s\S]*?)<\/guidelines>/g,
    consoleLogs: /<console-logs>([\s\S]*?)<\/console-logs>/g,
    usefulContext: /<useful-context>([\s\S]*?)<\/useful-context>/g,
    currentRoute: /<current-route>([\s\S]*?)<\/current-route>/g,
    instructionsReminder:
      /<instructions-reminder>([\s\S]*?)<\/instructions-reminder>/g,
    lastDiff: /<last-diff>([\s\S]*?)<\/last-diff>/g,
  };

  const getExecutedKey = (containerId: string) => `executed_${containerId}`;

  const isMessageExecuted = (containerId: string, messageId: string) => {
    if (typeof window === "undefined") return false;
    const stored = localStorage.getItem(getExecutedKey(containerId));
    const executed = new Set(stored ? JSON.parse(stored) : []);
    return executed.has(messageId);
  };

  const markMessageExecuted = (containerId: string, messageId: string) => {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem(getExecutedKey(containerId));
    const executed = new Set(stored ? JSON.parse(stored) : []);
    executed.add(messageId);
    localStorage.setItem(
      getExecutedKey(containerId),
      JSON.stringify([...executed])
    );
  };

  const operationPromises: Promise<void>[] = [];
  const shouldExecuteOperations = false;

  const executeFileOperation = async (type: string, match: RegExpExecArray) => {
    if (!containerId || !messageId || !shouldExecuteOperations) return;

    try {
      let response;
      const authHeaders = await getBackendAuthHeaders();

      switch (type) {
        case "write":
          console.log(
            `[FILE OP] Writing file: ${match[1]} (${
              match[2].trim().length
            } chars)`
          );
          response = await fetch(
            `${API_BASE_URL}/containers/${containerId}/files`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json", ...authHeaders },
              body: JSON.stringify({
                path: match[1],
                content: match[2].trim(),
              }),
            }
          );
          console.log(
            `[FILE OP] Write file ${match[1]} - Status: ${response.status}`
          );
          break;
        case "rename":
          console.log(`[FILE OP] Renaming file: ${match[1]} â†’ ${match[2]}`);
          response = await fetch(
            `${API_BASE_URL}/containers/${containerId}/files/rename`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json", ...authHeaders },
              body: JSON.stringify({ oldPath: match[1], newPath: match[2] }),
            }
          );
          console.log(
            `[FILE OP] Rename ${match[1]} â†’ ${match[2]} - Status: ${response.status}`
          );
          break;
        case "delete":
          console.log(`[FILE OP] Deleting file: ${match[1]}`);
          response = await fetch(
            `${API_BASE_URL}/containers/${containerId}/files`,
            {
              method: "DELETE",
              headers: { "Content-Type": "application/json", ...authHeaders },
              body: JSON.stringify({ path: match[1] }),
            }
          );
          console.log(
            `[FILE OP] Delete ${match[1]} - Status: ${response.status}`
          );
          break;
        case "dependency":
          const packageName = match[1] || match[3]?.trim();
          const version = match[2];
          console.log(
            `[FILE OP] Installing dependency: ${packageName} ${
              version ? `@${version}` : ""
            }`
          );
          response = await fetch(
            `${API_BASE_URL}/containers/${containerId}/dependencies`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", ...authHeaders },
              body: JSON.stringify({ packageName, isDev: false }),
            }
          );
          console.log(
            `[FILE OP] Install ${packageName} - Status: ${response.status}`
          );
          break;
      }

      if (response && !response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      console.log(`[FILE OP] ${type} operation completed successfully`);
    } catch (error) {
      console.error(`[FILE OP] ${type} operation failed:`, error);
    }
  };

  const allMatches: Array<{
    type: string;
    match: RegExpExecArray;
    start: number;
    end: number;
  }> = [];

  Object.entries(patterns).forEach(([type, pattern]) => {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(content)) !== null) {
      allMatches.push({
        type,
        match,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  });

  allMatches.sort((a, b) => a.start - b.start);

  allMatches.forEach((matchData, index) => {
    const { type, match, start, end } = matchData;

    if (start > currentIndex) {
      const beforeContent = sanitizeAssistantText(
        content.slice(currentIndex, start)
      );
      if (beforeContent.trim()) {
        components.push(
          <div
            key={`before-${index}`}
            className={`prose prose-sm max-w-none ${
              isDark ? "prose-invert" : "prose-slate"
            }`}
          >
            {beforeContent
              .split("\n")
              .filter((line) => line.trim())
              .map((line, i) => (
                <p key={i} className="mb-1">
                  {line}
                </p>
              ))}
          </div>
        );
      }
    }

    if (operationTagTypes.has(type) && shouldExecuteOperations) {
      operationPromises.push(executeFileOperation(type, match));
    }

    if (type !== "code" && !operationTagTypes.has(type)) {
      components.push(renderSpecialComponent(type, match, index, isDark, labels));
    }
    currentIndex = end;
  });

  if (currentIndex < content.length) {
    const remainingContent = sanitizeAssistantText(
      content.slice(currentIndex)
    );

    if (remainingContent.trim()) {
      components.push(
        <div
          key="remaining"
          className={`prose prose-sm max-w-none ${
            isDark ? "prose-invert" : "prose-slate"
          }`}
        >
          {remainingContent
            .split("\n")
            .filter((line) => line.trim())
            .map((line, i) => (
              <p key={i} className="mb-1">
                {line}
              </p>
            ))}
        </div>
      );
    }
  }

  if (operationPromises.length && containerId && messageId) {
    Promise.allSettled(operationPromises).then(() => {
      markMessageExecuted(containerId, messageId);
    });
  }

  return components.length > 0 ? components : null;
};

const renderSpecialComponent = (
  type: string,
  match: RegExpExecArray,
  index: number,
  isDark: boolean = true,
  labels: Partial<Record<string, string>> = {}
): React.ReactNode => {
  const label = (key: string, fallback: string) => labels[key] || fallback;
  const neutralCard = isDark
    ? "my-3 overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.04]"
    : "my-3 overflow-hidden rounded-xl border border-slate-200/80 bg-slate-50/80";
  const neutralPaddedCard = `${neutralCard} p-3`;
  const neutralIcon = isDark ? "text-slate-400" : "text-slate-500";
  const neutralTitle = isDark ? "text-slate-200" : "text-slate-700";
  const neutralMeta = isDark ? "text-slate-400" : "text-slate-500";
  const neutralChip = isDark
    ? "bg-white/[0.06] text-slate-300"
    : "bg-white text-slate-500 border border-slate-200/80";
  const compactSuccessCard = isDark
    ? "my-1.5 border-emerald-300/10 bg-emerald-300/[0.04] text-emerald-100/80"
    : "my-1.5 border-emerald-200/70 bg-emerald-50/75 text-emerald-800/85";
  const compactSuccessChip = isDark
    ? "bg-black/20 text-emerald-100/72"
    : "bg-white/80 text-emerald-700";

  switch (type) {
    case "write":
      const updatedFileName = match[1].split(/[\\/]/).pop() || match[1];

      return (
        <div
          key={`write-${index}`}
          className={`inline-flex max-w-full items-center gap-2 rounded-xl border px-2.5 py-1.5 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${compactSuccessCard}`}
        >
          <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-300/10">
            <CheckCircle className="relative h-3.5 w-3.5 text-emerald-300/70" />
          </span>
          <span className="shrink-0 font-medium">{label("updated", "Updated")}</span>
          <span
            className={`min-w-0 max-w-[9rem] truncate rounded-md px-1.5 py-0.5 font-mono text-[11px] ${compactSuccessChip}`}
            title={match[1]}
          >
            {updatedFileName}
          </span>
        </div>
      );

    case "rename":
      return (
        <div
          key={`rename-${index}`}
          className={neutralPaddedCard}
        >
          <div className="flex items-center gap-2 mb-2">
            <Edit3 className={`w-4 h-4 ${neutralIcon}`} />
            <span className={`text-sm font-medium ${neutralTitle}`}>
              {label("renameFile", "Rename File")}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <code className={`rounded px-2 py-1 ${neutralChip}`}>
              {match[1]}
            </code>
            <span className={neutralMeta}>-&gt;</span>
            <code className={`rounded px-2 py-1 ${neutralChip}`}>
              {match[2]}
            </code>
          </div>
        </div>
      );

    case "delete":
      return (
        <div
          key={`delete-${index}`}
          className={neutralPaddedCard}
        >
          <div className="flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-red-400/90" />
            <span className="text-sm font-medium text-red-400/90">
              {label("deleteFile", "Delete File")}
            </span>
            <code className="ml-auto rounded-md bg-red-500/10 px-2 py-0.5 text-xs text-red-400">
              {match[1]}
            </code>
          </div>
        </div>
      );

    case "dependency":
      const packageName = match[1] || match[3]?.trim();
      return (
        <div
          key={`dependency-${index}`}
          className={neutralPaddedCard}
        >
          <div className="flex items-center gap-2">
            <Package className={`w-4 h-4 ${neutralIcon}`} />
            <span className={`text-sm font-medium ${neutralTitle}`}>
              {label("addDependency", "Add Dependency")}
            </span>
            <code className={`rounded-md px-2 py-0.5 text-xs ${neutralChip}`}>
              {packageName}
            </code>
          </div>
        </div>
      );

    case "code":
      return (
        <div
          key={`code-${index}`}
          className={neutralPaddedCard}
        >
          <div className="flex items-center gap-2">
            <Code className={`w-4 h-4 ${neutralIcon}`} />
            <span className={`text-sm font-medium ${neutralTitle}`}>
              {label("preparedCodeChanges", "I prepared the code changes.")}
            </span>
          </div>
        </div>
      );

    case "thinking":
      return (
        <div
          key={`thinking-${index}`}
          className={neutralPaddedCard}
        >
          <div className="flex items-center gap-2 mb-2">
            <Brain className={`w-4 h-4 ${neutralIcon}`} />
            <span className={`text-sm font-medium ${neutralTitle}`}>
              {label("thinkingProcess", "Thinking Process")}
            </span>
          </div>
          <div className={`text-sm italic ${neutralMeta}`}>
            {match[1].trim()}
          </div>
        </div>
      );

    case "error":
      return (
        <div
          key={`error-${index}`}
          className="my-3 rounded-xl border border-red-500/20 bg-red-500/[0.07] p-3"
        >
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-red-400/90" />
            <span className="text-sm font-medium text-red-400/90">
              {label("error", "Error")}
            </span>
          </div>
          <div className="text-sm text-red-300/90">{match[1].trim()}</div>
        </div>
      );

    case "success":
      return (
        <div
          key={`success-${index}`}
          className="my-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.07] p-3"
        >
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle className="w-4 h-4 text-emerald-400/90" />
            <span className="text-sm font-medium text-emerald-400/90">
              {label("success", "Success")}
            </span>
          </div>
          <div className="text-sm text-emerald-300/90">{match[1].trim()}</div>
        </div>
      );

    case "consoleLogs":
      return (
        <div
          key={`console-${index}`}
          className={neutralPaddedCard}
        >
          <div className="flex items-center gap-2">
            <Terminal className={`w-4 h-4 ${neutralIcon}`} />
            <span className={`text-sm font-medium ${neutralTitle}`}>
              {label("checkedConsole", "I checked the console output.")}
            </span>
          </div>
        </div>
      );

    case "examples":
      return (
        <div
          key={`examples-${index}`}
          className={neutralPaddedCard}
        >
          <div className="flex items-center gap-2 mb-2">
            <BookOpen className={`w-4 h-4 ${neutralIcon}`} />
            <span className={`text-sm font-medium ${neutralTitle}`}>
              {label("usedExamples", "I used the provided examples as context.")}
            </span>
          </div>
        </div>
      );

    case "currentRoute":
      return (
        <div
          key={`route-${index}`}
          className={neutralPaddedCard}
        >
          <div className="flex items-center gap-2">
            <Navigation className={`w-4 h-4 ${neutralIcon}`} />
            <span className={`text-sm font-medium ${neutralTitle}`}>
              {label("currentRoute", "Current Route")}
            </span>
            <code className={`ml-auto rounded-md px-2 py-0.5 text-xs ${neutralChip}`}>
              {match[1].trim()}
            </code>
          </div>
        </div>
      );

    case "lastDiff":
      return (
        <div
          key={`diff-${index}`}
          className={neutralPaddedCard}
        >
          <div className="flex items-center gap-2">
            <GitBranch className={`w-4 h-4 ${neutralIcon}`} />
            <span className={`text-sm font-medium ${neutralTitle}`}>
              {label("reviewedChanges", "I reviewed the recent changes.")}
            </span>
          </div>
        </div>
      );

    case "instructionsReminder":
      return (
        <div
          key={`instructions-${index}`}
          className={neutralPaddedCard}
        >
          <div className="flex items-center gap-2 mb-2">
            <Info className={`w-4 h-4 ${neutralIcon}`} />
            <span className={`text-sm font-medium ${neutralTitle}`}>
              {label("instructions", "Instructions")}
            </span>
          </div>
          <div className={`text-sm ${neutralMeta}`}>{match[1].trim()}</div>
        </div>
      );

    default:
      return null;
  }
};

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  formatMessageContent,
  containerId,
  isStreaming = false,
  isDark = true,
  workStartedAt,
  labels = {},
}) => {
  const [hasExecutedOperations, setHasExecutedOperations] = useState(false);
  const label = (key: string, fallback: string) => labels[key] || fallback;
  const ui = {
    assistantName: isDark ? "text-white/90" : "text-slate-800",
    timestamp: isDark ? "text-white/40" : "text-slate-400",
    activityCard: isDark
      ? "text-slate-500"
      : "text-slate-500",
    activityIcon: isDark
      ? "text-emerald-200/55"
      : "text-emerald-700/60",
    activityRail: isDark ? "border-emerald-300/20" : "border-emerald-500/25",
    assistantBubble: isDark
      ? "border-transparent bg-transparent text-slate-100 shadow-none"
      : "border-transparent bg-transparent text-slate-700 shadow-none",
    assistantGlow: "bg-transparent",
    userBubble: isDark
      ? "text-slate-200"
      : "text-slate-700",
    userSeparator: isDark ? "border-white/[0.055]" : "border-slate-200/80",
    userGlow: "bg-transparent",
    attachment: isDark
      ? "bg-black/20 border-white/10"
      : "bg-slate-950/[0.035] border-slate-200/80",
    attachmentMeta: isDark ? "text-white/60" : "text-slate-500",
    prose: isDark
      ? "prose-invert [&_h2]:text-white [&_h3]:text-white [&_h4]:text-white [&_strong]:text-white [&_code]:bg-slate-600/60 [&_code]:text-slate-200 [&_code]:border-slate-500/30"
      : "prose-slate [&_h2]:text-slate-950 [&_h3]:text-slate-950 [&_h4]:text-slate-950 [&_strong]:text-slate-950 [&_code]:bg-slate-100 [&_code]:text-slate-800 [&_code]:border-slate-200",
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const formatRelativeTime = (timestamp: string) => {
    const date = new Date(timestamp).getTime();
    const diffSeconds = Math.max(0, Math.floor((Date.now() - date) / 1000));

    if (diffSeconds < 45) return label("justNow", "just now");
    if (diffSeconds < 90) return label("oneMinuteAgo", "1 minute ago");
    if (diffSeconds < 3600) {
      return `${Math.floor(diffSeconds / 60)} ${label("minutesAgo", "minutes ago")}`;
    }
    if (diffSeconds < 7200) return label("oneHourAgo", "1 hour ago");
    if (diffSeconds < 86400) {
      return `${Math.floor(diffSeconds / 3600)} ${label("hoursAgo", "hours ago")}`;
    }
    if (diffSeconds < 172800) return label("oneDayAgo", "1 day ago");
    return `${Math.floor(diffSeconds / 86400)} ${label("daysAgo", "days ago")}`;
  };

  const formatWorkedTime = (startedAt?: string, finishedAt?: string) => {
    if (!startedAt || !finishedAt) return label("workedMoment", "Worked for a moment");

    const started = new Date(startedAt).getTime();
    const finished = new Date(finishedAt).getTime();
    const diffSeconds = Math.max(1, Math.floor((finished - started) / 1000));

    if (diffSeconds < 60) return label("workedUnderMinute", "Worked for under a minute");

    const minutes = Math.max(1, Math.round(diffSeconds / 60));
    if (minutes < 60) {
      return `${label("workedFor", "Worked for")} ${minutes} ${minutes === 1 ? label("minute", "minute") : label("minutes", "minutes")}`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${label("workedFor", "Worked for")} ${hours} ${
      hours === 1 ? label("hour", "hour") : label("hours", "hours")
    }${
      remainingMinutes ? ` ${remainingMinutes} ${label("min", "min")}` : ""
    }`;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const hasSpecialTags =
    /<dec-|<response_format|<user_message|<ai_message|<examples|<guidelines|<console-logs|<useful-context|<current-route|<instructions-reminder|<last-diff/.test(
      message.content
    );
  const visibleAssistantContent = sanitizeAssistantText(message.content);
  const displayAssistantContent =
    visibleAssistantContent || label("doneDefault", "Done - I applied the requested changes.");
  const changeSummary =
    message.role === "assistant" ? getChangeSummary(message.content) : null;
  const parsedAssistantContent = hasSpecialTags
    ? parseSpecialTags(
        message.content,
        containerId,
        message.id,
        false,
        isDark,
        labels
      )
    : null;

  useEffect(() => {
    if (
      !isStreaming &&
      !hasExecutedOperations &&
      hasSpecialTags &&
      containerId
    ) {
      parseSpecialTags(message.content, containerId, message.id, true, isDark, labels);
      setHasExecutedOperations(true);
    }
  }, [
    isStreaming,
    hasExecutedOperations,
    hasSpecialTags,
    containerId,
    message.content,
    message.id,
  ]);

  return (
    <div
      className={`flex flex-col ${
        message.role === "user" ? "items-end" : "items-start"
      }`}
    >
      {message.role === "assistant" && (
        <div className="mb-2 flex w-full items-center gap-2">
          <img
            className="h-3.5 w-3.5 rounded"
            src="/brand-logo-mark.png"
            alt={label("assistantAvatar", "Assistant Avatar")}
          />
          <span className={`text-[12px] font-medium tracking-[-0.01em] ${ui.assistantName}`}>
            {label("assistant", "Assistant")}
          </span>
          <span className={`text-xs ml-auto ${ui.timestamp}`}>
            {formatTimestamp(message.timestamp)}
          </span>
        </div>
      )}

      <div
        className={
          message.role === "user"
            ? `relative ml-8 max-w-[88%] overflow-hidden text-right text-[13px] font-medium leading-5 ${ui.userBubble}`
            : `relative w-full overflow-hidden rounded-[1.25rem] border px-3.5 py-2.5 text-[13.5px] leading-6 backdrop-blur-xl ${ui.assistantBubble}`
        }
      >
        {message.role === "assistant" && (
          <div className={`absolute inset-0 rounded-xl ${ui.assistantGlow}`} />
        )}
        {message.role === "user" && (
          <div className={`absolute inset-0 rounded-xl ${ui.userGlow}`} />
        )}

        <div className="relative z-10">
          {message.attachments && message.attachments.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {message.attachments.map((attachment, index) => (
                <div
                  key={index}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 border ${ui.attachment}`}
                >
                  {attachment.type === "image" ? (
                    <>
                      <Image
                        className={`w-4 h-4 ${
                          isDark ? "text-slate-400" : "text-slate-500"
                        }`}
                      />
                      <img
                        src={`data:${attachment.mimeType};base64,${attachment.data}`}
                        alt={attachment.name}
                        className="max-w-32 max-h-20 rounded object-cover"
                      />
                    </>
                  ) : (
                    <FileText
                      className={`w-4 h-4 ${
                        isDark ? "text-slate-400" : "text-slate-500"
                      }`}
                    />
                  )}
                  <div className="flex flex-col">
                    <span className="text-xs font-medium truncate max-w-24">
                      {attachment.name}
                    </span>
                    <span className={`text-xs ${ui.attachmentMeta}`}>
                      {formatFileSize(attachment.size)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {message.role === "user" ? (
            <div className="whitespace-pre-wrap break-words">
              {message.content}
            </div>
          ) : (
            <div className="space-y-1">
              {hasSpecialTags ? (
                <>
                  {parsedAssistantContent || (
                  <div className={`prose prose-sm max-w-none leading-6 ${ui.prose}`}>
                      {formatMessageContent(displayAssistantContent)}
                    </div>
                  )}
                  {renderChangeSummary(changeSummary, isDark, labels)}
                </>
              ) : (
                <>
                  <div className={`prose prose-sm max-w-none leading-6 ${ui.prose} [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:border`}>
                    {formatMessageContent(displayAssistantContent)}
                  </div>
                  {renderChangeSummary(changeSummary, isDark, labels)}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {message.role === "user" && (
        <span className={`mt-1 text-[10px] ${ui.timestamp}`}>
          {formatTimestamp(message.timestamp)}
        </span>
      )}

      {message.role === "user" && (
        <span
          className={`mt-2 block w-[72%] max-w-[240px] border-t ${ui.userSeparator}`}
          aria-hidden="true"
        />
      )}

      {message.role === "assistant" && !isStreaming && (
        <div className={`mt-2 flex w-full flex-wrap items-center gap-x-2 gap-y-1 border-l pl-3 pr-3 text-[11px] ${ui.activityRail} ${ui.activityCard}`}>
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle className={`h-3 w-3 ${ui.activityIcon}`} />
            <span>{label("checkpointMade", "Checkpoint made")}</span>
          </span>
          <span className={ui.timestamp}>Â·</span>
          <span className={ui.timestamp}>{formatRelativeTime(message.timestamp)}</span>
          <span className={ui.timestamp}>Â·</span>
          <span className="inline-flex items-center gap-1.5">
            <Clock3 className="h-3 w-3 text-slate-400/70" />
            <span>{formatWorkedTime(workStartedAt, message.timestamp)}</span>
          </span>
        </div>
      )}
    </div>
  );
};
