"use client";

import {
  ArrowRight,
  Calendar,
  ExternalLink,
  Grid3X3,
  Heart,
  ListFilter,
  Search,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createClient as createSupabaseClient } from "@/lib/supabase/client";
import { fetchAccountSnapshot } from "@/lib/account/client";
import type { AccountSnapshot } from "@/lib/account/types";
import { ProjectPromptInterface } from "./ProjectPromptInterface";
import { ProjectsGrid } from "./ProjectsGrid";
import { ProjectsLayout } from "./ProjectsLayout";

export type UiTheme = "light" | "dark";
export type UiLanguage = "en" | "tr";
export type UiSection = "home" | "projects" | "published";

const fallbackAccountName = "kaichen";
const UI_THEME_STORAGE_KEY = "december:ui-theme";
const UI_LANGUAGE_STORAGE_KEY = "december:ui-language";

const isUiTheme = (value: string | null): value is UiTheme => value === "light" || value === "dark";
const isUiLanguage = (value: string | null): value is UiLanguage => value === "en" || value === "tr";

const detectBrowserTheme = (): UiTheme => {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const detectBrowserLanguage = (): UiLanguage => {
  if (typeof navigator === "undefined") return "en";
  const primaryLanguage = (navigator.languages?.[0] || navigator.language || "en").toLowerCase();
  return primaryLanguage.startsWith("tr") ? "tr" : "en";
};

const resolveInitialTheme = (): UiTheme => {
  if (typeof window === "undefined") return "light";
  const storedTheme = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
  return isUiTheme(storedTheme) ? storedTheme : detectBrowserTheme();
};

const resolveInitialLanguage = (): UiLanguage => {
  if (typeof window === "undefined") return "en";
  const storedLanguage = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
  return isUiLanguage(storedLanguage) ? storedLanguage : detectBrowserLanguage();
};

interface SharedProject {
  id: string;
  title: string;
  summary: string;
  author: string;
  likes: number;
  sharedAt: string;
  category: string;
  previewUrl: string;
}

const sharedProjectPresets = [
  {
    title: "SaaS Analytics Dashboard",
    summary: "A polished analytics panel with subscription KPIs and team activity widgets.",
    category: "Dashboard",
  },
  {
    title: "Luxury Jewelry Storefront",
    summary: "A premium e-commerce homepage focused on storytelling and high-converting product blocks.",
    category: "E-commerce",
  },
  {
    title: "Legal Consultancy Landing",
    summary: "Trust-focused law firm landing page with consultation flow and case highlights.",
    category: "Landing",
  },
  {
    title: "AI Portfolio Studio",
    summary: "Personal portfolio website with project storytelling and interactive case studies.",
    category: "Portfolio",
  },
  {
    title: "Fintech Expense Planner",
    summary: "Simple yet elegant finance planner for budget tracking and recurring payments.",
    category: "Fintech",
  },
  {
    title: "Real Estate Listing Pro",
    summary: "Property listing app with map-focused browsing and responsive card experiences.",
    category: "Marketplace",
  },
  {
    title: "Clinic Appointment Portal",
    summary: "Healthcare booking experience with doctor profiles and appointment time slots.",
    category: "Healthcare",
  },
  {
    title: "Restaurant Reservation Hub",
    summary: "Reservation-first restaurant website with menu preview and table availability.",
    category: "Hospitality",
  },
];

const sharedProjectAuthors = [
  "Aylin K.",
  "Mert U.",
  "Elif N.",
  "Burak T.",
  "Selen P.",
  "Deniz A.",
  "Ece Y.",
  "Kerem D.",
  "Lara C.",
];

const generateSharedProjects = (): SharedProject[] => {
  const now = Date.now();
  const rows = sharedProjectPresets.map((preset, index) => {
    const randomLikeBase = 40 + Math.floor(Math.random() * 360);
    const randomHoursAgo = 2 + Math.floor(Math.random() * 320);
    const author = sharedProjectAuthors[Math.floor(Math.random() * sharedProjectAuthors.length)];
    return {
      id: `shared-${index + 1}`,
      title: preset.title,
      summary: preset.summary,
      author,
      likes: randomLikeBase,
      category: preset.category,
      sharedAt: new Date(now - randomHoursAgo * 60 * 60 * 1000).toISOString(),
      previewUrl: `https://picsum.photos/seed/december-shared-${index + 1}/900/900`,
    };
  });

  return rows.sort(() => Math.random() - 0.5);
};

const sanitizeAccountName = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Ignore non-name payloads (e.g. data URLs accidentally stored in localStorage).
  if (
    trimmed.startsWith("data:") ||
    trimmed.length > 80 ||
    /base64,/i.test(trimmed)
  ) {
    return null;
  }
  if (trimmed.includes("@")) {
    const local = trimmed.split("@")[0]?.trim();
    return local || null;
  }
  return trimmed;
};

const parseStoredName = (raw: string): string | null => {
  const normalized = sanitizeAccountName(raw);
  if (normalized) return normalized;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const keys = [
      "name",
      "fullName",
      "displayName",
      "username",
      "userName",
      "email",
    ];
    for (const key of keys) {
      const candidate = sanitizeAccountName(parsed[key] as string | undefined);
      if (candidate) return candidate;
    }
  } catch {
    return null;
  }

  return null;
};

const resolveAccountName = (): string => {
  if (typeof window === "undefined") return fallbackAccountName;

  const directKeys = ["name", "fullName", "displayName", "username", "userName", "email"];
  for (const key of directKeys) {
    const value = sanitizeAccountName(window.localStorage.getItem(key));
    if (value) return value;
  }

  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key) continue;

    const keyLower = key.toLowerCase();
    if (!/(user|auth|profile|account|session)/.test(keyLower)) continue;

    const raw = window.localStorage.getItem(key);
    if (!raw) continue;

    const fromStored = parseStoredName(raw);
    if (fromStored) return fromStored;
  }

  return fallbackAccountName;
};

const resolveAccountNameFromAuth = async (): Promise<string> => {
  const supabase = createSupabaseClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return resolveAccountName();
  }

  const metadataName = sanitizeAccountName(
    (user.user_metadata?.name as string | undefined) ||
      (user.user_metadata?.full_name as string | undefined) ||
      (user.user_metadata?.display_name as string | undefined) ||
      (user.user_metadata?.username as string | undefined)
  );

  if (metadataName) return metadataName;

  const emailName = sanitizeAccountName(user.email);
  if (emailName) return emailName.includes("@") ? emailName.split("@")[0] : emailName;

  return fallbackAccountName;
};

export const ProjectsPage = () => {
  const [theme, setThemeState] = useState<UiTheme>(resolveInitialTheme);
  const [language, setLanguageState] = useState<UiLanguage>(resolveInitialLanguage);
  const [activeSection, setActiveSection] = useState<UiSection>("home");
  const [searchQuery, setSearchQuery] = useState("");
  const [publishedSearchQuery, setPublishedSearchQuery] = useState("");
  const [accountName, setAccountName] = useState(fallbackAccountName);
  const [accountSnapshot, setAccountSnapshot] = useState<AccountSnapshot | null>(null);
  const [likedSharedProjectIds, setLikedSharedProjectIds] = useState<string[]>([]);
  const isDark = theme === "dark";
  const sharedProjects = useMemo(() => generateSharedProjects(), []);

  const setTheme = (nextTheme: UiTheme) => {
    setThemeState(nextTheme);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(UI_THEME_STORAGE_KEY, nextTheme);
    }
  };

  const setLanguage = (nextLanguage: UiLanguage) => {
    setLanguageState(nextLanguage);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, nextLanguage);
    }
  };

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.style.colorScheme = theme;
  }, [language, theme]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isUiTheme(window.localStorage.getItem(UI_THEME_STORAGE_KEY))) return;

    const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mediaQuery) return;

    const handleSystemThemeChange = (event: MediaQueryListEvent) => {
      if (!isUiTheme(window.localStorage.getItem(UI_THEME_STORAGE_KEY))) {
        setThemeState(event.matches ? "dark" : "light");
      }
    };

    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, []);

  useEffect(() => {
    let isMounted = true;
    const supabase = createSupabaseClient();

    const syncAccount = async () => {
      const snapshot = await fetchAccountSnapshot();
      if (!isMounted) return;
      setAccountSnapshot(snapshot);
      setAccountName(
        snapshot.profile.isAuthenticated
          ? snapshot.profile.displayName
          : resolveAccountName()
      );
    };

    syncAccount().catch(async () => {
      if (!isMounted) return;
      setAccountName(await resolveAccountNameFromAuth());
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      syncAccount();
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const labels = useMemo(
    () =>
      ({
        en: {
          recentProjects: "Your recent Projects",
          viewAll: "View All",
          workspace: `${accountName}'s Workspace`,
          projectsTitle: "Projects",
          search: "Search",
          anyStatus: "Any status",
          anyAccess: "Any access",
          anyBuildType: "Any build type",
          allProjects: "All projects",
          publishedTitle: "Published Projects",
          publishedSubtitle:
            "Discover community projects shared by other builders. Explore ideas, trends, and design styles.",
          sharedBy: "Shared by",
          sharedOn: "Shared on",
          likes: "likes",
          openProject: "Open preview",
          noPublishedResult: "No published project matches your search.",
          communityFeed: "Community feed",
        },
        tr: {
          recentProjects: "Son Projelerin",
          viewAll: "T\u00fcm\u00fcn\u00fc G\u00f6r",
          workspace: `${accountName} \u00c7al\u0131\u015fma Alan\u0131`,
          projectsTitle: "Projeler",
          search: "Ara",
          anyStatus: "T\u00fcm durumlar",
          anyAccess: "T\u00fcm eri\u015fimler",
          anyBuildType: "T\u00fcm build t\u00fcrleri",
          allProjects: "T\u00fcm projeler",
          publishedTitle: "Payla\u015f\u0131lan Projeler",
          publishedSubtitle:
            "Di\u011fer kullan\u0131c\u0131lar\u0131n payla\u015ft\u0131\u011f\u0131 topluluk projelerini ke\u015ffet. Fikirleri, trendleri ve tasar\u0131m stillerini incele.",
          sharedBy: "Payla\u015fan",
          sharedOn: "Payla\u015f\u0131m tarihi",
          likes: "be\u011feni",
          openProject: "\u00d6nizlemeyi a\u00e7",
          noPublishedResult: "Aramana uygun payla\u015f\u0131lm\u0131\u015f proje bulunamad\u0131.",
          communityFeed: "Topluluk ak\u0131\u015f\u0131",
        },
      })[language],
    [accountName, language]
  );

  const filteredSharedProjects = useMemo(() => {
    const query = publishedSearchQuery.trim().toLowerCase();
    if (!query) return sharedProjects;
    return sharedProjects.filter((project) =>
      `${project.title} ${project.summary} ${project.author} ${project.category}`
        .toLowerCase()
        .includes(query)
    );
  }, [publishedSearchQuery, sharedProjects]);

  const toggleLikeSharedProject = (projectId: string) => {
    setLikedSharedProjectIds((prev) =>
      prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId]
    );
  };

  const formatSharedDate = (value: string) =>
    new Date(value).toLocaleDateString(language === "tr" ? "tr-TR" : "en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  return (
    <ProjectsLayout
      theme={theme}
      setTheme={setTheme}
      language={language}
      setLanguage={setLanguage}
      accountName={accountName}
      accountSnapshot={accountSnapshot}
      activeSection={activeSection}
      setActiveSection={setActiveSection}
    >
      {activeSection === "home" && (
        <>
          <ProjectPromptInterface language={language} theme={theme} accountName={accountName} />

          <section className={`mt-28 sm:mt-44 ${isDark ? "text-slate-200" : "text-slate-800"}`}>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <h2
                className={`text-[22px] font-semibold tracking-tight sm:text-[26px] ${
                  isDark ? "text-slate-100" : "text-slate-700"
                }`}
              >
                {labels.recentProjects}
              </h2>
              <button
                type="button"
                onClick={() => setActiveSection("projects")}
                className={`motion-interactive inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[12px] transition-colors duration-150 ${
                  isDark
                    ? "border-[#3a3d46] bg-[#1e1e1f] text-slate-200 hover:bg-[#1e1e1f]"
                    : "border-[#d2d4d8] bg-[#ffffff] text-slate-700 hover:bg-white"
                }`}
              >
                {labels.viewAll}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>

            <ProjectsGrid language={language} theme={theme} variant="recent" />
          </section>
        </>
      )}

      {activeSection === "projects" && (
        <section className={`pt-24 sm:pt-28 ${isDark ? "text-slate-100" : "text-slate-800"}`}>
          <div className="mb-4 flex items-center justify-between">
            <h2
              className={`inline-flex items-center gap-2 text-[28px] font-semibold sm:text-[36px] ${
                isDark ? "text-slate-100" : "text-slate-700"
              }`}
            >
              <Grid3X3 className="h-6 w-6 sm:h-7 sm:w-7" />
              {labels.projectsTitle}
            </h2>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label
              className={`inline-flex w-full items-center justify-between rounded-lg border px-3 py-2 text-[13px] sm:w-auto sm:min-w-[200px] ${
                isDark
                  ? "border-[#3a3d46] bg-[#1e1e1f] text-slate-200"
                  : "border-[#d2d4d8] bg-[#ffffff] text-slate-700"
              }`}
            >
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={labels.search}
                className={`motion-input w-full bg-transparent text-[13px] outline-none placeholder:opacity-70 ${
                  isDark ? "text-slate-100 placeholder:text-slate-400" : "text-slate-700 placeholder:text-slate-500"
                }`}
              />
              <Search className="h-4 w-4" />
            </label>

            {[labels.anyStatus, labels.anyAccess, labels.anyBuildType].map((item) => (
              <button
                key={item}
                type="button"
                className={`motion-interactive rounded-lg border px-3 py-2 text-[13px] transition-colors duration-150 ${
                  isDark
                    ? "border-[#3a3d46] bg-[#1e1e1f] text-slate-200 hover:bg-[#1e1e1f]"
                    : "border-[#d2d4d8] bg-[#ffffff] text-slate-700 hover:bg-white"
                }`}
              >
                {item}
              </button>
            ))}

            <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
              <button
                type="button"
                className={`motion-interactive inline-flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-[13px] sm:w-auto ${
                  isDark
                    ? "border-[#3a3d46] bg-[#1e1e1f] text-slate-200"
                    : "border-[#d2d4d8] bg-[#ffffff] text-slate-700"
                }`}
              >
                <ListFilter className="h-4 w-4" />
                {labels.allProjects}
              </button>
            </div>
          </div>

          <ProjectsGrid
            language={language}
            theme={theme}
            variant="projects"
            searchQuery={searchQuery}
          />
        </section>
      )}

      {activeSection === "published" && (
        <section className={`pt-24 sm:pt-28 ${isDark ? "text-slate-100" : "text-slate-800"}`}>
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2
                className={`inline-flex items-center gap-2 text-[28px] font-semibold sm:text-[36px] ${
                  isDark ? "text-slate-100" : "text-slate-700"
                }`}
              >
                <Sparkles className="h-6 w-6 sm:h-7 sm:w-7" />
                {labels.publishedTitle}
              </h2>
              <p className={`mt-2 max-w-2xl text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>
                {labels.publishedSubtitle}
              </p>
            </div>

            <div
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] ${
                isDark ? "border-[#3a3d46] bg-[#1e1e1f] text-slate-300" : "border-[#d2d4d8] bg-white text-slate-600"
              }`}
            >
              <ListFilter className="h-3.5 w-3.5" />
              {labels.communityFeed}
            </div>
          </div>

          <div className="mb-5 flex flex-wrap items-center gap-3">
            <label
              className={`inline-flex w-full items-center justify-between rounded-lg border px-3 py-2 text-[13px] sm:w-auto sm:min-w-[220px] ${
                isDark
                  ? "border-[#3a3d46] bg-[#1e1e1f] text-slate-200"
                  : "border-[#d2d4d8] bg-[#ffffff] text-slate-700"
              }`}
            >
              <input
                type="search"
                value={publishedSearchQuery}
                onChange={(event) => setPublishedSearchQuery(event.target.value)}
                placeholder={labels.search}
                className={`motion-input w-full bg-transparent text-[13px] outline-none placeholder:opacity-70 ${
                  isDark ? "text-slate-100 placeholder:text-slate-400" : "text-slate-700 placeholder:text-slate-500"
                }`}
              />
              <Search className="h-4 w-4" />
            </label>
          </div>

          {filteredSharedProjects.length === 0 ? (
            <div
              className={`rounded-2xl border p-8 text-center ${
                isDark ? "border-[#343840] bg-[#1e1e1f]" : "border-[#d7d9de] bg-[#ffffff]"
              }`}
            >
              <p className={`text-[14px] font-medium ${isDark ? "text-slate-200" : "text-slate-700"}`}>
                {labels.noPublishedResult}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(220px,100%),1fr))] gap-3">
              {filteredSharedProjects.map((project) => {
                const isLiked = likedSharedProjectIds.includes(project.id);
                const liveLikes = project.likes + (isLiked ? 1 : 0);

                return (
                  <article
                    key={project.id}
                    className={`motion-card overflow-hidden rounded-2xl border ${
                      isDark ? "border-[#343840] bg-[#1e1e1f]" : "border-[#d6d8de] bg-[#ffffff]"
                    }`}
                  >
                    <div className="relative aspect-square overflow-hidden">
                      <img
                        src={project.previewUrl}
                        alt={`${project.title} preview`}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                      <span className="absolute left-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
                        {project.category}
                      </span>
                    </div>

                    <div className="space-y-3 p-3">
                      <div>
                        <p className={`line-clamp-1 text-[14px] font-semibold ${isDark ? "text-slate-100" : "text-slate-700"}`}>
                          {project.title}
                        </p>
                        <p className={`mt-1 line-clamp-2 text-[12px] ${isDark ? "text-slate-300" : "text-slate-500"}`}>
                          {project.summary}
                        </p>
                      </div>

                      <div className={`space-y-1 text-[11px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                        <p className="inline-flex items-center gap-1.5">
                          <UserRound className="h-3.5 w-3.5" />
                          {labels.sharedBy}: {project.author}
                        </p>
                        <p className="inline-flex items-center gap-1.5">
                          <Calendar className="h-3.5 w-3.5" />
                          {labels.sharedOn}: {formatSharedDate(project.sharedAt)}
                        </p>
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => toggleLikeSharedProject(project.id)}
                          className={`motion-interactive inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] ${
                            isLiked
                              ? "border-[#ef4444]/50 bg-[#ef4444]/10 text-[#ef4444]"
                              : isDark
                                ? "border-[#3a3d46] bg-[#1e1e1f] text-slate-200 hover:bg-[#262930]"
                                : "border-[#d0d2d7] bg-white text-slate-700 hover:bg-slate-50"
                          }`}
                        >
                          <Heart className={`h-3.5 w-3.5 ${isLiked ? "fill-current" : ""}`} />
                          {liveLikes} {labels.likes}
                        </button>

                        <button
                          type="button"
                          className={`motion-interactive inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] ${
                            isDark
                              ? "border-[#3a3d46] bg-[#1e1e1f] text-slate-100 hover:bg-[#262930]"
                              : "border-[#d0d2d7] bg-white text-slate-700 hover:bg-slate-50"
                          }`}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {labels.openProject}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </ProjectsLayout>
  );
};
