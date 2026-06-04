"use client";

import { memo, useEffect, useState } from "react";
import { Container, getContainers } from "../../../lib/backend/api";

interface LivePreviewProps {
  containerId: string;
  isDesktopView?: boolean;
  isDark?: boolean;
  labels?: Partial<Record<string, string>>;
}

const PREVIEW_CACHE_TTL_MS = 4000;
const PREVIEW_REFRESH_MS = 12000;
const PREVIEW_STORAGE_PREFIX = "december:preview-container:";

const previewContainerCache = new Map<string, Container>();
let containersRequest: Promise<Container[]> | null = null;
let containersFetchedAt = 0;

const getStoredPreviewContainer = (containerId: string): Container | null => {
  if (typeof window === "undefined") return null;

  try {
    const rawValue = window.localStorage.getItem(
      `${PREVIEW_STORAGE_PREFIX}${containerId}`
    );
    if (!rawValue) return null;

    const parsedValue = JSON.parse(rawValue) as Container;
    return parsedValue?.id === containerId && parsedValue.url
      ? parsedValue
      : null;
  } catch {
    return null;
  }
};

const storePreviewContainer = (container: Container) => {
  previewContainerCache.set(container.id, container);

  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      `${PREVIEW_STORAGE_PREFIX}${container.id}`,
      JSON.stringify(container)
    );
  } catch {
    // Preview cache is a speed hint only; failing storage should not block UI.
  }
};

const getCachedContainers = async (force = false) => {
  const now = Date.now();
  const isFresh = now - containersFetchedAt < PREVIEW_CACHE_TTL_MS;

  if (!force && containersRequest && isFresh) {
    return containersRequest;
  }

  containersRequest = getContainers().then((containers) => {
    containersFetchedAt = Date.now();
    containers.forEach(storePreviewContainer);
    return containers;
  });

  return containersRequest;
};

const createFallbackPreviewContainer = (containerId: string): Container | null => {
  const storedContainer = getStoredPreviewContainer(containerId);
  if (storedContainer) {
    previewContainerCache.set(containerId, storedContainer);
    return storedContainer;
  }

  return previewContainerCache.get(containerId) ?? null;
};

const LivePreviewComponent = ({
  containerId,
  isDesktopView = true,
  isDark = true,
  labels = {},
}: LivePreviewProps) => {
  const [container, setContainer] = useState<Container | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const label = (key: string, fallback: string) => labels[key] || fallback;
  const shellClass = isDark
    ? "bg-[#222223] border-[#3a3a3c]"
    : "bg-white/78 border-slate-200/80 shadow-[0_18px_48px_rgba(49,87,125,0.1)]";
  const glowClass = isDark
    ? "bg-gradient-to-br from-[#222223] via-transparent to-[#222223]"
    : "bg-gradient-to-br from-sky-100/70 via-transparent to-white/20";
  const mutedText = isDark ? "text-white/60" : "text-slate-500";
  const strongText = isDark ? "text-white" : "text-slate-900";
  const chipClass = isDark
    ? "border-gray-600/40 bg-gray-700/40 text-white/40"
    : "border-slate-200/80 bg-white/80 text-slate-500";

  useEffect(() => {
    let isActive = true;
    const cachedContainer = createFallbackPreviewContainer(containerId);

    if (cachedContainer) {
      setContainer(cachedContainer);
      setIsLoading(false);
      setError(null);
    } else {
      setContainer(null);
      setIsLoading(true);
    }

    const fetchContainer = async (force = false) => {
      try {
        const containers = await getCachedContainers(force);
        const foundContainer = containers.find((c) => c.id === containerId);

        if (!isActive) return;

        if (!foundContainer) {
          if (!cachedContainer) {
            setError(label("containerNotFound", "Container not found"));
          }
          return;
        }

        storePreviewContainer(foundContainer);
        setContainer(foundContainer);
        setError(null);
      } catch (err) {
        if (!isActive) return;

        if (!cachedContainer) {
          setError(
            err instanceof Error ? err.message : "Failed to fetch container"
          );
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    };

    fetchContainer(false);
    const interval = window.setInterval(
      () => fetchContainer(true),
      PREVIEW_REFRESH_MS
    );

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [containerId]);

  if (isLoading) {
    return (
      <div className={`w-full h-full backdrop-blur-sm rounded-lg border flex items-center justify-center relative ${shellClass}`}>
        <div className={`absolute inset-0 rounded-lg ${glowClass}`} />
        <div className="flex flex-col items-center gap-4 relative z-10">
          <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <span className={`font-medium ${mutedText}`}>
            {label("loadingPreview", "Loading preview...")}
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`w-full h-full backdrop-blur-sm rounded-lg border flex items-center justify-center relative ${shellClass}`}>
        <div className={`absolute inset-0 rounded-lg ${glowClass}`} />
        <div className="text-center relative z-10">
          <div className="text-red-400 text-lg font-semibold mb-2">
            {label("previewError", "Preview Error")}
          </div>
          <div className={mutedText}>{error}</div>
        </div>
      </div>
    );
  }

  if (!container) {
    return (
      <div className={`w-full h-full backdrop-blur-sm rounded-lg border flex items-center justify-center relative ${shellClass}`}>
        <div className={`absolute inset-0 rounded-lg ${glowClass}`} />
        <div className="text-center relative z-10">
          <div className={`text-lg ${mutedText}`}>
            {label("containerNotFound", "Container not found")}
          </div>
        </div>
      </div>
    );
  }

  if (container.status !== "running" || !container.url) {
    return (
      <div className={`w-full h-full backdrop-blur-sm rounded-lg border flex items-center justify-center relative ${shellClass}`}>
        <div className={`absolute inset-0 rounded-lg ${glowClass}`} />
        <div className="text-center max-w-md relative z-10">
          <div className={`w-16 h-16 backdrop-blur-sm rounded-full mx-auto mb-6 flex items-center justify-center border shadow-sm ${isDark ? "border-[#3a3a3c] bg-[#222223]" : "border-slate-200 bg-white/80"}`}>
            <svg
              className={`w-8 h-8 ${isDark ? "text-white/50" : "text-slate-400"}`}
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <h1 className={`text-2xl font-bold mb-4 ${strongText}`}>
            {label("containerNotRunning", "Container Not Running")}
          </h1>
          <p className={`mb-6 ${mutedText}`}>
            {label("startContainerPreview", "Start the container to see the live preview")}
          </p>
          <div className={`text-sm backdrop-blur-sm px-3 py-2 rounded-lg border ${chipClass}`}>
            {label("status", "Status")}: <span className="font-mono">{container.status}</span>
          </div>
        </div>
      </div>
    );
  }

  const previewContainer = (
    <div className="relative h-full w-full overflow-hidden bg-white">
      <iframe
        src={container.url}
        data-live-preview-frame="true"
        loading="eager"
        className="absolute inset-0 h-full w-full border-0"
        title={`Preview of ${container.name || container.id}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      />
    </div>
  );

  if (isDesktopView) {
    return previewContainer;
  }

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-zinc-900/10 p-4">
      <div
        className="relative aspect-[390/844] max-h-full max-w-full rounded-[3.2rem] border border-slate-950/80 bg-gradient-to-br from-slate-800 via-slate-950 to-black p-3 shadow-[0_28px_80px_rgba(15,23,42,0.32)]"
        style={{
          height: "min(calc(100% - 1rem), 760px)",
        }}
      >
        <div className="absolute -left-1 top-28 h-12 w-1 rounded-l-full bg-slate-800" />
        <div className="absolute -left-1 top-44 h-16 w-1 rounded-l-full bg-slate-800" />
        <div className="absolute -right-1 top-36 h-20 w-1 rounded-r-full bg-slate-800" />
        <div className="absolute inset-1 rounded-[2.9rem] border border-white/10 bg-slate-900/70" />

        <div className="relative z-10 h-full w-full overflow-hidden rounded-[2.45rem] bg-white">
          <div className="absolute left-1/2 top-0 z-20 h-7 w-28 -translate-x-1/2 rounded-b-2xl bg-slate-950 shadow-sm" />
          <div className="pointer-events-none absolute inset-0 z-20 rounded-[2.45rem] ring-1 ring-inset ring-black/10" />
          <iframe
            src={container.url}
            data-live-preview-frame="true"
            loading="eager"
            className="h-full w-full border-0"
            title={`Mobile Preview of ${container.name || container.id}`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        </div>
      </div>
    </div>
  );
};

export const LivePreview = memo(LivePreviewComponent);
