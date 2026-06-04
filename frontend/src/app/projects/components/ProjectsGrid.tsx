"use client";

import {
  Calendar,
  ExternalLink,
  MoreHorizontal,
  PencilLine,
  Share2,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Container, deleteContainer, getContainers } from "../../../lib/backend/api";
import type { UiLanguage, UiTheme } from "./ProjectsPage";

interface ProjectsGridProps {
  language: UiLanguage;
  theme: UiTheme;
  variant?: "recent" | "projects";
  searchQuery?: string;
}

interface StoredProjectMetadata {
  title?: string;
  summary?: string;
  prompt?: string;
}

const PROJECT_METADATA_STORAGE_KEY = "december:project-metadata";

const readStoredMetadata = (): Record<string, StoredProjectMetadata> => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PROJECT_METADATA_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, StoredProjectMetadata>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeStoredMetadata = (data: Record<string, StoredProjectMetadata>) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROJECT_METADATA_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
};

const toTitleCase = (value: string) =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

const buildTitleFromPrompt = (prompt: string) => {
  const cleaned = prompt
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Untitled Project";
  return toTitleCase(cleaned);
};

const buildSummaryFromPrompt = (prompt: string) => {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Custom project generated from your prompt.";
  if (cleaned.length <= 120) return cleaned;
  return `${cleaned.slice(0, 117)}...`;
};

const cleanContainerName = (name: string | null | undefined, id: string) => {
  const raw = (name || "").replace(/[\/_-]+/g, " ").trim();
  if (!raw) return `Project ${id.slice(0, 8)}`;
  return toTitleCase(raw);
};

const getThumbnailUrl = (url: string | null) => {
  if (!url) return null;
  return `https://image.thum.io/get/width/1024/noanimate/${encodeURI(url)}`;
};

export const ProjectsGrid = ({
  language,
  theme,
  variant = "projects",
  searchQuery = "",
}: ProjectsGridProps) => {
  const [containers, setContainers] = useState<Container[]>([]);
  const [storedMetadata, setStoredMetadata] = useState<Record<string, StoredProjectMetadata>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [brokenThumbnails, setBrokenThumbnails] = useState<Set<string>>(new Set());
  const dropdownRef = useRef<HTMLDivElement>(null);

  const isDark = theme === "dark";
  const gridClass =
    variant === "recent"
      ? "grid-cols-[repeat(auto-fill,minmax(min(210px,100%),1fr))]"
      : "grid-cols-[repeat(auto-fill,minmax(min(220px,100%),1fr))]";
  const labels = {
    en: {
      noProjects: "No projects yet",
      noProjectsDesc: "Use the prompt above to create your first project.",
      live: "Live",
      draft: "Draft",
      retry: "Retry",
      unableLoad: "Unable to load projects",
      created: "Created",
      delete: "Delete",
      edit: "Edit",
      share: "Share",
      open: "Open",
      searchEmpty: "No project matches your search",
      untitled: "Untitled Project",
      defaultSummary: "Custom project generated from your prompt.",
    },
    tr: {
      noProjects: "Henüz proje yok",
      noProjectsDesc: "İlk projeni oluşturmak için yukarıdaki promptu kullan.",
      live: "Canlı",
      draft: "Taslak",
      retry: "Tekrar dene",
      unableLoad: "Projeler yüklenemedi",
      created: "Oluşturulma",
      delete: "Sil",
      edit: "Düzenle",
      share: "Paylaş",
      open: "Aç",
      searchEmpty: "Aramana uygun proje bulunamadı",
      untitled: "İsimsiz Proje",
      defaultSummary: "Promptundan oluşturulmuş özel proje.",
    },
  }[language];

  const fetchContainers = async () => {
    try {
      setError(null);
      const data = await getContainers();
      setContainers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch projects");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setStoredMetadata(readStoredMetadata());
    fetchContainers();
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setDropdownOpen(null);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleDeleteContainer = async (container: Container) => {
    if (!window.confirm(language === "tr" ? "Projeyi silmek istediğine emin misin?" : "Are you sure you want to delete this project?")) {
      return;
    }
    setActionLoading(container.id);
    try {
      await deleteContainer(container.id);
      const nextMeta = { ...storedMetadata };
      delete nextMeta[container.id];
      setStoredMetadata(nextMeta);
      writeStoredMetadata(nextMeta);
      await fetchContainers();
    } catch (deleteError) {
      console.error("Failed to delete container:", deleteError);
    } finally {
      setActionLoading(null);
      setDropdownOpen(null);
    }
  };

  const handleEditProject = (container: Container, currentTitle: string) => {
    const nextTitle = window.prompt(
      language === "tr" ? "Yeni proje başlığını gir" : "Enter a new project title",
      currentTitle
    );
    if (!nextTitle) return;
    const normalized = nextTitle.trim().slice(0, 70);
    if (!normalized) return;
    const nextMeta = {
      ...storedMetadata,
      [container.id]: {
        ...storedMetadata[container.id],
        title: normalized,
      },
    };
    setStoredMetadata(nextMeta);
    writeStoredMetadata(nextMeta);
    setDropdownOpen(null);
  };

  const handleShareProject = async (container: Container) => {
    try {
      const projectUrl = `${window.location.origin}/projects/${container.id}`;
      await navigator.clipboard.writeText(projectUrl);
    } catch {
      // ignore
    } finally {
      setDropdownOpen(null);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(
      language === "tr" ? "tr-TR" : "en-US",
      {
        month: "short",
        day: "numeric",
        year: "numeric",
      }
    );
  };

  const projectCards = useMemo(() => {
    return containers.map((container) => {
      const saved = storedMetadata[container.id];
      const promptFromLabel =
        container.labels?.prompt ||
        container.labels?.description ||
        container.labels?.title ||
        "";
      const seedPrompt = saved?.prompt || promptFromLabel;
      const title =
        saved?.title ||
        (seedPrompt ? buildTitleFromPrompt(seedPrompt) : cleanContainerName(container.name, container.id)) ||
        labels.untitled;
      const summary =
        saved?.summary ||
        (seedPrompt ? buildSummaryFromPrompt(seedPrompt) : labels.defaultSummary);
      return {
        container,
        title,
        summary,
      };
    });
  }, [containers, storedMetadata, labels.defaultSummary, labels.untitled]);

  const filteredCards = useMemo(() => {
    if (variant !== "projects") return projectCards.slice(0, 6);
    const query = searchQuery.trim().toLowerCase();
    if (!query) return projectCards;
    return projectCards.filter(({ title, summary, container }) => {
      const haystack = `${title} ${summary} ${container.name || ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [projectCards, searchQuery, variant]);

  const renderPreview = (container: Container, cardTitle: string) => {
    const thumbUrl = getThumbnailUrl(container.url);
    const isBroken = brokenThumbnails.has(container.id);
    if (!thumbUrl || isBroken) {
      return (
        <div className={`flex h-full w-full items-center justify-center ${isDark ? "bg-[#222223]" : "bg-[#eef2f8]"}`}>
          <span className={`text-xs font-semibold ${isDark ? "text-slate-300" : "text-slate-600"}`}>
            {cardTitle.slice(0, 20)}
          </span>
        </div>
      );
    }

    return (
      <img
        src={thumbUrl}
        alt={`${cardTitle} preview`}
        className="h-full w-full object-cover"
        loading="lazy"
        onError={() => {
          setBrokenThumbnails((prev) => new Set(prev).add(container.id));
        }}
      />
    );
  };

  if (isLoading) {
    return (
      <div className={`grid gap-3 ${gridClass}`}>
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={`motion-skeleton rounded-2xl border ${isDark ? "border-[#343840] bg-[#1e1e1f]" : "border-[#d7d9de] bg-[#ffffff]"}`}
          >
            <div className="aspect-square" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center">
        <p className="text-lg font-semibold text-red-700">{labels.unableLoad}</p>
        <p className="mt-1 text-sm text-red-600">{error}</p>
        <button
          onClick={fetchContainers}
          className="motion-interactive mt-4 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 transition-colors duration-150 hover:bg-red-100"
          type="button"
        >
          {labels.retry}
        </button>
      </div>
    );
  }

  if (filteredCards.length === 0) {
    return (
      <div
        className={`rounded-2xl border p-8 text-center ${
          isDark ? "border-[#343840] bg-[#1e1e1f]" : "border-[#d7d9de] bg-[#ffffff]"
        }`}
      >
        <h3 className={`text-base font-semibold ${isDark ? "text-slate-100" : "text-slate-700"}`}>
          {searchQuery ? labels.searchEmpty : labels.noProjects}
        </h3>
        {!searchQuery && (
          <p className={`mt-1 text-[12px] ${isDark ? "text-slate-300" : "text-slate-500"}`}>
            {labels.noProjectsDesc}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={`grid gap-3 ${gridClass}`}>
      {filteredCards.map(({ container, title, summary }) => (
        <article
          key={container.id}
          className={`motion-card overflow-hidden rounded-2xl border ${
            isDark ? "border-[#343840] bg-[#1e1e1f]" : "border-[#d6d8de] bg-[#ffffff]"
          }`}
        >
          <a
            href={`/projects/${container.id}`}
            className="block aspect-square overflow-hidden"
          >
            {renderPreview(container, title)}
          </a>

          <div className="space-y-3 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className={`line-clamp-1 text-[14px] font-semibold ${isDark ? "text-slate-100" : "text-slate-700"}`}>{title}</p>
                <p className={`mt-1 line-clamp-2 text-[12px] ${isDark ? "text-slate-300" : "text-slate-500"}`}>{summary}</p>
              </div>
              <div className="relative" ref={dropdownOpen === container.id ? dropdownRef : undefined}>
                <button
                  className={`motion-icon-interactive rounded-md p-1.5 transition-colors duration-150 ${
                    isDark ? "text-slate-300 hover:bg-[#262930]" : "text-slate-500 hover:bg-[#f4f6fa]"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDropdownOpen(dropdownOpen === container.id ? null : container.id);
                  }}
                  type="button"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>

                {dropdownOpen === container.id && (
                  <div
                    className={`motion-dropdown-panel absolute right-0 top-full z-20 mt-1 w-40 rounded-lg border py-1 shadow-lg ${
                      isDark ? "border-[#3a3d46] bg-[#1e1e1f]" : "border-[#d4d8de] bg-white"
                    }`}
                  >
                    <button
                      onClick={() => handleEditProject(container, title)}
                      className={`motion-list-item flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                        isDark ? "text-slate-100 hover:bg-[#262930]" : "text-slate-700 hover:bg-slate-100"
                      }`}
                      type="button"
                    >
                      <PencilLine className="h-3.5 w-3.5" />
                      {labels.edit}
                    </button>
                    <button
                      onClick={() => handleShareProject(container)}
                      className={`motion-list-item flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                        isDark ? "text-slate-100 hover:bg-[#262930]" : "text-slate-700 hover:bg-slate-100"
                      }`}
                      type="button"
                    >
                      <Share2 className="h-3.5 w-3.5" />
                      {labels.share}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteContainer(container);
                      }}
                      disabled={actionLoading === container.id}
                      className={`motion-list-item flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:opacity-50 ${
                        isDark ? "text-red-400 hover:bg-[#262930]" : "text-red-600 hover:bg-red-50"
                      }`}
                      type="button"
                    >
                      {actionLoading === container.id ? (
                        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      {labels.delete}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className={`inline-flex items-center gap-1 text-[11px] ${isDark ? "text-slate-300" : "text-slate-500"}`}>
                <Calendar className="h-3 w-3" />
                {labels.created} {formatDate(container.created)}
              </div>
              <a
                href={`/projects/${container.id}`}
                className={`motion-interactive inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] ${
                  isDark ? "border-[#3a3d46] bg-[#1e1e1f] text-slate-100 hover:bg-[#262930]" : "border-[#d0d2d7] bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <ExternalLink className="h-3 w-3" />
                {labels.open}
              </a>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
};
