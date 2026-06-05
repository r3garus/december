"use client";

import { ArrowUp, Check, ImagePlus, Plus, RefreshCcw, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { createContainer } from "../../../lib/backend/api";
import type { UiLanguage, UiTheme } from "./ProjectsPage";

interface ProjectPromptInterfaceProps {
  language: UiLanguage;
  theme: UiTheme;
  accountName: string;
}

interface StoredProjectMetadata {
  title?: string;
  summary?: string;
  prompt?: string;
}

const PROJECT_METADATA_STORAGE_KEY = "december:project-metadata";
const BUILD_INTENT_TERMS = [
  "yap",
  "yapalim",
  "olustur",
  "ekle",
  "degistir",
  "duzelt",
  "kaldir",
  "sil",
  "tasarla",
  "kodla",
  "guncelle",
  "site",
  "website",
  "sayfa",
  "panel",
  "dashboard",
  "landing",
  "app",
  "build",
  "create",
  "make",
  "add",
  "change",
  "update",
  "fix",
  "remove",
  "design",
  "implement",
];
const QUESTION_STARTERS = [
  "ne",
  "nasil",
  "neden",
  "niye",
  "hangi",
  "sence",
  "what",
  "why",
  "how",
  "which",
  "can",
  "could",
  "should",
];
const GREETING_TERMS = ["merhaba", "selam", "slm", "sa", "hello", "hi", "hey", "naber"];

const animatedPrompts = [
  "Design a modern marketing website for my startup...",
  "Build a professional law firm website for me...",
  "Create a clean portfolio site for a product designer...",
  "Generate a landing page for an AI SaaS product...",
  "Build an e-commerce homepage for a fashion brand...",
];

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

const normalizeBuildIntentText = (value: string) =>
  value
    .toLocaleLowerCase("tr-TR")
    .replace(/\u0131/g, "i")
    .replace(/\u015f/g, "s")
    .replace(/\u011f/g, "g")
    .replace(/\u00fc/g, "u")
    .replace(/\u00f6/g, "o")
    .replace(/\u00e7/g, "c")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const hasProjectBuildIntent = (prompt: string) => {
  const normalized = normalizeBuildIntentText(prompt);
  if (!normalized) return false;
  if (normalized.length >= 90) return true;

  return BUILD_INTENT_TERMS.some((term) =>
    new RegExp(`(^|\\s)${term}(\\s|$)`).test(normalized)
  );
};

const isQuestionLikePrompt = (prompt: string) => {
  const normalized = normalizeBuildIntentText(prompt);
  if (!normalized) return false;
  if (prompt.includes("?")) return true;
  return QUESTION_STARTERS.some((starter) => normalized.startsWith(`${starter} `));
};

const isGreetingPrompt = (prompt: string) => {
  const normalized = normalizeBuildIntentText(prompt);
  return GREETING_TERMS.includes(normalized);
};

const isVagueProjectPrompt = (prompt: string) => {
  const normalized = normalizeBuildIntentText(prompt);
  if (!hasProjectBuildIntent(prompt)) return false;
  if (normalized.length > 80) return false;
  return normalized.split(/\s+/).length <= 3;
};

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

export const ProjectPromptInterface = ({ language, theme, accountName }: ProjectPromptInterfaceProps) => {
  const [promptInput, setPromptInput] = useState("");
  const [isCreatingFromPrompt, setIsCreatingFromPrompt] = useState(false);
  const [isActionCardOpen, setIsActionCardOpen] = useState(false);
  const [isPlanModeEnabled, setIsPlanModeEnabled] = useState(false);
  const [isPlanButtonPressing, setIsPlanButtonPressing] = useState(false);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [selectedImagePreviewUrl, setSelectedImagePreviewUrl] = useState<string | null>(null);
  const [promptGuidance, setPromptGuidance] = useState<string | null>(null);
  const [typewriterState, setTypewriterState] = useState({
    phraseIndex: 0,
    charIndex: 0,
    deleting: false,
    holdTicks: 0,
  });

  const planPressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionCardRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const isDark = theme === "dark";

  const labels = {
    en: {
      title: `Hi ${accountName}, what do you want to make?`,
      tryExample: "Try an example prompt",
      plan: "Plan",
      planMode: "Plan mode",
      planDescription: "Splits your request into clear steps before execution.",
      planOn: "Plan on",
      addImage: "Add image",
      imageDescription: "Attach a visual reference",
      referenceImage: "Reference image",
      removeImage: "Remove image",
      promptHintIdle: "Tip: include audience, style, pages, and must-have sections.",
      promptHintPlan: "Plan mode is on. I will structure this before building.",
      promptHintImage: "Image attached. Add what should match or change.",
      recentPrompts: "Recent prompt starters",
      smartSuggestion: "Smart suggestion",
      usePrompt: "Use prompt",
      projectIntentRequired:
        "Please describe what you want to build, for example: \"Build a SaaS landing page\".",
      greetingResponse:
        "Hey! I am here. You can ask a question, describe a build, or share what you want to improve.",
      questionResponse:
        "Good question. This box starts a new build when you describe a project. For general questions, open a project and use the agent chat, or write a clear build brief here.",
      vaguePromptResponse:
        "To build this professionally, add the industry, target audience, goal, and visual style. Example: \"Build a premium restaurant landing page with menu, booking CTA, testimonials, and FAQ.\"",
    },
    tr: {
      title: `Merhaba ${accountName}, ne olu\u015fturmak istiyorsun?`,
      tryExample: "\u00d6rnek bir prompt dene",
      plan: "Plan",
      planMode: "Plan modu",
      planDescription: "\u0130ste\u011fini \u00e7al\u0131\u015ft\u0131rmadan \u00f6nce net ad\u0131mlara b\u00f6ler.",
      planOn: "Plan a\u00e7\u0131k",
      addImage: "G\u00f6rsel ekle",
      imageDescription: "G\u00f6rsel referans se\u00e7",
      referenceImage: "Referans g\u00f6rsel",
      removeImage: "G\u00f6rseli kald\u0131r",
      promptHintIdle: "\u0130pucu: hedef kitle, stil, sayfalar ve olmazsa olmaz b\u00f6l\u00fcmleri ekle.",
      promptHintPlan: "Plan modu a\u00e7\u0131k. \u00d6nce yap\u0131y\u0131 netle\u015ftirip sonra ilerlerim.",
      promptHintImage: "G\u00f6rsel eklendi. Neyin benzemesi veya de\u011fi\u015fmesi gerekti\u011fini yaz.",
      recentPrompts: "Prompt ba\u015flang\u0131\u00e7lar\u0131",
      smartSuggestion: "Ak\u0131ll\u0131 \u00f6neri",
      usePrompt: "Promptu kullan",
      projectIntentRequired:
        "L\u00fctfen ne olu\u015fturmak istedi\u011fini yaz. \u00d6rnek: \"Modern bir SaaS landing page yap\".",
      greetingResponse:
        "Merhaba! Buradayım. Bir soru sorabilir, oluşturmak istediğin projeyi anlatabilir veya geliştirmek istediğin kısmı yazabilirsin.",
      questionResponse:
        "Güzel soru. Bu alan yeni proje başlatmak için çalışıyor. Genel sorular için bir projenin içindeki ajan sohbetini kullanabilir veya burada net bir proje brief'i yazabilirsin.",
      vaguePromptResponse:
        "Bunu profesyonel yapmak için sektör, hedef kullanıcı, amaç ve görsel tarzı da ekle. Örnek: \"Menü, rezervasyon CTA'sı, yorumlar ve SSS içeren premium restoran landing page yap.\"",
    },
  }[language];

  const promptStarters = {
    en: [
      "Design a calm fintech dashboard with sidebar, cards, and charts",
      "Build a modern SaaS landing page with pricing and onboarding",
      "Create a soft mobile app signup flow with profile setup",
    ],
    tr: [
      "Sidebar, kartlar ve grafiklerle sakin bir fintech dashboard tasarla",
      "Fiyatland\u0131rma ve onboarding i\u00e7eren modern bir SaaS landing page olu\u015ftur",
      "Profil kurulumu olan soft bir mobil app kay\u0131t ak\u0131\u015f\u0131 tasarla",
    ],
  }[language];

  const randomPromptPool = {
    en: [
      "Design a sleek fintech dashboard for expense tracking",
      "Build a booking website for a dental clinic",
      "Create a pricing page for an AI automation product",
      "Generate a one-page portfolio for a UX designer",
      "Build a legal consultation landing page with appointment form",
      "Create an e-commerce storefront for a handmade jewelry brand",
      "Design a SaaS onboarding flow with progress steps",
      "Build a startup waitlist page with referral tracking",
      "Create a modern blog homepage for tech writers",
      "Build a real estate listing website with search filters",
    ],
    tr: [
      "Harcama takibi i\u00e7in \u015f\u0131k bir fintech paneli tasarla",
      "Bir di\u015f klini\u011fi i\u00e7in randevu web sitesi olu\u015ftur",
      "AI otomasyon \u00fcr\u00fcn\u00fc i\u00e7in fiyatland\u0131rma sayfas\u0131 haz\u0131rla",
      "UX tasar\u0131mc\u0131 i\u00e7in tek sayfal\u0131k portfolyo olu\u015ftur",
      "Randevu formlu hukuk dan\u0131\u015fmanl\u0131\u011f\u0131 a\u00e7\u0131l\u0131\u015f sayfas\u0131 yap",
      "El yap\u0131m\u0131 tak\u0131 markas\u0131 i\u00e7in e-ticaret vitrin sayfas\u0131 tasarla",
      "\u0130lerleme ad\u0131mlar\u0131 olan bir SaaS onboarding ak\u0131\u015f\u0131 olu\u015ftur",
      "Referans sistemi olan startup bekleme listesi sayfas\u0131 yap",
      "Teknoloji yazarlar\u0131 i\u00e7in modern blog ana sayfas\u0131 tasarla",
      "Filtreli arama i\u00e7eren emlak listeleme sitesi olu\u015ftur",
    ],
  }[language];

  useEffect(() => {
    const tickMs = 24;
    const typeStep = 1;
    const deleteStep = 2;
    const holdAfterTypeTicks = 14;
    const holdAfterDeleteTicks = 3;

    const intervalId = setInterval(() => {
      setTypewriterState((prev) => {
        if (prev.holdTicks > 0) {
          return { ...prev, holdTicks: prev.holdTicks - 1 };
        }

        const phrase = animatedPrompts[prev.phraseIndex];

        if (!prev.deleting) {
          const nextChar = Math.min(prev.charIndex + typeStep, phrase.length);
          if (nextChar >= phrase.length) {
            return {
              ...prev,
              charIndex: phrase.length,
              deleting: true,
              holdTicks: holdAfterTypeTicks,
            };
          }

          return { ...prev, charIndex: nextChar };
        }

        const nextChar = Math.max(prev.charIndex - deleteStep, 0);
        if (nextChar <= 0) {
          return {
            phraseIndex: (prev.phraseIndex + 1) % animatedPrompts.length,
            charIndex: 0,
            deleting: false,
            holdTicks: holdAfterDeleteTicks,
          };
        }

        return { ...prev, charIndex: nextChar };
      });
    }, tickMs);

    return () => clearInterval(intervalId);
  }, []);

  const animatedPlaceholder = useMemo(() => {
    const phrase = animatedPrompts[typewriterState.phraseIndex];
    return phrase.slice(0, typewriterState.charIndex);
  }, [typewriterState]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (actionCardRef.current && !actionCardRef.current.contains(event.target as Node)) {
        setIsActionCardOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsActionCardOpen(false);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
      if (planPressTimeoutRef.current) {
        clearTimeout(planPressTimeoutRef.current);
      }
    };
  }, []);

  const handlePromptSubmit = async () => {
    if (!promptInput.trim() || isCreatingFromPrompt) return;

    setIsCreatingFromPrompt(true);
    setPromptGuidance(null);

    try {
      const promptValue = promptInput.trim();

      if (isGreetingPrompt(promptValue)) {
        setPromptGuidance(labels.greetingResponse);
        setIsCreatingFromPrompt(false);
        return;
      }

      if (isQuestionLikePrompt(promptValue) && !hasProjectBuildIntent(promptValue)) {
        setPromptGuidance(labels.questionResponse);
        setIsCreatingFromPrompt(false);
        return;
      }

      if (isVagueProjectPrompt(promptValue)) {
        setPromptGuidance(labels.vaguePromptResponse);
        setIsCreatingFromPrompt(false);
        return;
      }

      if (!hasProjectBuildIntent(promptValue)) {
        setPromptGuidance(labels.projectIntentRequired);
        setIsCreatingFromPrompt(false);
        return;
      }

      toast("Creating new project...");
      const containerResponse = await createContainer();
      const containerId = containerResponse.containerId;
      const existingMetadata = readStoredMetadata();
      const nextMetadata: Record<string, StoredProjectMetadata> = {
        ...existingMetadata,
        [containerId]: {
          prompt: promptValue,
          title: buildTitleFromPrompt(promptValue),
          summary: buildSummaryFromPrompt(promptValue),
        },
      };
      writeStoredMetadata(nextMetadata);

      toast.success("Project created. Redirecting...");
      router.push(`/projects/${containerId}?prompt=${encodeURIComponent(promptValue)}`);
    } catch (error) {
      console.error("Failed to create project from prompt:", error);
      toast.error("Failed to create project. Please try again.");
    } finally {
      setIsCreatingFromPrompt(false);
    }
  };

  const handlePromptKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handlePromptSubmit();
    }
  };

  const handleTryRandomPrompt = () => {
    const randomPrompt = randomPromptPool[Math.floor(Math.random() * randomPromptPool.length)];
    setPromptInput(randomPrompt);
  };

  const promptHelperText = selectedImage
    ? labels.promptHintImage
    : isPlanModeEnabled
      ? labels.promptHintPlan
      : labels.promptHintIdle;

  const handlePlanToggle = () => {
    setIsPlanModeEnabled((prev) => !prev);
    setIsPlanButtonPressing(true);
    if (planPressTimeoutRef.current) {
      clearTimeout(planPressTimeoutRef.current);
    }
    planPressTimeoutRef.current = setTimeout(() => {
      setIsPlanButtonPressing(false);
    }, 140);
  };

  const handleImageSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setSelectedImage(file);
    setSelectedImagePreviewUrl((previousUrl) => {
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      return URL.createObjectURL(file);
    });
  };

  const removeSelectedImage = () => {
    setSelectedImage(null);
    setSelectedImagePreviewUrl((previousUrl) => {
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      return null;
    });
    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
  };

  useEffect(() => {
    return () => {
      if (selectedImagePreviewUrl) {
        URL.revokeObjectURL(selectedImagePreviewUrl);
      }
    };
  }, [selectedImagePreviewUrl]);

  return (
    <section
      className={`mx-auto flex min-h-[82dvh] w-full max-w-[760px] flex-col items-center justify-center pt-24 font-sans sm:min-h-[88vh] md:pt-28 ${
        isDark ? "text-slate-100" : "text-slate-800"
      }`}
    >
      <h1
        className={`text-center text-[24px] font-semibold leading-[1.15] tracking-[-0.02em] sm:text-[30px] ${
          isDark ? "text-slate-200" : "text-slate-700"
        }`}
      >
        {labels.title}
      </h1>

      <div className="relative mx-auto mt-6 w-full max-w-[640px] sm:mt-7" ref={actionCardRef}>
        <div
          className={`prompt-flight-card w-full rounded-2xl border px-2.5 py-2 ${
            isDark
              ? "prompt-flight-card--dark border-[#2a73cf] bg-[#222223]"
              : "prompt-flight-card--light border-[#c9ccd3] bg-[#ffffff]"
          }`}
        >
          <div className="relative">
            <textarea
              name="content"
              placeholder=""
              spellCheck="false"
              value={promptInput}
              onChange={(e) => {
                setPromptInput(e.target.value);
                if (promptGuidance) setPromptGuidance(null);
              }}
              onKeyDown={handlePromptKeyDown}
              disabled={isCreatingFromPrompt}
              className={`motion-input relative z-10 h-16 w-full resize-none bg-transparent px-2 py-1 text-[12px] font-medium outline-none disabled:opacity-50 sm:text-[13px] ${
                isDark ? "text-slate-100" : "text-slate-700"
              }`}
            />
            {!promptInput && (
              <span
                className={`pointer-events-none absolute left-2 right-2 top-1 z-20 select-none truncate whitespace-nowrap text-[12px] sm:text-[13px] ${
                  isDark ? "text-slate-300" : "text-slate-500"
                }`}
              >
                {animatedPlaceholder}
                <span className={`animate-pulse ${isDark ? "text-slate-400" : "text-slate-400"}`}>
                  |
                </span>
              </span>
            )}
          </div>

          {promptGuidance && (
            <div
              className={`mx-2 mb-1 mt-2 rounded-xl border px-3 py-2 text-[11px] leading-relaxed ${
                isDark
                  ? "border-[#31577d]/35 bg-[#31577d]/12 text-slate-200"
                  : "border-[#cfe1f4] bg-[#f2f8ff] text-[#294b6f]"
              }`}
            >
              {promptGuidance}
            </div>
          )}

          <div className={`mx-2 mt-1 flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-[10px] leading-tight ${
            isDark ? "bg-white/[0.045] text-slate-400" : "bg-[#f6f9fc] text-slate-500"
          }`}>
            <Sparkles className={`h-3 w-3 shrink-0 ${isDark ? "text-cyan-200/75" : "text-[#31577d]/70"}`} />
            <span className="truncate">{promptHelperText}</span>
          </div>

          {selectedImage && selectedImagePreviewUrl ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 px-2">
              <div
                className={`inline-flex max-w-[260px] items-center gap-1.5 rounded-full border px-1.5 py-1 ${
                  isDark
                    ? "border-[#3a3a3c] bg-[#272728] text-slate-200"
                    : "border-[#d7dde6] bg-[#f8fafc] text-slate-700"
                }`}
              >
                <img src={selectedImagePreviewUrl} alt={selectedImage.name} className="h-5 w-5 rounded-full object-cover" />
                <span className="truncate text-[10px] font-medium leading-none">{selectedImage.name}</span>
                <button
                  type="button"
                  onClick={removeSelectedImage}
                  aria-label={labels.removeImage}
                  className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors ${
                    isDark ? "text-slate-400 hover:bg-[#303540] hover:text-slate-100" : "text-slate-500 hover:bg-[#e5ebf2] hover:text-slate-800"
                  }`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          ) : null}

          <div className="mt-1 flex items-center justify-between px-2 pb-1">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setIsActionCardOpen((prev) => !prev)}
                aria-expanded={isActionCardOpen}
                className={`motion-icon-interactive inline-flex h-7 w-7 items-center justify-center rounded-full transition-[background-color,color,box-shadow,transform] duration-150 ${
                  isActionCardOpen
                    ? isDark
                    ? "bg-[#2a73cf]/16 text-slate-100 shadow-[inset_0_1px_2px_rgba(0,0,0,0.38),0_0_0_1px_rgba(42,115,207,0.18)]"
                      : "bg-[#eef6ff] text-[#1f3e5f] shadow-[inset_0_1px_2px_rgba(31,62,95,0.14),0_0_0_1px_rgba(157,191,232,0.55)]"
                    : isDark
                      ? "text-slate-300 hover:bg-[#2a2a2b]"
                      : "text-slate-500 hover:bg-[#edf2f7]"
                }`}
                type="button"
              >
                <Plus className={`h-3.5 w-3.5 transition-transform duration-200 ${isActionCardOpen ? "rotate-45" : "rotate-0"}`} />
              </button>

              {isPlanModeEnabled && (
                <span
                  className={`plan-on-badge inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium leading-none ${
                    isDark
                      ? "border-[#2a73cf]/40 bg-[#2a73cf]/12 text-slate-200"
                      : "border-[#bdd6f4] bg-[#eef6ff] text-[#1f3e5f]"
                  }`}
                >
                  <Sparkles className="h-3 w-3" />
                  {labels.planOn}
                </span>
              )}
            </div>

            <button
              onClick={handlePromptSubmit}
              disabled={!promptInput.trim() || isCreatingFromPrompt}
              className={`motion-icon-interactive inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-150 disabled:opacity-50 ${
                isDark
                  ? "bg-[#222223] text-slate-200 hover:bg-[#2a2a2b]"
                  : "bg-[#ffffff] text-slate-500 hover:bg-[#f8fafc]"
              }`}
              type="button"
            >
              {isCreatingFromPrompt ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-transparent" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        <div
          className={`motion-dropdown-panel absolute left-0 top-[calc(100%+8px)] z-40 w-[min(252px,calc(100vw-2rem))] origin-top-left rounded-2xl border p-1.5 shadow-[0_18px_46px_rgba(15,23,42,0.1)] backdrop-blur-xl ${
            isDark ? "border-white/8 bg-[#222223]/95" : "border-slate-200/80 bg-white/92"
          } ${
            isActionCardOpen
              ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
              : "pointer-events-none -translate-y-1 scale-95 opacity-0"
          }`}
        >
          <button
            type="button"
            onClick={handlePlanToggle}
            aria-pressed={isPlanModeEnabled}
            className={`flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left transition-[background-color,box-shadow,transform] duration-200 ${
              isPlanButtonPressing ? "translate-y-[1px] scale-[0.99]" : "translate-y-0 scale-100"
            } ${
              isPlanModeEnabled
                ? isDark
                  ? "bg-[#1f1f20] text-slate-100 shadow-[inset_0_2px_12px_rgba(0,0,0,0.46)]"
                  : "bg-[#f2f7fc] text-[#1f3e5f] shadow-[inset_0_2px_10px_rgba(31,62,95,0.12)]"
                : isDark
                  ? "text-slate-200 hover:bg-white/[0.04]"
                  : "text-slate-700 hover:bg-slate-100/70"
            }`}
          >
            <span>
              <span className="block text-[11px] font-semibold leading-none">{labels.planMode}</span>
              <span className={`mt-1 block text-[10px] leading-tight ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                {labels.planDescription}
              </span>
            </span>
            <span
              className={`ml-3 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-all duration-200 ${
                isPlanModeEnabled
                  ? "bg-[#1971dd] text-white shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)]"
                  : isDark
                    ? "bg-white/[0.05] text-slate-500 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)]"
                    : "bg-slate-200/70 text-slate-400 shadow-[inset_0_1px_2px_rgba(31,62,95,0.1)]"
              }`}
            >
              <Check className={`h-3 w-3 transition-opacity duration-200 ${isPlanModeEnabled ? "opacity-100" : "opacity-0"}`} />
            </span>
          </button>

          <div className={`mt-1 rounded-xl p-1 ${isDark ? "bg-white/[0.025]" : "bg-slate-50/70"}`}>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageSelect}
            />
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors ${
                isDark ? "text-slate-200 hover:bg-white/[0.04]" : "text-slate-700 hover:bg-white"
              }`}
            >
              <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${isDark ? "bg-white/[0.04]" : "bg-white shadow-[inset_0_0_0_1px_rgba(31,62,95,0.04)]"}`}>
                <ImagePlus className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] font-semibold leading-none">{labels.addImage}</span>
                <span className={`mt-1 block text-[10px] leading-tight ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                  {selectedImage ? selectedImage.name : labels.imageDescription}
                </span>
              </span>
            </button>

            {selectedImage && selectedImagePreviewUrl && (
              <div className={`mt-1.5 flex items-center gap-2 rounded-lg p-1.5 ${isDark ? "bg-[#272728]" : "bg-white"}`}>
                <img src={selectedImagePreviewUrl} alt={selectedImage.name} className="h-8 w-8 rounded-md object-cover" />
                <span className={`min-w-0 flex-1 truncate text-[11px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>
                  {selectedImage.name}
                </span>
                <button
                  type="button"
                  onClick={removeSelectedImage}
                  aria-label={labels.removeImage}
                  className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
                    isDark ? "text-slate-400 hover:bg-[#2d323b] hover:text-slate-100" : "text-slate-500 hover:bg-[#eef3f8] hover:text-slate-800"
                  }`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={`recent-prompt-card mt-5 w-full max-w-[620px] rounded-[22px] border p-1.5 backdrop-blur-sm transition-colors duration-300 sm:rounded-[26px] ${
        isDark
          ? "border-white/[0.06] bg-white/[0.025] shadow-[0_18px_46px_rgba(0,0,0,0.16)] hover:bg-white/[0.035]"
          : "border-[#e5ebf2] bg-white/72 shadow-[0_16px_42px_rgba(31,51,72,0.055)] hover:bg-white/86"
      }`}>
        <div className={`flex flex-col gap-2 rounded-[18px] px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:rounded-[21px] ${
          isDark ? "bg-[#222223]/70" : "bg-[#f8fafc]/78"
        }`}>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xl ring-1 ${
              isDark ? "bg-[#31577d]/14 text-[#bfe1ff] ring-white/[0.05]" : "bg-[#edf6ff] text-[#31577d] ring-[#d8e8f7]"
            }`}>
              <Sparkles className="h-3 w-3" />
            </span>
            <div className="min-w-0">
              <p className={`truncate text-[11.5px] font-semibold leading-none tracking-[-0.01em] ${isDark ? "text-slate-100" : "text-slate-700"}`}>
                {labels.recentPrompts}
              </p>
              <p className={`mt-1 truncate text-[9.5px] leading-none ${isDark ? "text-slate-500" : "text-slate-500"}`}>
                {labels.smartSuggestion}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleTryRandomPrompt}
            className={`motion-interactive inline-flex h-7 w-full shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 text-[10.5px] font-medium leading-none transition-colors sm:w-auto ${
              isDark ? "border-white/[0.055] bg-white/[0.03] text-slate-300 hover:bg-white/[0.06] hover:text-slate-100" : "border-[#e3eaf2] bg-white/74 text-slate-500 hover:border-[#d5e5f5] hover:bg-[#f7fbff] hover:text-[#31577d]"
            }`}
          >
            <RefreshCcw className="h-3 w-3" />
            {labels.tryExample}
          </button>
        </div>

        <div className="recent-prompts-reveal">
          <div className="recent-prompts-reveal__inner">
            <div className="grid gap-1">
              {promptStarters.map((prompt, index) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setPromptInput(prompt)}
                  className={`motion-interactive group/prompt flex items-center gap-2.5 rounded-2xl px-2.5 py-2.5 text-left transition-[background-color,box-shadow,transform] duration-300 sm:gap-3 sm:px-3 ${
                    isDark ? "text-slate-300 hover:bg-[#2a2a2b]" : "text-slate-600 hover:bg-white hover:shadow-[0_10px_24px_rgba(15,23,42,0.05)]"
                  }`}
                >
                  <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold leading-none ${
                    isDark ? "bg-[#2a2a2b] text-slate-500 group-hover/prompt:text-cyan-100" : "bg-[#eef3f8] text-slate-400 group-hover/prompt:text-[#31577d]"
                  }`}>
                    {index + 1}
                  </span>
                  <span className={`min-w-0 flex-1 truncate text-[11px] font-medium leading-none sm:text-[12px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>
                    {prompt}
                  </span>
                  <span className={`hidden shrink-0 rounded-full px-2.5 py-1 text-[9px] font-semibold leading-none opacity-0 transition-opacity group-hover/prompt:opacity-100 sm:inline-flex ${
                    isDark ? "bg-[#1d3344] text-cyan-100" : "bg-[#eef6ff] text-[#31577d]"
                  }`}>
                    {labels.usePrompt}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
