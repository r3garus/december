import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  FileText,
  Image,
  Paperclip,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-hot-toast";

interface ChatInputProps {
  inputValue: string;
  setInputValue: (value: string) => void;
  onSendMessage: (attachments?: File[]) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled?: boolean;
  pendingFiles?: File[];
  onRemovePendingFile?: (index: number) => void;
  isDark?: boolean;
  placeholder?: string;
  compact?: boolean;
  labels?: Partial<Record<string, string>>;
}

const detectPromptLanguage = (value: string): "tr" | "en" => {
  const lowerValue = value.toLowerCase();
  if (
    /[çğıöşü]/i.test(value) ||
    /\b(kanka|lutfen|lütfen|istiyorum|duzelt|düzelt|ekle|kaldir|kaldır|tasarim|tasarım|gorsel|görsel|sayfa|buton)\b/i.test(
      lowerValue
    )
  ) {
    return "tr";
  }

  return "en";
};

const extractPromptPoints = (value: string) => {
  const points = value
    .split(/\n+|[.!?;]+/g)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 5);

  return points.length > 0 ? points : [value];
};

const hashPrompt = (value: string) =>
  value.split("").reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 997, 7);

const hasAny = (value: string, patterns: RegExp[]) =>
  patterns.some((pattern) => pattern.test(value));

const buildPromptHints = (value: string, language: "tr" | "en") => {
  const lowerValue = value.toLowerCase();
  const hints: string[] = [];

  const addHint = (tr: string, en: string) => {
    hints.push(language === "tr" ? tr : en);
  };

  if (
    hasAny(lowerValue, [
      /tasar/,
      /design/,
      /ui\b/,
      /arayuz/,
      /renk/,
      /font/,
      /button|buton/,
      /kart/,
      /panel/,
      /gloss/,
    ])
  ) {
    addHint(
      "Tasarim tarafinda ana dili bozmadan, daha sade, markaya yakisan ve yazilimci elinden cikmis gibi duran bir sonuc istiyorum.",
      "Keep the core product language intact, but make the UI feel simpler, more branded, and more like it was refined by a real product engineer."
    );
  }

  if (hasAny(lowerValue, [/animasyon/, /smooth/, /hover/, /gecis/, /transition/, /acil/, /kapan/])) {
    addHint(
      "Etkilesimlerde ani veya oyuncak gibi duran hareketlerden kacin; gecisler yumusak, kontrollu ve kullaniciyi rahatsiz etmeyecek hizda olsun.",
      "Make interactions feel controlled and soft; avoid abrupt or toy-like motion, and keep transitions at a comfortable speed."
    );
  }

  if (hasAny(lowerValue, [/chat/, /mesaj/, /assistant/, /agent/, /prompt/, /input/, /yazi/, /font/])) {
    addHint(
      "Chat alaninda okunabilirligi on planda tut; metin boyutu, bosluklar, scroll davranisi ve buton yogunlugu dengeli olsun.",
      "Prioritize chat readability: balance text size, spacing, scrolling behavior, and control density."
    );
  }

  if (hasAny(lowerValue, [/bug/, /hata/, /error/, /fix/, /duzelt/, /d.zelt/, /calism/, /kir/])) {
    addHint(
      "Bir hata varsa once sebebini bul, sonra sadece gorunurdeki belirtiyi degil kalici cozumu uygula.",
      "If there is a bug, identify the root cause first and fix the underlying issue instead of only hiding the symptom."
    );
  }

  if (hasAny(lowerValue, [/mobile/, /responsive/, /telefon/, /tablet/, /ekran/])) {
    addHint(
      "Desktop ve mobile gorunumleri birlikte dusun; kucuk ekranda kirpilmayan, rahat okunabilen ve dogal akan bir yerlesim hedefle.",
      "Treat desktop and mobile together; aim for a layout that does not clip, reads comfortably, and flows naturally on smaller screens."
    );
  }

  if (hasAny(lowerValue, [/dark/, /light/, /tema/, /theme/, /renk/])) {
    addHint(
      "Light ve dark temada ayni kalite hissi korunmali; kontrast yeterli olsun ama renkler goz yormasin.",
      "Keep the same quality level in light and dark themes; maintain enough contrast without making colors feel harsh."
    );
  }

  if (hasAny(lowerValue, [/performans/, /performance/, /slow/, /yavas/, /hiz/, /loading/, /cache/])) {
    addHint(
      "Performans tarafinda gereksiz yeniden render, bekleme ve agir yukleme hissini azaltacak bir cozum tercih et.",
      "Prefer a solution that reduces unnecessary rerenders, waiting states, and heavy loading behavior."
    );
  }

  if (hints.length === 0) {
    addHint(
      "Belirsiz kalan yerlerde mevcut projedeki tasarim ve davranis kaliplarina bakarak makul varsayim yap.",
      "Where details are unclear, infer from the existing product patterns and make reasonable implementation choices."
    );
  }

  return hints.slice(0, 4);
};

const joinNaturalList = (items: string[], language: "tr" | "en") => {
  if (items.length <= 1) return items[0] || "";
  const last = items[items.length - 1];
  const rest = items.slice(0, -1).join(", ");
  return `${rest}${language === "tr" ? " ve " : ", and "}${last}`;
};

const improvePromptForAgent = (value: string) => {
  const cleanedPrompt = value.replace(/\s+/g, " ").trim();
  const language = detectPromptLanguage(cleanedPrompt);
  const requestPoints = extractPromptPoints(cleanedPrompt);
  const promptHints = buildPromptHints(cleanedPrompt, language);
  const variantIndex = hashPrompt(cleanedPrompt) % 3;

  if (language === "tr") {
    const openings = [
      `Lutfen su istegimi mevcut projedeki akisi bozmadan daha iyi hale getir: ${cleanedPrompt}`,
      `Bu kisimda istedigim sey su: ${cleanedPrompt}. Bunu dogrudan projedeki mevcut tasarim ve davranisla uyumlu sekilde uygula.`,
      `${cleanedPrompt}. Bunu yaparken sadece gorunumu degil, kullanicinin o alani nasil hissedecegini ve kullanacagini da dusun.`,
    ];
    const detailLine =
      requestPoints.length > 1
        ? `Istek icindeki parcalari ayri ayri ele al; ozellikle ${joinNaturalList(
            requestPoints.slice(0, 4),
            "tr"
          )} noktalarini birbirinden koparmadan coz.`
        : "Istek kisa olsa bile mevcut ekrandaki baglami kontrol edip eksik kalan detaylari mantikli sekilde tamamla.";

    return [
      openings[variantIndex],
      "",
      detailLine,
      ...promptHints.map((hint) => `- ${hint}`),
      "- Gereksiz buyuk butonlar, fazla glow, kalabalik kartlar veya yapay zeka tasarimi gibi duran detaylar kullanma.",
      "- Degisiklikten sonra mevcut calisan davranislari, tema uyumu ve responsive gorunum bozulmasin.",
      "- Chat cevabinda uzun kod bloklari yazma; neyi degistirdigini kisa, net ve dogal bir dille anlat.",
    ].join("\n");
  }

  const openings = [
    `Please improve this request directly in the current project without breaking the existing flow: ${cleanedPrompt}`,
    `What I want here is: ${cleanedPrompt}. Apply it in a way that fits the current product design and behavior.`,
    `${cleanedPrompt}. While doing this, consider not only the visual result but also how the user will read, feel, and use that area.`,
  ];
  const detailLine =
    requestPoints.length > 1
      ? `Treat the request as connected parts; especially keep ${joinNaturalList(
          requestPoints.slice(0, 4),
          "en"
        )} aligned with each other.`
      : "Even if the request is short, inspect the surrounding screen context and fill in missing details with reasonable product-minded assumptions.";

  return [
    openings[variantIndex],
    "",
    detailLine,
    ...promptHints.map((hint) => `- ${hint}`),
    "- Avoid oversized buttons, excessive glow, crowded cards, or details that feel AI-generated.",
    "- Do not break existing behavior, theme consistency, or responsive layout.",
    "- In chat, do not paste long code blocks; explain the completed changes briefly and naturally.",
  ].join("\n");
};

export const ChatInput = ({
  inputValue,
  setInputValue,
  onSendMessage,
  textareaRef,
  onKeyDown,
  disabled = false,
  pendingFiles = [],
  onRemovePendingFile,
  isDark = true,
  placeholder = "What do you want to build?",
  compact = false,
  labels = {},
}: ChatInputProps) => {
  const [attachments, setAttachments] = useState<File[]>([]);
  const [selectedCapabilityId, setSelectedCapabilityId] = useState("reasoning");
  const [selectedAgentId, setSelectedAgentId] = useState("agent");
  const [isAgentMenuOpen, setIsAgentMenuOpen] = useState(false);
  const [isModelSubmenuOpen, setIsModelSubmenuOpen] = useState(false);
  const [animatingCapabilityId, setAnimatingCapabilityId] = useState<
    string | null
  >(null);
  const [isPromptEnhancing, setIsPromptEnhancing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const enhanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelSubmenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const capabilityAnimationTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const allFiles = [...pendingFiles, ...attachments];
  const assistantName =
    labels.meshFireAgent || labels.assistantName || labels.assistant || "Klawpen Agent";
  const capabilityOptions = [
    {
      id: "reasoning",
      name: labels.featureDeepThinking || labels.deepMode || "Deep thinking",
      tone: labels.featureDeepThinkingDesc || "Thinks longer before changing code",
      icon: Brain,
    },
    {
      id: "coding",
      name: labels.featureCoding || "Coding",
      tone: labels.featureCodingDesc || "Focused edits and implementation",
      icon: Code2,
    },
    {
      id: "polish",
      name: labels.featurePolish || "Polish",
      tone: labels.featurePolishDesc || "Cleaner UI and product details",
      icon: Sparkles,
    },
  ];
  const agentOptions = [
    {
      id: "agent",
      name: assistantName,
      tone: labels.agentBalancedDesc || labels.modelSonnetDesc || "Balanced build",
    },
    {
      id: "coder",
      name: labels.meshFireCoder || "Klawpen Coder",
      tone: labels.agentCoderDesc || labels.modelOpusDesc || "Code-heavy changes",
    },
    {
      id: "fast",
      name: labels.meshFireFast || "Klawpen Fast",
      tone: labels.agentFastDesc || labels.modelFastDesc || "Quick edits",
    },
  ];
  const selectedAgentOption =
    agentOptions.find((agent) => agent.id === selectedAgentId) ||
    agentOptions[0];
  const selectedAgent = selectedAgentOption?.name || assistantName;
  const enhancementSteps = [
    labels.enhanceStepIntent || "Intent",
    labels.enhanceStepDetails || "Details",
    labels.enhanceStepGuardrails || "Guardrails",
  ];
  const ui = {
    fileMeta: isDark ? "text-white/70" : "text-slate-500",
    fileTotal: isDark ? "text-white/50" : "text-slate-400",
    fileChip: isDark
      ? "bg-white/[0.045] hover:bg-white/[0.07] border-white/[0.08] hover:border-white/15"
      : "bg-slate-50/85 hover:bg-white border-slate-200/80 hover:border-slate-300/80",
    fileName: isDark ? "text-white" : "text-slate-800",
    fileSize: isDark ? "text-slate-400" : "text-slate-500",
    card: isDark
      ? "bg-[#222223] border-white/[0.08] shadow-[0_8px_24px_rgba(0,0,0,0.18)] focus-within:border-[#7ec0ff]/24"
      : "bg-white border-slate-200/80 shadow-[0_8px_22px_rgba(31,51,72,0.07)] focus-within:border-[#31577d]/20",
    cardGlow: isDark
      ? "from-transparent via-transparent to-transparent"
      : "from-transparent via-transparent to-transparent",
    textarea: isDark
      ? "text-white placeholder-zinc-400"
      : "text-slate-900 placeholder-slate-400",
    attach: isDark
      ? "border-transparent bg-transparent text-zinc-500 hover:text-slate-200 hover:bg-white/[0.055]"
      : "border-transparent bg-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-950/[0.045]",
    control: isDark
      ? "border-white/[0.07] bg-white/[0.03] text-slate-400 hover:border-white/[0.12] hover:bg-white/[0.055] hover:text-slate-100"
      : "border-slate-200/80 bg-slate-950/[0.025] text-slate-600 hover:border-slate-300/90 hover:bg-white hover:text-slate-900",
    modelMenu: isDark
      ? "border-white/[0.09] bg-[#222223]/98 shadow-[0_18px_55px_rgba(0,0,0,0.42)]"
      : "border-slate-200/80 bg-white/98 shadow-[0_18px_45px_rgba(31,51,72,0.16)]",
    modelOption: isDark
      ? "text-slate-300 hover:bg-white/[0.06]"
      : "text-slate-600 hover:bg-slate-950/[0.045]",
    modelOptionActive: isDark
      ? "bg-[#7ec0ff]/10 text-[#d8edff]"
      : "bg-[#31577d]/8 text-[#1f3348]",
    modelTone: isDark ? "text-slate-500" : "text-slate-400",
    menuLabel: isDark ? "text-slate-500" : "text-slate-400",
    menuDivider: isDark ? "bg-white/[0.07]" : "bg-slate-200/80",
    menuIcon: isDark
      ? "bg-white/[0.045] text-slate-400"
      : "bg-slate-950/[0.035] text-slate-500",
    tooltip: isDark
      ? "border-white/[0.08] bg-[#222223]/95 text-slate-200 shadow-[0_12px_30px_rgba(0,0,0,0.35)]"
      : "border-slate-200/80 bg-white/95 text-slate-700 shadow-[0_12px_28px_rgba(31,51,72,0.14)]",
    stepDot: isDark ? "bg-[#7ec0ff]/70" : "bg-[#31577d]/75",
    stepText: isDark ? "text-slate-400" : "text-slate-500",
    send: isDark
      ? "bg-[#31577d] text-white hover:bg-[#3b6793] disabled:bg-white/[0.08] disabled:text-zinc-500 shadow-[0_0_0_1px_rgba(156,196,238,0.16)]"
      : "bg-[#31577d] text-white hover:bg-[#3b6793] disabled:bg-slate-200 disabled:text-slate-400 shadow-[0_0_0_1px_rgba(49,87,125,0.12)]",
  };

  useEffect(() => {
    if (!isAgentMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!agentMenuRef.current?.contains(event.target as Node)) {
        setIsAgentMenuOpen(false);
        setIsModelSubmenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsAgentMenuOpen(false);
        setIsModelSubmenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isAgentMenuOpen]);

  useEffect(() => {
    return () => {
      if (enhanceTimeoutRef.current) {
        clearTimeout(enhanceTimeoutRef.current);
      }
      if (modelSubmenuTimerRef.current) {
        clearTimeout(modelSubmenuTimerRef.current);
      }
      if (capabilityAnimationTimerRef.current) {
        clearTimeout(capabilityAnimationTimerRef.current);
      }
    };
  }, []);

  const validateFiles = (files: File[]): File[] => {
    const maxFileSize = 5 * 1024 * 1024; // 5MB per file
    const maxTotalSize = 20 * 1024 * 1024; // 20MB total

    const currentTotalSize = allFiles.reduce((sum, file) => sum + file.size, 0);
    let newTotalSize = currentTotalSize;
    const validFiles: File[] = [];

    for (const file of files) {
      const isImage = file.type.startsWith("image/");
      const isDocument = [
        "application/pdf",
        "text/plain",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ].includes(file.type);

      if (!isImage && !isDocument) {
        toast.error(`${file.name} ${labels.fileUnsupported || "is not a supported file type"}`);
        continue;
      }

      if (file.size > maxFileSize) {
        toast.error(`${file.name} ${labels.fileTooLarge || "is too large (max 5MB per file)"}`);
        continue;
      }

      if (newTotalSize + file.size > maxTotalSize) {
        toast.error(
          labels.totalSizeExceeded
            ? `${file.name}: ${labels.totalSizeExceeded}`
            : `Cannot add ${file.name}: would exceed total size limit (max 20MB)`
        );
        continue;
      }

      newTotalSize += file.size;
      validFiles.push(file);
    }

    return validFiles;
  };

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const validFiles = validateFiles(files);

    if (validFiles.length > 0) {
      setAttachments((prev) => [...prev, ...validFiles]);
      if (validFiles.length !== files.length) {
        toast.success(
          `${validFiles.length} ${labels.filesOf || "of"} ${files.length} ${labels.filesAddedPartial || "files added"}`
        );
      }
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const removeAttachment = (index: number) => {
    const pendingCount = pendingFiles.length;
    if (index < pendingCount) {
      onRemovePendingFile?.(index);
    } else {
      const attachmentIndex = index - pendingCount;
      setAttachments((prev) => prev.filter((_, i) => i !== attachmentIndex));
    }
  };

  const clearModelSubmenuTimer = () => {
    if (modelSubmenuTimerRef.current) {
      clearTimeout(modelSubmenuTimerRef.current);
      modelSubmenuTimerRef.current = null;
    }
  };

  const openModelSubmenuWithDelay = () => {
    clearModelSubmenuTimer();
    modelSubmenuTimerRef.current = setTimeout(() => {
      setIsModelSubmenuOpen(true);
    }, 240);
  };

  const closeModelSubmenuWithDelay = () => {
    clearModelSubmenuTimer();
    modelSubmenuTimerRef.current = setTimeout(() => {
      setIsModelSubmenuOpen(false);
    }, 160);
  };

  const selectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setIsModelSubmenuOpen(false);
    setIsAgentMenuOpen(false);
    clearModelSubmenuTimer();
  };

  const selectCapability = (capabilityId: string) => {
    setSelectedCapabilityId(capabilityId);
    setAnimatingCapabilityId(capabilityId);

    if (capabilityAnimationTimerRef.current) {
      clearTimeout(capabilityAnimationTimerRef.current);
    }

    capabilityAnimationTimerRef.current = setTimeout(() => {
      setAnimatingCapabilityId(null);
    }, 620);
  };

  const handleEnhancePrompt = () => {
    const sourcePrompt = inputValue.trim();

    if (!sourcePrompt) {
      toast.error(labels.enhancePromptEmpty || "Write a prompt first");
      textareaRef.current?.focus();
      return;
    }

    if (enhanceTimeoutRef.current) {
      clearTimeout(enhanceTimeoutRef.current);
    }

    setIsPromptEnhancing(true);
    enhanceTimeoutRef.current = setTimeout(() => {
      setInputValue(improvePromptForAgent(sourcePrompt));
      setIsPromptEnhancing(false);
      toast.success(labels.enhancedPromptToast || "Prompt improved");

      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        textarea.focus();
        textarea.style.height = "auto";
        textarea.style.height =
          Math.min(textarea.scrollHeight, compact ? 180 : 160) + "px";
      });
    }, 460);
  };

  const handleSend = () => {
    onSendMessage(attachments.length > 0 ? attachments : undefined);
    setAttachments([]);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const getTotalSize = () => {
    const total = allFiles.reduce((sum, file) => sum + file.size, 0);
    return formatFileSize(total);
  };

  const getFileIcon = (file: File) => {
    if (file.type.startsWith("image/")) {
      return (
        <Image
          className={`w-4 h-4 ${isDark ? "text-slate-400" : "text-slate-500"}`}
        />
      );
    }
    return (
      <FileText
        className={`w-4 h-4 ${isDark ? "text-slate-400" : "text-slate-500"}`}
      />
    );
  };

  const canSend = (inputValue.trim().length > 0 || allFiles.length > 0) && !disabled;

  return (
    <div className={`${compact ? "space-y-1.5 p-2" : "space-y-3 p-4"}`}>
      {allFiles.length > 0 && (
        <div className="space-y-2">
          <div
            className={`flex items-center justify-between px-1 text-[10px] font-medium ${ui.fileMeta}`}
          >
            <span>{labels.attachedFiles || "Attached files"} ({allFiles.length})</span>
            <span className={ui.fileTotal}>{labels.total || "Total"}: {getTotalSize()}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {allFiles.map((file, index) => (
              <div
                key={`${file.name}-${index}`}
                className={`motion-card group flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-[10px] transition-all duration-200 ${ui.fileChip}`}
              >
                {getFileIcon(file)}
                <div className="flex flex-col min-w-0">
                  <span
                    className={`max-w-28 truncate font-medium ${ui.fileName}`}
                    title={file.name}
                  >
                    {file.name}
                  </span>
                  <span className={`text-[9px] ${ui.fileSize}`}>
                    {formatFileSize(file.size)}
                  </span>
                </div>
                <button
                  onClick={() => removeAttachment(index)}
                  className="motion-icon-interactive text-gray-400 hover:text-red-400 opacity-70 hover:opacity-100 transition-all duration-200 p-0.5 hover:bg-red-500/10 rounded"
                  title={labels.removeFile || "Remove file"}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div
        className={`relative flex flex-col overflow-visible rounded-2xl border transition-all duration-300 ${
          compact ? "gap-2.5 p-3" : "gap-3 p-4"
        } ${ui.card}`}
      >
        <div
          className={`pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br ${ui.cardGlow}`}
        />

        <div className="relative z-10">
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            className={`motion-input custom-scrollbar w-full resize-none overflow-y-auto bg-transparent px-0 py-1 text-[12px] leading-[18px] placeholder:text-[12px] focus:outline-none disabled:opacity-50 ${
              compact ? "min-h-[92px] max-h-[180px]" : "min-h-[58px] max-h-[160px]"
            } ${ui.textarea}`}
            rows={1}
            style={{
              height: "auto",
              minHeight: compact ? "92px" : "58px",
            }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height =
                Math.min(target.scrollHeight, compact ? 180 : 160) + "px";
            }}
          />
        </div>

        <div className="relative z-20 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*"
              onChange={handleFileSelect}
              className="hidden"
            />
            <div className="relative" ref={agentMenuRef}>
              <button
                type="button"
                onClick={() => {
                  setIsAgentMenuOpen((current) => {
                    if (current) setIsModelSubmenuOpen(false);
                    return !current;
                  });
                }}
                className={`motion-interactive inline-flex h-7 max-w-[142px] items-center gap-1.5 rounded-full border px-2 font-medium transition-all duration-200 ${ui.control}`}
                disabled={disabled}
                aria-haspopup="menu"
                aria-expanded={isAgentMenuOpen}
                title={labels.selectAgent || "Select AI model"}
              >
                <span className="truncate text-[11px] leading-none">
                  {selectedAgent}
                </span>
                <ChevronDown
                  className={`h-2.5 w-2.5 shrink-0 transition-transform duration-200 ${
                    isAgentMenuOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              {isAgentMenuOpen && (
                <div
                  className={`workspace-popover-in absolute bottom-full left-0 z-50 mb-2 w-52 overflow-visible rounded-xl border p-1.5 backdrop-blur-xl ${ui.modelMenu}`}
                  role="menu"
                >
                  <div className={`px-2 pb-1 pt-0.5 text-[9px] font-medium uppercase tracking-[0.15em] ${ui.menuLabel}`}>
                    {labels.agentMenuFeatures || "Capabilities"}
                  </div>
                  <div className="space-y-1">
                    {capabilityOptions.map((capability) => {
                      const isSelected = selectedCapabilityId === capability.id;
                      const isAnimating =
                        animatingCapabilityId === capability.id;
                      const CapabilityIcon = capability.icon;

                      return (
                        <button
                          key={capability.id}
                          type="button"
                          onClick={() => selectCapability(capability.id)}
                          className={`relative flex w-full items-center justify-between gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left transition-all duration-150 ${
                            isSelected ? ui.modelOptionActive : ui.modelOption
                          } ${isAnimating ? "capability-selecting" : ""}`}
                          role="menuitemradio"
                          aria-checked={isSelected}
                        >
                          {isAnimating && (
                            <span
                              className="capability-selection-sweep"
                              aria-hidden="true"
                            />
                          )}
                          <span className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${ui.menuIcon} ${
                            isAnimating ? "capability-icon-pop" : ""
                          }`}>
                            <CapabilityIcon className="h-3 w-3" />
                          </span>
                          <span className="relative min-w-0 flex-1">
                            <span className="block truncate text-[11px] font-semibold">
                              {capability.name}
                            </span>
                            <span className={`block truncate text-[9px] ${ui.modelTone}`}>
                              {capability.tone}
                            </span>
                          </span>
                          {isSelected && (
                            <Check
                              className={`relative h-3.5 w-3.5 shrink-0 ${
                                isAnimating ? "capability-check-in" : ""
                              }`}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>

                  <div className={`my-1.5 h-px ${ui.menuDivider}`} />

                  <div
                    className="relative"
                    onMouseEnter={openModelSubmenuWithDelay}
                    onMouseLeave={closeModelSubmenuWithDelay}
                    onFocus={() => setIsModelSubmenuOpen(true)}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setIsModelSubmenuOpen((current) => !current)
                      }
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-all duration-150 ${
                        isModelSubmenuOpen ? ui.modelOptionActive : ui.modelOption
                      }`}
                      role="menuitem"
                      aria-haspopup="menu"
                      aria-expanded={isModelSubmenuOpen}
                    >
                      <span className="min-w-0 flex-1">
                        <span className={`block text-[9px] font-medium uppercase tracking-[0.15em] ${ui.menuLabel}`}>
                          {labels.agentMenuModels || "AI models"}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] font-semibold">
                          {selectedAgent}
                        </span>
                        <span className={`block truncate text-[9px] ${ui.modelTone}`}>
                          {selectedAgentOption?.tone}
                        </span>
                      </span>
                      <ChevronRight
                        className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${
                          isModelSubmenuOpen ? "translate-x-0.5" : ""
                        }`}
                      />
                    </button>

                    <span
                      aria-hidden="true"
                      className="absolute bottom-0 left-full top-0 w-2"
                    />

                    {isModelSubmenuOpen && (
                      <div
                        className={`workspace-popover-in absolute bottom-0 left-full z-[60] ml-2 w-40 origin-bottom-left rounded-xl border p-1.5 backdrop-blur-xl ${ui.modelMenu}`}
                        role="menu"
                      >
                        <div className={`px-2 pb-1 pt-0.5 text-[9px] font-medium uppercase tracking-[0.15em] ${ui.menuLabel}`}>
                          {labels.agentMenuModels || "AI models"}
                        </div>
                        <div className="space-y-1">
                          {agentOptions.map((agent) => {
                            const isSelected = selectedAgentId === agent.id;

                            return (
                              <button
                                key={agent.id}
                                type="button"
                                onClick={() => selectAgent(agent.id)}
                                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-all duration-150 ${
                                  isSelected
                                    ? ui.modelOptionActive
                                    : ui.modelOption
                                }`}
                                role="menuitemradio"
                                aria-checked={isSelected}
                              >
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[11px] font-semibold">
                                    {agent.name}
                                  </span>
                                  <span className={`block truncate text-[9px] ${ui.modelTone}`}>
                                    {agent.tone}
                                  </span>
                                </span>
                                {isSelected && (
                                  <Check className="h-3.5 w-3.5 shrink-0" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="group relative">
              <button
                type="button"
                onClick={handleEnhancePrompt}
                className={`motion-interactive flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2 transition-all disabled:cursor-not-allowed disabled:opacity-50 ${ui.control}`}
                disabled={disabled || isPromptEnhancing}
                title={labels.enhancePrompt || "Improve prompt"}
                aria-label={labels.enhancePrompt || "Improve prompt"}
              >
                <WandSparkles
                  className={`h-3.5 w-3.5 transition-transform duration-300 ${
                    isPromptEnhancing
                      ? "animate-spin scale-110"
                      : "group-hover:rotate-12"
                  }`}
                />
                <span className="text-[10px] font-medium leading-none">
                  {labels.enhancePromptShort || "Refine"}
                </span>
              </button>
              <span
                className={`pointer-events-none invisible absolute bottom-full left-1/2 z-[60] mb-2 w-56 -translate-x-1/2 rounded-xl border px-2.5 py-2 text-left text-[10px] leading-snug opacity-0 backdrop-blur-xl transition-all delay-500 duration-150 group-hover:visible group-hover:opacity-100 ${ui.tooltip}`}
              >
                <span className="block font-semibold">
                  {labels.enhancePromptTooltip ||
                    "Rewrite this prompt so Klawpen Agent understands it better"}
                </span>
                <span className={`mt-1.5 flex items-center justify-between gap-1 ${ui.stepText}`}>
                  {enhancementSteps.map((step, index) => (
                    <span key={step} className="inline-flex items-center gap-1">
                      <span className={`h-1.5 w-1.5 rounded-full ${ui.stepDot}`} />
                      <span>{index + 1}. {step}</span>
                    </span>
                  ))}
                </span>
              </span>
            </div>

            <button
              type="button"
              onClick={handleAttachClick}
              className={`motion-interactive flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-all disabled:opacity-50 ${ui.attach}`}
              disabled={disabled}
              title={labels.addImage || "Add image"}
              aria-label={labels.addImage || "Add image"}
            >
              <Paperclip className="h-3.5 w-3.5" />
            </button>
          </div>

          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className={`motion-interactive group flex shrink-0 items-center justify-center rounded-full transition-all duration-200 disabled:cursor-not-allowed ${
              compact ? "h-7 w-8" : "h-9 w-10"
            } ${ui.send}`}
            aria-label={labels.sendMessage || "Send message"}
            title={labels.sendMessage || "Send message"}
          >
            <ArrowUp
              className={`h-3.5 w-3.5 transition-transform duration-200 ${
                canSend ? "group-hover:-translate-y-0.5 group-hover:scale-110" : ""
              }`}
              strokeWidth={2.4}
            />
          </button>
        </div>
      </div>
    </div>
  );
};
