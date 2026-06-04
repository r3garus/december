"use client";

import {
  Box,
  Bug,
  Copy,
  Crown,
  FileText,
  Layers,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelLeft,
  PanelTopClose,
  RefreshCw,
  Save,
  Search,
  Settings,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { API_BASE_URL } from "@/lib/backend/api";
import { getBackendAuthHeaders } from "@/lib/backend/auth";
import { FileTree } from "./components/FileTree";
import { getIcon } from "./components/Icon";
import { Code } from "./utils/Code";
import { Directory, File, Type } from "./utils/FileManager";

interface CodeEditorProps {
  containerId: string;
  workspaceTheme?: "light" | "dark";
  isVisible?: boolean;
  labels?: Partial<Record<string, string>>;
  onOpenSettings?: () => void;
  onOpenSubscriptions?: () => void;
}

interface FileItem {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileItem[];
  content?: string;
}

interface OpenTab {
  file: File;
  isDirty: boolean;
}

interface EditorSession {
  openTabs: OpenTab[];
  activeTabIndex: number;
  searchQuery: string;
}

type EditorPanel = "files" | "search" | "components" | "issues";

const fileTreeCache = new Map<string, Directory>();
const fileContentCache = new Map<string, Map<string, string>>();
const fileLoadPromiseCache = new Map<string, Map<string, Promise<string>>>();
const editorSessionCache = new Map<string, EditorSession>();

const getContainerFileCache = (containerId: string) => {
  let cache = fileContentCache.get(containerId);
  if (!cache) {
    cache = new Map<string, string>();
    fileContentCache.set(containerId, cache);
  }
  return cache;
};

const getContainerLoadCache = (containerId: string) => {
  let cache = fileLoadPromiseCache.get(containerId);
  if (!cache) {
    cache = new Map<string, Promise<string>>();
    fileLoadPromiseCache.set(containerId, cache);
  }
  return cache;
};

const scheduleIdleTask = (callback: () => void) => {
  if (typeof window === "undefined") return undefined;

  const idleWindow = window as typeof window & {
    requestIdleCallback?: (
      callback: IdleRequestCallback,
      options?: IdleRequestOptions
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (idleWindow.requestIdleCallback) {
    const idleId = idleWindow.requestIdleCallback(callback, { timeout: 1200 });
    return () => idleWindow.cancelIdleCallback?.(idleId);
  }

  const timeoutId = window.setTimeout(callback, 140);
  return () => window.clearTimeout(timeoutId);
};

const countCodeLines = (content?: string) => {
  if (!content) return 0;

  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmedTrailingNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;

  return trimmedTrailingNewline ? trimmedTrailingNewline.split("\n").length : 0;
};

export const CodeEditor: React.FC<CodeEditorProps> = ({
  containerId,
  workspaceTheme = "light",
  isVisible = true,
  labels = {},
  onOpenSettings,
  onOpenSubscriptions,
}) => {
  const [rootDir, setRootDir] = useState<Directory | null>(() =>
    fileTreeCache.get(containerId) ?? null
  );
  const [filteredDir, setFilteredDir] = useState<Directory | null>(() =>
    fileTreeCache.get(containerId) ?? null
  );
  const [openTabs, setOpenTabs] = useState<OpenTab[]>(
    () => editorSessionCache.get(containerId)?.openTabs ?? []
  );
  const [activeTabIndex, setActiveTabIndex] = useState<number>(
    () => editorSessionCache.get(containerId)?.activeTabIndex ?? -1
  );
  const [searchQuery, setSearchQuery] = useState<string>(
    () => editorSessionCache.get(containerId)?.searchQuery ?? ""
  );
  const [isLoading, setIsLoading] = useState(
    () => !fileTreeCache.has(containerId)
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "success" | "error"
  >("idle");
  const [isExplorerCollapsed, setIsExplorerCollapsed] = useState(false);
  const [activePanel, setActivePanel] = useState<EditorPanel>("files");
  const [isEditorMaximized, setIsEditorMaximized] = useState(false);
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const [fileTreeVersion, setFileTreeVersion] = useState(0);
  const fileContentCacheRef = useRef<Map<string, string>>(
    getContainerFileCache(containerId)
  );
  const fileLoadPromisesRef = useRef<Map<string, Promise<string>>>(
    getContainerLoadCache(containerId)
  );
  const activeContainerRef = useRef(containerId);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  const activeFile =
    activeTabIndex >= 0 ? openTabs[activeTabIndex]?.file : undefined;
  const label = (key: string, fallback: string) => labels[key] || fallback;
  const getFileExtension = (name: string) => name.split(".").pop() || "";
  const isDark = workspaceTheme === "dark";
  const ui = {
    shell: isDark ? "bg-[#222223]" : "bg-[#fbfdff]",
    topbar: isDark
      ? "border-[#333335] bg-[#222223]"
      : "border-slate-200/70 bg-[#fbfdff]",
    tabActive: isDark
      ? "border-[#3a3a3c] bg-[#222223] text-slate-100"
      : "border-slate-200 bg-white text-slate-950 shadow-[0_1px_2px_rgba(15,23,42,0.035)]",
    tabIdle: isDark
      ? "border-transparent bg-transparent text-slate-500 hover:bg-[#2a2a2b] hover:text-slate-200"
      : "border-transparent text-slate-500 hover:bg-slate-100/70 hover:text-slate-950",
    tabIcon: isDark
      ? "bg-[#222223] text-slate-300"
      : "bg-[#f3f7fb] text-slate-700",
    tabClose: isDark
      ? "text-slate-500 hover:bg-[#2a2a2b] hover:text-slate-100"
      : "text-slate-400 hover:bg-slate-200/70 hover:text-slate-900",
    emptyTab: isDark
      ? "border-transparent bg-transparent text-slate-500"
      : "border-transparent bg-transparent text-slate-400",
    toolbarAction: isDark
      ? "text-slate-500 hover:bg-[#2a2a2b] hover:text-slate-200"
      : "text-slate-400 hover:bg-slate-100 hover:text-slate-800",
    toolbarDivider: isDark ? "border-[#333335]" : "border-slate-200/70",
    codeMeter: isDark
      ? "border-[#3a3a3c] bg-[#222223] text-slate-500"
      : "border-slate-200/80 bg-slate-100/80 text-slate-500",
    emptyText: isDark ? "text-slate-500" : "text-slate-400",
    saveReady: isDark
      ? "bg-[#31577d] hover:bg-[#3b6793] text-white border border-[#5f8dbd]/55"
      : "bg-[#31577d] hover:bg-[#3b6793] text-white border border-[#31577d]/35",
    saveDisabled: isDark
      ? "bg-[#222223] text-slate-600 border border-[#3a3a3c]"
      : "bg-slate-100 text-slate-400 border border-slate-200",
    panelBorder: isDark ? "border-[#333335]" : "border-slate-200/70",
    heading: isDark ? "text-slate-100" : "text-slate-950",
    muted: isDark ? "text-slate-500" : "text-slate-400",
    searchIcon: isDark ? "text-slate-500" : "text-slate-400",
    searchInput: isDark
      ? "border-[#3a3a3c] bg-[#222223] text-slate-100 placeholder-slate-600 focus:border-[#5783b3] focus:ring-[#31577d]/20"
      : "border-slate-200 bg-white text-slate-900 placeholder-slate-400 focus:border-[#31577d]/35 focus:ring-[#31577d]/12",
    treeText: isDark ? "text-slate-300" : "text-slate-600",
    loaderText: isDark ? "text-slate-400" : "text-slate-500",
    activityRail: isDark
      ? "rounded-lg bg-[#222223]"
      : "rounded-lg bg-[#f1f6fb]",
    activityIdle: isDark
      ? "border-transparent text-slate-500 hover:bg-[#2a2a2b] hover:text-slate-200"
      : "border-transparent text-slate-400 hover:bg-slate-100/80 hover:text-slate-800",
    settingsAction: isDark
      ? "border-transparent text-slate-500 hover:bg-[#2a2a2b] hover:text-slate-200"
      : "border-transparent text-slate-400 hover:bg-slate-100/80 hover:text-slate-800",
    moreMenu: isDark
      ? "border-[#3a3a3c] bg-[#222223] shadow-[0_18px_42px_rgba(0,0,0,0.34)]"
      : "border-slate-200 bg-white shadow-[0_18px_38px_rgba(15,23,42,0.14)]",
    moreMenuItem: isDark
      ? "text-slate-300 hover:bg-white/[0.055] hover:text-slate-100 disabled:text-slate-600"
      : "text-slate-600 hover:bg-slate-950/[0.045] hover:text-slate-950 disabled:text-slate-300",
  };

  useEffect(() => {
    activeContainerRef.current = containerId;
    fileContentCacheRef.current = getContainerFileCache(containerId);
    fileLoadPromisesRef.current = getContainerLoadCache(containerId);

    const cachedDirectory = fileTreeCache.get(containerId) ?? null;
    const cachedSession = editorSessionCache.get(containerId);

    setRootDir(cachedDirectory);
    setFilteredDir(cachedDirectory);
    setOpenTabs(cachedSession?.openTabs ?? []);
    setActiveTabIndex(cachedSession?.activeTabIndex ?? -1);
    setSearchQuery(cachedSession?.searchQuery ?? "");
    setSaveStatus("idle");
    setIsLoading(!cachedDirectory);

    const abortController = new AbortController();

    const fetchFileTree = async () => {
      const hasCachedDirectory = fileTreeCache.has(containerId);

      try {
        if (!hasCachedDirectory) {
          setIsLoading(true);
        }

        const response = await fetch(
          `${API_BASE_URL}/containers/${containerId}/file-tree`,
          {
            headers: await getBackendAuthHeaders(),
            signal: abortController.signal,
          }
        );

        if (!response.ok) {
          throw new Error("Failed to fetch file tree");
        }

        const data = await response.json();

        if (data.success) {
          const directory = convertToDirectory(data.fileTree);
          fileTreeCache.set(containerId, directory);

          if (activeContainerRef.current !== containerId) return;

          setRootDir(directory);
          setFilteredDir(searchQuery.trim() ? null : directory);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;

        console.error("Error fetching file tree:", error);
        if (hasCachedDirectory || activeContainerRef.current !== containerId) {
          return;
        }

        const errorDir: Directory = {
          id: "error",
          name: "Error loading files",
          type: Type.DIRECTORY,
          parentId: undefined,
          depth: 0,
          dirs: [],
          files: [
            {
              id: "error-file",
              name: "error.txt",
              type: Type.FILE,
              parentId: "error",
              depth: 1,
              content:
                "Error: Could not load container files. Please ensure the container is running.",
            },
          ],
        };
        setRootDir(errorDir);
        setFilteredDir(errorDir);
      } finally {
        if (activeContainerRef.current === containerId) {
          setIsLoading(false);
        }
      }
    };

    if (containerId) {
      fetchFileTree();
    }

    return () => abortController.abort();
  }, [containerId, fileTreeVersion]);

  useEffect(() => {
    editorSessionCache.set(containerId, {
      openTabs,
      activeTabIndex,
      searchQuery,
    });
  }, [activeTabIndex, containerId, openTabs, searchQuery]);

  useEffect(() => {
    if (!isMoreMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) {
        setIsMoreMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsMoreMenuOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isMoreMenuOpen]);

  useEffect(() => {
    if (!isEditorMaximized) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsEditorMaximized(false);
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isEditorMaximized]);

  useEffect(() => {
    if (!rootDir || !searchQuery.trim()) {
      setFilteredDir(rootDir);
      return;
    }

    const filterDirectory = (dir: Directory): Directory | null => {
      const filteredFiles = dir.files.filter((file) =>
        file.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

      const filteredDirs = dir.dirs
        .map((subDir) => filterDirectory(subDir))
        .filter((subDir): subDir is Directory => subDir !== null);

      const matchingDirs = dir.dirs.filter((subDir) =>
        subDir.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

      const allFilteredDirs = [
        ...filteredDirs,
        ...matchingDirs.filter(
          (matchingDir) =>
            !filteredDirs.some((filtered) => filtered.id === matchingDir.id)
        ),
      ];

      if (filteredFiles.length === 0 && allFilteredDirs.length === 0) {
        return null;
      }

      return {
        ...dir,
        files: filteredFiles,
        dirs: allFilteredDirs,
      };
    };

    const filtered = filterDirectory(rootDir);
    setFilteredDir(filtered);
  }, [rootDir, searchQuery]);

  useEffect(() => {
    if (!rootDir) return;

    let isCancelled = false;
    const timeoutIds: number[] = [];

    const cancelIdleTask = scheduleIdleTask(() => {
      if (isCancelled) return;

      const files = flattenFiles(rootDir)
        .filter((file) => file.path)
        .sort((left, right) => getPreloadScore(right) - getPreloadScore(left))
        .slice(0, 5);

      files.forEach((file, index) => {
        const runPreload = () => {
          if (!isCancelled) {
            loadFileContent(file).catch(() => undefined);
          }
        };

        if (typeof window === "undefined") {
          runPreload();
          return;
        }

        timeoutIds.push(window.setTimeout(runPreload, index * 70));
      });
    });

    return () => {
      isCancelled = true;
      cancelIdleTask?.();
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
    };
  }, [rootDir, containerId]);

  const convertToDirectory = (
    fileItems: FileItem[],
    parentId?: string,
    depth: number = 0
  ): Directory => {
    const rootDir: Directory = {
      id: parentId || "root",
      name: "my-nextjs-app",
      type: Type.DIRECTORY,
      parentId: undefined,
      depth: 0,
      dirs: [],
      files: [],
    };

    const processItems = (
      items: FileItem[],
      parent: Directory,
      currentDepth: number
    ) => {
      items.forEach((item) => {
        if (item.type === "directory" && item.children) {
          const dir: Directory = {
            id: item.path,
            name: item.name,
            type: Type.DIRECTORY,
            parentId: parent.id,
            depth: currentDepth + 1,
            dirs: [],
            files: [],
          };
          parent.dirs.push(dir);
          processItems(item.children, dir, currentDepth + 1);
        } else if (item.type === "file") {
          const file: File = {
            id: item.path,
            name: item.name,
            type: Type.FILE,
            parentId: parent.id,
            depth: currentDepth + 1,
            content: "",
            path: item.path,
          };
          parent.files.push(file);
        }
      });
    };

    processItems(fileItems, rootDir, depth);
    return rootDir;
  };

  const flattenFiles = (directory: Directory): File[] => [
    ...directory.files,
    ...directory.dirs.flatMap((dir) => flattenFiles(dir)),
  ];

  const getDisplayPath = (file: File) => file.path || file.name;

  const getParentPath = (file: File) => {
    const displayPath = getDisplayPath(file);
    const normalizedPath = displayPath.replace(/\\/g, "/");
    const pathParts = normalizedPath.split("/");

    return pathParts.length > 1 ? pathParts.slice(0, -1).join("/") : "/";
  };

  const isLikelyComponentFile = (file: File) => {
    const displayPath = getDisplayPath(file).replace(/\\/g, "/");
    const extension = getFileExtension(file.name).toLowerCase();
    const isReactFile = extension === "tsx" || extension === "jsx";

    if (!isReactFile) return false;
    if (displayPath.includes("/components/")) return true;
    return /^[A-Z]/.test(file.name);
  };

  const getPreloadScore = (file: File) => {
    const name = file.name.toLowerCase();
    if (name === "package.json") return 100;
    if (name === "app.tsx" || name === "page.tsx" || name === "index.tsx") {
      return 90;
    }
    if (name.endsWith(".tsx") || name.endsWith(".jsx")) return 80;
    if (name.endsWith(".ts") || name.endsWith(".js")) return 70;
    if (name.endsWith(".css")) return 60;
    return 10;
  };

  const getFileKey = (file: File) => file.path || file.id;

  const loadFileContent = async (file: File): Promise<string> => {
    const fileKey = getFileKey(file);
    const cachedContent = fileContentCacheRef.current.get(fileKey);

    if (cachedContent !== undefined) {
      file.content = cachedContent;
      return cachedContent;
    }

    const existingLoad = fileLoadPromisesRef.current.get(fileKey);
    if (existingLoad) return existingLoad;

    const loadPromise = (async () => {
      let content = "";

      try {
        const response = await fetch(
          `${API_BASE_URL}/containers/${containerId}/file?path=${encodeURIComponent(
            fileKey
          )}`,
          {
            headers: await getBackendAuthHeaders(),
          }
        );

        if (!response.ok) {
          throw new Error("Failed to load file content");
        }

        const data = await response.json();
        if (data.success) {
          content = data.content;
        }
      } catch (error) {
        console.error("Error loading file content:", error);
        content = "Error loading file content";
      } finally {
        file.content = content;
        fileContentCacheRef.current.set(fileKey, content);
        fileLoadPromisesRef.current.delete(fileKey);
      }

      return content;
    })();

    fileLoadPromisesRef.current.set(fileKey, loadPromise);
    return loadPromise;
  };

  const applyLoadedContent = (file: File, content: string) => {
    setOpenTabs((prev) =>
      prev.map((tab) =>
        tab.file.id === file.id && !tab.isDirty
          ? {
              ...tab,
              file: {
                ...tab.file,
                content,
              },
            }
          : tab
      )
    );
  };

  const onSelect = (file: File) => {
    const existingTabIndex = openTabs.findIndex(
      (tab) => tab.file.id === file.id
    );

    if (existingTabIndex >= 0) {
      setActiveTabIndex(existingTabIndex);
      return;
    }

    const fileKey = getFileKey(file);
    const cachedContent = fileContentCacheRef.current.get(fileKey);
    const newTab: OpenTab = {
      file: {
        ...file,
        content: cachedContent ?? file.content ?? "",
      },
      isDirty: false,
    };
    const nextTabIndex = openTabs.length;
    setOpenTabs((prev) => [...prev, newTab]);
    setActiveTabIndex(nextTabIndex);
    setSaveStatus("idle");

    if (file.path && cachedContent === undefined) {
      loadFileContent(file).then((content) => {
        if (activeContainerRef.current === containerId) {
          applyLoadedContent(file, content);
        }
      });
    }
  };

  useEffect(() => {
    if (!rootDir || openTabs.length > 0 || activeTabIndex !== -1) return;

    const firstFile = flattenFiles(rootDir)
      .filter((file) => file.path || file.content)
      .sort((left, right) => getPreloadScore(right) - getPreloadScore(left))[0];

    if (!firstFile) return;

    const fileKey = getFileKey(firstFile);
    const cachedContent = fileContentCacheRef.current.get(fileKey);

    setOpenTabs([
      {
        file: {
          ...firstFile,
          content: cachedContent ?? firstFile.content ?? "",
        },
        isDirty: false,
      },
    ]);
    setActiveTabIndex(0);
    setSaveStatus("idle");

    if (firstFile.path && cachedContent === undefined) {
      loadFileContent(firstFile).then((content) => {
        if (activeContainerRef.current === containerId) {
          applyLoadedContent(firstFile, content);
        }
      });
    }
  }, [rootDir, openTabs.length, activeTabIndex]);

  const closeTab = (index: number) => {
    setOpenTabs((prev) => prev.filter((_, i) => i !== index));

    if (activeTabIndex === index) {
      setActiveTabIndex(index > 0 ? index - 1 : openTabs.length > 1 ? 0 : -1);
    } else if (activeTabIndex > index) {
      setActiveTabIndex((prev) => prev - 1);
    }
  };

  const closeAllTabs = () => {
    setOpenTabs([]);
    setActiveTabIndex(-1);
    setSaveStatus("idle");
  };

  const refreshFileTree = () => {
    fileTreeCache.delete(containerId);
    setRootDir(null);
    setFilteredDir(null);
    setIsLoading(true);
    setFileTreeVersion((version) => version + 1);
    setIsMoreMenuOpen(false);
  };

  const copyActiveFilePath = async () => {
    const filePath = activeFile?.path || activeFile?.name;
    if (!filePath) return;

    try {
      await navigator.clipboard.writeText(filePath);
      toast.success(label("filePathCopied", "File path copied"));
    } catch {
      toast.error(label("copyFailed", "Copy failed"));
    } finally {
      setIsMoreMenuOpen(false);
    }
  };

  const handleCodeChange = (value: string | undefined) => {
    if (activeFile && value !== undefined) {
      activeFile.content = value;

      setOpenTabs((prev) =>
        prev.map((tab, index) =>
          index === activeTabIndex ? { ...tab, isDirty: true } : tab
        )
      );
    }
  };

  const handleSave = async () => {
    if (!activeFile || !activeFile.path) return;

    setSaveStatus("saving");
    setIsSaving(true);

    try {
      const response = await fetch(
        `${API_BASE_URL}/containers/${containerId}/files`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(await getBackendAuthHeaders()),
          },
          body: JSON.stringify({
            path: activeFile.path,
            content: activeFile.content,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        setSaveStatus("error");
        throw new Error(data.error || "Failed to save file");
      }

      if (data.success) {
        fileContentCacheRef.current.set(activeFile.path, activeFile.content);
        setSaveStatus("success");
        setOpenTabs((prev) =>
          prev.map((tab, index) =>
            index === activeTabIndex ? { ...tab, isDirty: false } : tab
          )
        );

        setTimeout(() => {
          setSaveStatus("idle");
        }, 2000);
      }
    } catch (error) {
      console.error("Error saving file:", error);
      setSaveStatus("error");

      setTimeout(() => {
        setSaveStatus("idle");
      }, 3000);
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (activeFile) {
          handleSave();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeFile]);

  const allFiles = useMemo(() => (rootDir ? flattenFiles(rootDir) : []), [rootDir]);

  const searchResultFiles = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    if (normalizedQuery && filteredDir) {
      return flattenFiles(filteredDir).slice(0, 18);
    }

    return [...allFiles]
      .sort((left, right) => getPreloadScore(right) - getPreloadScore(left))
      .slice(0, 12);
  }, [allFiles, filteredDir, searchQuery]);

  const componentFiles = useMemo(
    () =>
      allFiles
        .filter(isLikelyComponentFile)
        .sort((left, right) => getDisplayPath(left).localeCompare(getDisplayPath(right))),
    [allFiles]
  );

  const routeFiles = useMemo(
    () =>
      allFiles
        .filter((file) => {
          const name = file.name.toLowerCase();
          return name === "page.tsx" || name === "layout.tsx" || name === "template.tsx";
        })
        .sort((left, right) => getDisplayPath(left).localeCompare(getDisplayPath(right))),
    [allFiles]
  );

  const diagnostics = useMemo(() => {
    const dirtyTabs = openTabs.filter((tab) => tab.isDirty);
    const items: Array<{
      tone: "warning" | "error" | "info";
      title: string;
      detail: string;
      file?: File;
    }> = [];

    dirtyTabs.forEach((tab) => {
      items.push({
        tone: "warning",
        title: label("unsavedFile", "Unsaved file"),
        detail: getDisplayPath(tab.file),
        file: tab.file,
      });
    });

    if (rootDir?.id === "error") {
      items.push({
        tone: "error",
        title: label("treeUnavailable", "File tree unavailable"),
        detail: label(
          "treeUnavailableDesc",
          "Container files could not be loaded yet."
        ),
      });
    }

    if (activeFile?.content === "Error loading file content") {
      items.push({
        tone: "error",
        title: label("contentUnavailable", "File content unavailable"),
        detail: getDisplayPath(activeFile),
        file: activeFile,
      });
    }

    if (allFiles.length === 0 && rootDir?.id !== "error") {
      items.push({
        tone: "info",
        title: label("emptyWorkspace", "No files indexed"),
        detail: label("emptyWorkspaceDesc", "The file tree is empty right now."),
      });
    }

    return items;
  }, [activeFile, allFiles.length, openTabs, rootDir]);

  if (isLoading) {
    return (
      <div className={`flex h-full items-center justify-center ${ui.shell}`}>
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#31577d] border-t-transparent"></div>
          <span className={`font-medium ${ui.loaderText}`}>
            {label("loadingFiles", "Loading files...")}
          </span>
        </div>
      </div>
    );
  }

  if (!rootDir) {
    return (
      <div className={`flex h-full items-center justify-center ${ui.shell}`}>
        <div className={ui.loaderText}>{label("noFilesFound", "No files found")}</div>
      </div>
    );
  }

  const visibleFileCount = filteredDir ? flattenFiles(filteredDir).length : 0;
  const activeFilePath = activeFile?.path || activeFile?.name;
  const activeFileLineCount = countCodeLines(activeFile?.content);
  const codeMeterValue = activeFile
    ? `${activeFileLineCount} ${label("lineCountLabel", "lines")}`
    : `${visibleFileCount} ${label("fileCountLabel", "files")}`;
  const codeMeterTitle = activeFilePath
    ? `${activeFilePath} - ${codeMeterValue}`
    : codeMeterValue;
  const panelCardClass = isDark
    ? "border-[#3a3a3c] bg-[#222223]/72 hover:border-[#4a4a4c] hover:bg-[#2a2a2b]"
    : "border-slate-200/80 bg-white/72 hover:border-slate-300 hover:bg-white";
  const panelMutedClass = isDark ? "text-slate-500" : "text-slate-500";
  const panelSubtleClass = isDark
    ? "border-[#3a3a3c] bg-[#222223]/72"
    : "border-slate-200/80 bg-slate-50/72";

  const renderFileButton = (
    file: File,
    options: { badge?: string; description?: string } = {}
  ) => (
    <button
      key={`${options.badge || "file"}-${getDisplayPath(file)}`}
      type="button"
      onClick={() => onSelect(file)}
      className={`group flex w-full items-center gap-2 rounded-lg border px-2 py-2 text-left transition ${panelCardClass}`}
      title={getDisplayPath(file)}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[13px] ${
          isDark ? "bg-[#222223] text-slate-300" : "bg-slate-100 text-slate-700"
        }`}
      >
        {getIcon(getFileExtension(file.name), file.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[12px] font-medium ${ui.heading}`}>
          {file.name}
        </span>
        <span className={`mt-0.5 block truncate text-[10px] ${panelMutedClass}`}>
          {options.description || getParentPath(file)}
        </span>
      </span>
      {options.badge && (
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
            isDark
              ? "bg-[#31577d]/16 text-[#9cc4ee]"
              : "bg-sky-50 text-[#31577d]"
          }`}
        >
          {options.badge}
        </span>
      )}
    </button>
  );

  const renderPanelHeader = (
    title: string,
    count?: number,
    subtitle?: string
  ) => (
    <div className={`border-b px-3 py-2.5 ${ui.panelBorder}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-[13px] font-semibold ${ui.heading}`}>
              {title}
            </span>
            {typeof count === "number" && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                  isDark
                    ? "bg-[#222223] text-slate-500"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {count}
              </span>
            )}
          </div>
          {subtitle && (
            <p className={`mt-0.5 truncate text-[10px] ${panelMutedClass}`}>
              {subtitle}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setIsExplorerCollapsed(true)}
          className={`motion-icon-interactive flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
            isDark
              ? "text-slate-500 hover:bg-[#2a2a2b] hover:text-slate-200"
              : "text-slate-400 hover:bg-slate-200/70 hover:text-slate-700"
          }`}
          title={label("explorerLayout", "Explorer layout")}
          aria-label={label("explorerLayout", "Explorer layout")}
          aria-expanded={true}
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );

  const renderSidebarPanel = () => {
    if (activePanel === "search") {
      return (
        <>
          {renderPanelHeader(
            label("search", "Search"),
            searchResultFiles.length,
            searchQuery.trim()
              ? label("searchMatches", "Matching workspace files")
              : label("recentFiles", "Quick open suggestions")
          )}
          <div className={`border-b px-3 py-2.5 ${ui.panelBorder}`}>
            <div className="relative">
              <Search className={`absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 ${ui.searchIcon}`} />
              <input
                type="text"
                placeholder={label("searchFiles", "Search files...")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={`motion-input w-full rounded-md border py-1.5 pl-8 pr-2.5 text-[11px] focus:outline-none focus:ring-1 ${ui.searchInput}`}
              />
            </div>
          </div>
          <div className={`flex-1 overflow-y-auto px-2.5 py-2.5 custom-scrollbar ${ui.treeText}`}>
            <div className="space-y-1.5">
              {searchResultFiles.length > 0 ? (
                searchResultFiles.map((file) => renderFileButton(file))
              ) : (
                <div className={`rounded-xl border p-3 text-[11px] ${panelSubtleClass} ${panelMutedClass}`}>
                  {label("noSearchResults", "No matching files yet.")}
                </div>
              )}
            </div>
          </div>
        </>
      );
    }

    if (activePanel === "components") {
      return (
        <>
          {renderPanelHeader(
            label("components", "Components"),
            componentFiles.length,
            label("componentMap", "Reusable UI and route surfaces")
          )}
          <div className={`border-b px-3 py-2.5 ${ui.panelBorder}`}>
            <div className="grid grid-cols-2 gap-2">
              <div className={`rounded-lg border px-2 py-2 ${panelSubtleClass}`}>
                <p className={`text-[9px] uppercase tracking-[0.14em] ${panelMutedClass}`}>
                  {label("components", "Components")}
                </p>
                <p className={`mt-1 text-[16px] font-semibold ${ui.heading}`}>
                  {componentFiles.length}
                </p>
              </div>
              <div className={`rounded-lg border px-2 py-2 ${panelSubtleClass}`}>
                <p className={`text-[9px] uppercase tracking-[0.14em] ${panelMutedClass}`}>
                  {label("routes", "Routes")}
                </p>
                <p className={`mt-1 text-[16px] font-semibold ${ui.heading}`}>
                  {routeFiles.length}
                </p>
              </div>
            </div>
          </div>
          <div className={`flex-1 overflow-y-auto px-2.5 py-2.5 custom-scrollbar ${ui.treeText}`}>
            <div className="space-y-4">
              <section>
                <p className={`mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${panelMutedClass}`}>
                  {label("componentFiles", "Component files")}
                </p>
                <div className="space-y-1.5">
                  {componentFiles.length > 0 ? (
                    componentFiles.map((file) =>
                      renderFileButton(file, { badge: label("component", "UI") })
                    )
                  ) : (
                    <div className={`rounded-xl border p-3 text-[11px] ${panelSubtleClass} ${panelMutedClass}`}>
                      {label("noComponents", "No component files found.")}
                    </div>
                  )}
                </div>
              </section>
              {routeFiles.length > 0 && (
                <section>
                  <p className={`mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${panelMutedClass}`}>
                    {label("routeFiles", "Route files")}
                  </p>
                  <div className="space-y-1.5">
                    {routeFiles.map((file) =>
                      renderFileButton(file, { badge: label("route", "Route") })
                    )}
                  </div>
                </section>
              )}
            </div>
          </div>
        </>
      );
    }

    if (activePanel === "issues") {
      return (
        <>
          {renderPanelHeader(
            label("issues", "Issues"),
            diagnostics.length,
            label("reviewItems", "Runtime, save and file health")
          )}
          <div className={`flex-1 overflow-y-auto px-2.5 py-2.5 custom-scrollbar ${ui.treeText}`}>
            {diagnostics.length === 0 ? (
              <div
                className={`rounded-xl border p-3 ${
                  isDark
                    ? "border-emerald-400/10 bg-emerald-400/[0.045] text-emerald-100/80"
                    : "border-emerald-100 bg-emerald-50/80 text-emerald-800"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
                  <p className="text-[12px] font-semibold">
                    {label("noIssues", "No blocking issues")}
                  </p>
                </div>
                <p className={`mt-1 text-[10px] ${isDark ? "text-emerald-100/50" : "text-emerald-700/70"}`}>
                  {label(
                    "noIssuesDesc",
                    "Open files, save state and file tree look healthy."
                  )}
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {diagnostics.map((item, index) => (
                  <button
                    key={`${item.title}-${index}`}
                    type="button"
                    onClick={() => item.file && onSelect(item.file)}
                    className={`w-full rounded-xl border p-3 text-left transition ${
                      item.tone === "error"
                        ? isDark
                          ? "border-rose-400/14 bg-rose-400/[0.045] hover:bg-rose-400/[0.07]"
                          : "border-rose-100 bg-rose-50/80 hover:bg-rose-50"
                        : item.tone === "warning"
                        ? isDark
                          ? "border-amber-300/14 bg-amber-300/[0.045] hover:bg-amber-300/[0.07]"
                          : "border-amber-100 bg-amber-50/80 hover:bg-amber-50"
                        : panelCardClass
                    }`}
                    disabled={!item.file}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          item.tone === "error"
                            ? "bg-rose-400"
                            : item.tone === "warning"
                            ? "bg-amber-300"
                            : "bg-sky-400"
                        }`}
                      />
                      <p className={`truncate text-[12px] font-semibold ${ui.heading}`}>
                        {item.title}
                      </p>
                    </div>
                    <p className={`mt-1 truncate pl-3.5 text-[10px] ${panelMutedClass}`}>
                      {item.detail}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      );
    }

    return (
      <>
        <div className={`border-b px-3 py-2.5 ${ui.panelBorder}`}>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`text-[13px] font-semibold ${ui.heading}`}>
                {label("explorer", "Explorer")}
              </span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                  isDark
                    ? "bg-[#222223] text-slate-500"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {visibleFileCount}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsExplorerCollapsed(true)}
              className={`motion-icon-interactive flex h-6 w-6 items-center justify-center rounded-md ${
                isDark
                  ? "text-slate-500 hover:bg-[#2a2a2b] hover:text-slate-200"
                  : "text-slate-400 hover:bg-slate-200/70 hover:text-slate-700"
              }`}
              title={label("explorerLayout", "Explorer layout")}
              aria-label={label("explorerLayout", "Explorer layout")}
              aria-expanded={true}
            >
              <PanelLeft className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="relative">
            <Search className={`absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 ${ui.searchIcon}`} />
            <input
              type="text"
              placeholder={label("searchFiles", "Search files...")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`motion-input w-full rounded-md border py-1.5 pl-8 pr-2.5 text-[11px] focus:outline-none focus:ring-1 ${ui.searchInput}`}
            />
          </div>
          {activeFilePath && (
            <div
              className={`mt-2 flex items-center gap-2 rounded-lg px-1.5 py-1 text-[11px] ${panelMutedClass}`}
              title={activeFilePath}
            >
              <span
                className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] ${
                  isDark
                    ? "bg-[#31577d]/14 text-[#9cc4ee]"
                    : "bg-sky-50 text-sky-700"
                }`}
              >
                {label("active", "Active")}
              </span>
              <span className="min-w-0 truncate">{activeFilePath}</span>
            </div>
          )}
        </div>
        <div className={`flex-1 overflow-y-auto px-2.5 py-2.5 text-sm custom-scrollbar ${ui.treeText}`}>
          {filteredDir && (
            <FileTree
              rootDir={filteredDir}
              selectedFile={activeFile}
              onSelect={onSelect}
              isDark={isDark}
              labels={labels}
            />
          )}
        </div>
      </>
    );
  };

  return (
    <div
      className={
        isEditorMaximized
          ? `fixed inset-3 z-[120] overflow-hidden rounded-xl border shadow-[0_24px_70px_rgba(0,0,0,0.32)] ${
              isDark ? "border-[#3a3a3c] bg-[#222223]" : "border-slate-200 bg-white"
            }`
          : "relative z-10 h-full min-h-0 w-full overflow-hidden"
      }
    >
      <div
        data-editor-theme={workspaceTheme}
        data-editor-dark={isDark ? "true" : "false"}
        className={`flex h-full min-h-0 w-full flex-col overflow-hidden ${ui.shell}`}
      >
        <div
          className={`flex h-10 items-center justify-between border-b px-1.5 ${ui.topbar}`}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {openTabs.length > 0 ? (
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto custom-scrollbar">
                {openTabs.map((tab, index) => {
                  const isActive = index === activeTabIndex;

                  return (
                    <div
                      key={tab.file.id}
                      role="button"
                      tabIndex={0}
                      className={`group relative flex h-7 min-w-[112px] max-w-[176px] cursor-pointer items-center gap-1.5 overflow-hidden rounded-md border px-2 text-[11px] outline-none transition-all duration-200 ${
                        isActive ? ui.tabActive : ui.tabIdle
                      }`}
                      onClick={() => setActiveTabIndex(index)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setActiveTabIndex(index);
                        }
                      }}
                      title={tab.file.path || tab.file.name}
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[12px] ${ui.tabIcon}`}
                      >
                        {getIcon(
                          getFileExtension(tab.file.name),
                          tab.file.name
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-left font-medium">
                        {tab.file.name}
                      </span>
                      {!tab.isDirty && isActive && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#9cc4ee]/80" />
                      )}
                      {tab.isDirty && (
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            isDark ? "bg-[#c8e2ff]" : "bg-slate-500"
                          }`}
                          aria-label={label("unsavedChanges", "Unsaved changes")}
                        />
                      )}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          closeTab(index);
                        }}
                        className={`motion-icon-interactive flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition group-hover:opacity-100 ${
                          isActive ? "opacity-100" : ""
                        } ${ui.tabClose}`}
                        title={`${label("closeFile", "Close file")} ${tab.file.name}`}
                        aria-label={`${label("closeFile", "Close file")} ${tab.file.name}`}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div
                className={`flex h-7 items-center rounded-md border px-2.5 text-[11px] ${ui.emptyTab}`}
              >
                {label("openFileFromExplorer", "Open a file from Explorer")}
              </div>
            )}
          </div>

          <div
            className={`mr-1.5 flex items-center gap-0.5 border-l pl-1.5 ${ui.toolbarDivider}`}
          >
            <div
              className={`mr-1 hidden h-6 items-center rounded-md border px-2 text-[10px] font-semibold leading-none tracking-[-0.01em] tabular-nums sm:flex ${ui.codeMeter}`}
              title={codeMeterTitle}
              aria-label={codeMeterTitle}
            >
              {codeMeterValue}
            </div>
            <button
              type="button"
              onClick={() => setIsEditorMaximized((current) => !current)}
              className={`motion-icon-interactive flex h-6 w-6 items-center justify-center rounded-md transition ${ui.toolbarAction}`}
              title={
                isEditorMaximized
                  ? label("restoreEditor", "Restore editor")
                  : label("maximizeEditor", "Maximize editor")
              }
              aria-label={
                isEditorMaximized
                  ? label("restoreEditor", "Restore editor")
                  : label("maximizeEditor", "Maximize editor")
              }
              aria-pressed={isEditorMaximized}
            >
              {isEditorMaximized ? (
                <Minimize2 className="h-3 w-3" />
              ) : (
                <Maximize2 className="h-3 w-3" />
              )}
            </button>
            <div className="relative" ref={moreMenuRef}>
              <button
                type="button"
                onClick={() => setIsMoreMenuOpen((current) => !current)}
                className={`motion-icon-interactive flex h-6 w-6 items-center justify-center rounded-md transition ${ui.toolbarAction}`}
                title={label("moreEditorActions", "More editor actions")}
                aria-label={label("moreEditorActions", "More editor actions")}
                aria-haspopup="menu"
                aria-expanded={isMoreMenuOpen}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>

              {isMoreMenuOpen && (
                <div
                  className={`workspace-popover-in absolute right-0 top-full z-50 mt-1.5 w-48 origin-top-right rounded-lg border p-1 ${ui.moreMenu}`}
                  role="menu"
                >
                  <button
                    type="button"
                    onClick={copyActiveFilePath}
                    disabled={!activeFile}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition disabled:cursor-not-allowed ${ui.moreMenuItem}`}
                    role="menuitem"
                  >
                    <Copy className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    <span>{label("copyFilePath", "Copy file path")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={refreshFileTree}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition ${ui.moreMenuItem}`}
                    role="menuitem"
                  >
                    <RefreshCw className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    <span>{label("refreshFiles", "Refresh files")}</span>
                  </button>
                  <div className={`my-1 h-px ${isDark ? "bg-white/[0.06]" : "bg-slate-200/80"}`} />
                  <button
                    type="button"
                    onClick={() => {
                      if (activeTabIndex >= 0) closeTab(activeTabIndex);
                      setIsMoreMenuOpen(false);
                    }}
                    disabled={activeTabIndex < 0}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition disabled:cursor-not-allowed ${ui.moreMenuItem}`}
                    role="menuitem"
                  >
                    <PanelTopClose className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    <span>{label("closeActiveTab", "Close active tab")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      closeAllTabs();
                      setIsMoreMenuOpen(false);
                    }}
                    disabled={openTabs.length === 0}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition disabled:cursor-not-allowed ${ui.moreMenuItem}`}
                    role="menuitem"
                  >
                    <Layers className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    <span>{label("closeAllTabs", "Close all tabs")}</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          <button
            onClick={handleSave}
            disabled={!activeFile || isSaving}
            className={`motion-interactive flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold transition-all duration-200 ${
              activeFile && !isSaving
                ? `${ui.saveReady} cursor-pointer`
                : `${ui.saveDisabled} cursor-not-allowed`
            } ${
              saveStatus === "success"
                ? "bg-green-500/20 hover:bg-green-500/25 text-green-200 border-green-400/30"
                : saveStatus === "error"
                ? "bg-red-500/20 hover:bg-red-500/25 text-red-200 border-red-400/30"
                : ""
            }`}
            title={
              activeFile
                ? `${label("saveFile", "Save file")} (Ctrl+S)`
                : label("noFileSelectedShort", "No file selected")
            }
          >
            {saveStatus === "saving" ? (
              <>
                <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>{label("saving", "Saving...")}</span>
              </>
            ) : saveStatus === "success" ? (
              <>
                <svg
                  className="w-3 h-3"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  ></path>
                </svg>
                <span>{label("saved", "Saved")}</span>
              </>
            ) : saveStatus === "error" ? (
              <>
                <svg
                  className="w-3 h-3"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L10 9.414l1.293-1.293a1 1 0 011.414 1.414L11.414 10l1.293 1.293a1 1 0 01-1.414 1.414L10 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L9.414 10 8.121 8.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  ></path>
                </svg>
                <span>{label("error", "Error")}</span>
              </>
            ) : (
              <>
                <Save className="h-3 w-3" />
                <span>{label("save", "Save")}</span>
              </>
            )}
          </button>

        </div>

        <main className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex w-[46px] shrink-0 p-1.5 pr-0">
            <nav className={`flex h-full w-10 flex-col items-center justify-between py-1.5 ${ui.activityRail}`}>
              <div className="flex flex-col gap-1">
              {[
                { key: "files", icon: FileText, label: label("files", "Files") },
                { key: "search", icon: Search, label: label("search", "Search") },
                { key: "components", icon: Box, label: label("components", "Components") },
                { key: "issues", icon: Bug, label: label("issues", "Issues") },
              ].map((item) => {
                const Icon = item.icon;
                const isActive = activePanel === item.key;

                return (
                  <button
                    key={item.key}
                    className={`motion-icon-interactive relative flex h-7 w-7 items-center justify-center rounded-md border transition ${
                      isActive
                        ? "border-[#4d739a]/80 bg-[#31577d] text-white shadow-[0_4px_10px_rgba(49,87,125,0.12)]"
                        : ui.activityIdle
                    }`}
                    type="button"
                    onClick={() => {
                      setActivePanel(item.key as EditorPanel);
                      setIsExplorerCollapsed(false);
                    }}
                    title={item.label}
                    aria-label={item.label}
                    aria-pressed={isActive}
                  >
                    {isActive && (
                      <span className="absolute -left-1.5 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-[#9cc4ee]" />
                    )}
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                );
              })}
              </div>
              <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={onOpenSubscriptions}
                className="motion-icon-interactive flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-[#d8bd79]/80 transition hover:border-[#d8bd79]/16 hover:bg-[#d8bd79]/8 hover:text-[#f4df9d]"
                title={label("upgrade", "Upgrade")}
                aria-label={label("upgrade", "Upgrade")}
              >
                <Crown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={onOpenSettings}
                className={`motion-icon-interactive flex h-7 w-7 items-center justify-center rounded-md border transition ${ui.settingsAction}`}
                title={label("settings", "Settings")}
                aria-label={label("settings", "Settings")}
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
              </div>
            </nav>
          </div>
          <div
            className={`relative h-full shrink-0 overflow-hidden border-r transition-[width] duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
              isExplorerCollapsed ? "w-[38px]" : "w-[248px]"
            } ${
              isDark
                ? "border-[#333335] bg-[#222223]"
                : "border-slate-200/70 bg-[#fbfdff]"
            }`}
          >
            <aside
              className={`absolute inset-0 flex flex-col items-center px-1.5 py-2 transition-[opacity,transform] duration-[220ms] ease-out ${
                isExplorerCollapsed
                  ? "translate-x-0 opacity-100 delay-100"
                  : "pointer-events-none -translate-x-2 opacity-0"
              }`}
            >
              <button
                type="button"
                onClick={() => setIsExplorerCollapsed(false)}
                className={`motion-icon-interactive flex h-7 w-7 items-center justify-center rounded-md transition ${
                  isDark
                    ? "text-slate-500 hover:bg-[#2a2a2b] hover:text-slate-200"
                    : "text-slate-400 hover:bg-slate-200/70 hover:text-slate-700"
                }`}
                title={label("explorerLayout", "Explorer layout")}
                aria-label={label("explorerLayout", "Explorer layout")}
                aria-expanded={false}
              >
                <PanelLeft className="h-3.5 w-3.5" />
              </button>
            </aside>

            <aside
              className={`absolute inset-0 flex h-full w-[248px] flex-col overflow-hidden transition-[opacity,transform] duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
                isExplorerCollapsed
                  ? "pointer-events-none -translate-x-6 opacity-0"
                  : "translate-x-0 opacity-100 delay-75"
              }`}
            >
              {renderSidebarPanel()}
            </aside>
          </div>
          <Code
            selectedFile={activeFile}
            onChange={handleCodeChange}
            isDark={isDark}
            isVisible={isVisible}
            labels={labels}
          />
        </main>
      </div>
    </div>
  );
};

export default React.memo(CodeEditor);
