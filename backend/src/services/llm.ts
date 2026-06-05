import OpenAI from "openai";
import { config } from "../../config";
import prompt from "../utils/prompt.txt";
import {
  getAiProviders,
  recordProviderRequest,
  selectAiProvider,
  type AiProviderConfig,
  type AiWorkloadEstimate,
} from "./aiProvider";
import * as dockerService from "./docker";
import * as fileService from "./file";
import * as packageService from "./package";

const clientCache = new Map<string, OpenAI>();

const aiSdkConfig = config.aiSdk as typeof config.aiSdk & {
  temperature?: number;
  maxRetries?: number;
  minQualityScore?: number;
  maxCriticRounds?: number;
};
const aiTemperature = aiSdkConfig.temperature ?? 0.15;
const aiMaxRetries = aiSdkConfig.maxRetries ?? 2;
const aiMinQualityScore = aiSdkConfig.minQualityScore ?? 88;
const aiMaxCriticRounds = aiSdkConfig.maxCriticRounds ?? 3;
const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || "150000");
const AI_BUILDER_TIMEOUT_MS = Number(
  process.env.AI_BUILDER_TIMEOUT_MS || "300000"
);

function getAiClient(provider: AiProviderConfig) {
  const cacheKey = `${provider.key}:${provider.baseUrl}`;
  const cachedClient = clientCache.get(cacheKey);

  if (cachedClient) return cachedClient;

  const client = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseUrl || "https://api.openai.com/v1",
  });

  clientCache.set(cacheKey, client);
  return client;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  attachments?: Attachment[];
  edits?: {
    applied: number;
    failed: Array<{ label: string; error: string }>;
  };
}

export interface Attachment {
  type: "image" | "document";
  data: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface ChatSession {
  id: string;
  containerId: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

interface CriticResult {
  score: number;
  verdict: "PASS" | "FAIL";
  feedback: string;
}

interface CodeOperation {
  type: "write" | "rename" | "delete" | "dependency";
  index: number;
  path?: string;
  content?: string;
  from?: string;
  to?: string;
  packageName?: string;
  version?: string;
}

interface BuildProgress {
  stage:
    | "scan"
    | "plan"
    | "architect"
    | "draft"
    | "review"
    | "validate"
    | "repair"
    | "verify"
    | "apply"
    | "refresh";
  title: string;
  description: string;
  percent: number;
  files?: string[];
}

type ProgressReporter = (progress: BuildProgress) => void | Promise<void>;

interface BuildOptions {
  planMode?: boolean;
  forceBuild?: boolean;
  qualityMode?: "fast" | "standard" | "power";
  powerMode?: boolean;
}

const chatSessions = new Map<string, ChatSession>();

const POWER_BUILD_AUTO_ENABLED = process.env.KLAWPEN_POWER_BUILD_AUTO !== "false";
const ARCHITECT_SPEC_ENABLED =
  process.env.KLAWPEN_ENABLE_ARCHITECT_SPEC !== "false";
const BUILD_GATE_ENABLED = process.env.KLAWPEN_ENABLE_BUILD_GATE === "true";
const PREVIEW_CHECK_ENABLED = process.env.KLAWPEN_ENABLE_PREVIEW_CHECK === "true";
const CROSS_REVIEW_ENABLED = process.env.KLAWPEN_ENABLE_CROSS_REVIEW !== "false";
const DETERMINISTIC_RUNTIME_FALLBACK_ENABLED =
  process.env.KLAWPEN_DETERMINISTIC_RUNTIME_FALLBACK === "true";

const VISUAL_ARCHETYPES: VisualArchetype[] = [
  {
    key: "editorial-luxury",
    name: "Editorial Luxury",
    composition:
      "asymmetric editorial grid, expressive but controlled display headings, story-led sections, magazine pull quotes, layered imagery panels",
    palette:
      "warm ivory, espresso, muted gold, charcoal, one restrained accent color",
    typography:
      "refined expressive headlines paired with compact uppercase labels and calm readable body copy",
    motion:
      "slow reveal, image parallax feel, subtle mask/clip transitions, refined hover states",
    forbidden: ["centered SaaS hero", "three identical feature cards", "blue gradient dashboard mockup"],
  },
  {
    key: "neo-brutal-product",
    name: "Neo Brutal Product",
    composition:
      "chunky border system, offset blocks, strong grid lines, sticker-like callouts, confident high-contrast sections",
    palette:
      "ink black, paper white, acid accent, one saturated support color",
    typography:
      "bold compressed headings, punchy labels, direct short copy",
    motion:
      "snappy hover lifts, marquee/rail details, blocky reveal transitions",
    forbidden: ["soft glass cards everywhere", "generic rounded SaaS cards", "muted corporate sameness"],
  },
  {
    key: "operational-dashboard",
    name: "Operational Dashboard",
    composition:
      "split application shell, metric strips, workflow panels, data cards, realistic product states and empty states",
    palette:
      "deep slate, electric accent, calm surface colors, status colors used sparingly",
    typography:
      "precise product UI hierarchy with compact labels, readable dashboards, and clear data emphasis",
    motion:
      "panel transitions, status pulses, tab/segment interactions, lightweight data animation",
    forbidden: ["marketing-only landing", "decorative hero with no product UI", "fake nav links"],
  },
  {
    key: "boutique-studio",
    name: "Boutique Studio",
    composition:
      "art-directed whitespace, floating cards, portfolio/case-study rhythm, diagonal or organic visual accents",
    palette:
      "soft tinted background, dark ink text, unusual accent pairing, tactile cards",
    typography:
      "stylish display scale with human editorial copy and generous spacing",
    motion:
      "staggered cards, soft drift accents, hover reveals for case details",
    forbidden: ["template SaaS pricing hero", "identical rows", "stock corporate layout"],
  },
  {
    key: "local-service-premium",
    name: "Local Service Premium",
    composition:
      "trust-first hero, service map, booking/contact module, proof bands, location/availability details",
    palette:
      "grounded local colors, clean light surfaces, one strong CTA color",
    typography:
      "clear service-first hierarchy, reassuring labels, scannable benefit copy",
    motion:
      "soft section reveals, CTA hover, service cards with practical microinteractions",
    forbidden: ["abstract SaaS dashboard", "generic agency copy", "fake tech startup stats"],
  },
  {
    key: "commerce-catalog",
    name: "Commerce Catalog",
    composition:
      "shop/catalog grid, product cards, category rails, comparison blocks, cart/checkout-style CTA areas",
    palette:
      "retail-ready neutral base, product-led accents, strong sale/CTA color used carefully",
    typography:
      "clear product names, price/benefit hierarchy, concise promotional copy",
    motion:
      "card hover, filter tab transitions, product spotlight reveal",
    forbidden: ["service-agency section order", "dashboard chart hero", "generic B2B SaaS copy"],
  },
  {
    key: "immersive-event",
    name: "Immersive Event",
    composition:
      "cinematic hero, schedule/timeline, speaker/feature cards, ticket CTA, immersive atmospheric background",
    palette:
      "dark atmospheric base, luminous accent, gradient or glow details",
    typography:
      "dramatic headline scale, time/location metadata, energetic CTA copy",
    motion:
      "glow pulses, timeline reveals, ticket card hover, atmospheric gradients",
    forbidden: ["quiet corporate layout", "plain white page", "static feature grid only"],
  },
  {
    key: "technical-terminal",
    name: "Technical Terminal",
    composition:
      "developer-console inspired layout, code/output panels, integration diagrams, API cards, docs-like sections",
    palette:
      "near-black, terminal green/cyan accents, muted code surfaces",
    typography:
      "monospace accents, precise product headings, technical but readable copy",
    motion:
      "typing-like status chips, terminal cursor pulse, panel transitions",
    forbidden: ["consumer lifestyle styling", "luxury editorial layout", "generic white SaaS cards"],
  },
];

interface ResolvedBuildOptions extends BuildOptions {
  qualityMode: "fast" | "standard" | "power";
  powerMode: boolean;
}

interface ArchitectSpecRoute {
  path: string;
  purpose: string;
  visibleTitle: string;
}

interface ArchitectSpec {
  projectType: string;
  language: "tr" | "en";
  routes: ArchitectSpecRoute[];
  visualArchetype?: string;
  designDirection: string;
  animationPlan: string[];
  components: string[];
  contentFiles: string[];
  acceptanceCriteria: string[];
}

interface ValidationResult {
  passed: boolean;
  issues: string[];
}

interface VisualArchetype {
  key: string;
  name: string;
  composition: string;
  palette: string;
  typography: string;
  motion: string;
  forbidden: string[];
}

const BUILD_INTENT_PATTERN =
  /\b(yap|yapal[ıi]m|olu[sş]tur|haz[ıi]rla|kur|geli[sş]tir|ekle|de[gğ]i[sş]tir|d[üu]zelt|kald[ıi]r|sil|tasarla|kodla|g[üu]ncelle|ayarla|[çc][ıi]kar|koy|olsun|build|create|make|add|change|update|fix|remove|delete|design|implement|generate)\b/i;
const BUILD_WANT_PATTERN =
  /\b(istiyorum|laz[ıi]m|ihtiyac[ıi]m|need|want)\b/i;
const BUILD_SUBJECT_PATTERN =
  /\b(site|website|web\s*sitesi|landing|landing\s*page|sayfa|dashboard|panel|app|uygulama|platform|product|[üu]r[üu]n|proje|project|component|komponent|[öo]zellik|feature|tasar[ıi]m|design|page|route|form|login|register|blog|pricing|faq|sss|store|shop|e-?commerce|marketplace|pazar\s*yeri|portfolio|portfolyo|api|backend|database|auth|klinik|clinic|restoran|restaurant|cafe|kafe|men[üu]|menu|randevu|booking|rezervasyon)\b/i;
const BUILD_BRIEF_SIGNAL_PATTERN =
  /\b(modern|premium|minimal|kurumsal|corporate|luxury|editorial|brutal|bold|creative|yarat[ıi]c[ıi]|animasyon|animated|responsive|mobil|desktop|landing|dashboard|auth|login|register|pricing|fiyat|faq|sss|contact|ileti[sş]im|reservation|rezervasyon|booking|randevu|menu|men[üu]|e-?commerce|portfolio|portfolyo|saas|crm|clinic|klinik|di[sş]|dental|avukat|hukuk|law|legal|hotel|otel|restaurant|restoran|fitness|gym|agency|ajans)\b/i;
const TURKISH_HINT_PATTERN =
  /[çğıöşü]/i;
const TURKISH_WORD_PATTERN =
  /\b(merhaba|selam|naber|nas[ıi]ls[ıi]n|tesekkur|te[sş]ekk[üu]r|sagol|sa[gğ] ol|eyvallah|kanka)\b/i;
const QUESTION_PATTERN =
  /[?？]|^(ne|nasil|nas[ıi]l|neden|niye|hangi|kim|nerede|nereyi|sence|bana anlat|aciklar|a[çc][ıi]klar|what|why|how|which|who|where|can|could|should|would|is|are|do|does|did)\b/i;
const VERY_VAGUE_BUILD_PATTERN =
  /^(bir\s+)?(site|website|web sitesi|landing|landing page|sayfa|dashboard|panel|app|uygulama)\s*(yap|olu[sş]tur|tasarla|build|create|make|design)?$/i;
const RUNTIME_REPAIR_PATTERN =
  /\b(runtime|referenceerror|typeerror|syntaxerror|rangeerror|server-side exception|application error|digest:|stack trace|module not found|cannot find module|hydration|build failed|compile error|compilation failed|next\.js error|react error|white screen|blank preview|preview blank|preview.*bomboş|preview.*bos|önizleme.*bomboş|onizleme.*bos|açılmıyor|acilmiyor|çalışmıyor|calismiyor)\b/i;
const DESIGN_REVISION_PATTERN =
  /\b(tasar[ıi]m|design|gör[üu]n[üu]m|gorunum|ayn[ıi]|same|template|şablon|sablon|renk|color|font|layout|sil[üu]et|hero|kart|card|animasyon|animation|profesyonel|modern|previewde görünen|previewde gorunen|önizlemede görünen|onizlemede gorunen)\b/i;
const BUILD_DETAIL_PATTERN =
  /\b(premium|minimal|kurumsal|corporate|luxury|editorial|brutal|bold|modern|renk|color|style|tarz|hedef|audience|kitle|cta|sat[ıi][sş]|sales|randevu|booking|demo|portfolio|portfolyo|fiyat|pricing|sss|faq|dashboard|auth|login|register|blog|about|hakk[ıi]nda|contact|iletisim|ileti[sş]im|sayfa|pages|routes|route|section|b[öo]l[üu]m)\b/i;
const GENERIC_BUILD_WORDS = new Set([
  "bir",
  "bana",
  "benim",
  "icin",
  "ile",
  "site",
  "website",
  "web",
  "sayfa",
  "landing",
  "page",
  "dashboard",
  "panel",
  "app",
  "uygulama",
  "yap",
  "yapalim",
  "olustur",
  "tasarla",
  "hazirla",
  "kur",
  "istiyorum",
  "lazim",
  "build",
  "create",
  "make",
  "design",
  "generate",
  "need",
  "want",
  "merhaba",
  "selam",
  "hello",
  "hi",
  "hey",
  "naber",
  "soru",
  "sormak",
  "sorabilir",
  "yardim",
  "help",
]);

function isLikelyTurkish(message: string): boolean {
  return TURKISH_HINT_PATTERN.test(message) || TURKISH_WORD_PATTERN.test(message);
}

function isImplicitBuildBrief(message: string): boolean {
  const text = message.trim();
  if (!text || text.length < 8) return false;
  if (isQuestion(text)) return false;

  const normalized = normalizePromptText(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  const hasSubject = BUILD_SUBJECT_PATTERN.test(text);
  const hasBriefSignal = BUILD_BRIEF_SIGNAL_PATTERN.test(text);
  const hasRouteOrProductStructure =
    /\b(home|ana sayfa|pricing|fiyat|faq|sss|contact|iletisim|features|ozellikler|services|hizmetler|about|hakkimizda|login|register|auth|dashboard|panel|blog|portfolio|menu|randevu|booking|reservation|rezervasyon)\b/.test(
      normalized
    );
  const domainPhrase =
    /\b(dis klinigi|dental clinic|hukuk ofisi|law firm|restoran|restaurant|cafe|fitness|gym|otel|hotel|emlak|real estate|kuafor|barber|agency|ajans|saas|crm|ecommerce|e commerce|marketplace)\b/.test(
      normalized
    );

  return (
    hasSubject &&
    (hasBriefSignal ||
      hasRouteOrProductStructure ||
      domainPhrase ||
      words.length >= 6)
  );
}

function isBuildRequest(message: string): boolean {
  return (
    BUILD_INTENT_PATTERN.test(message) ||
    (BUILD_WANT_PATTERN.test(message) && BUILD_SUBJECT_PATTERN.test(message)) ||
    isImplicitBuildBrief(message)
  );
}

function hasBuildIntent(message: string, options: BuildOptions = {}): boolean {
  return options.forceBuild === true || isBuildRequest(message);
}

function isRuntimeRepairRequest(message: string): boolean {
  if (!RUNTIME_REPAIR_PATTERN.test(message)) return false;

  const explicitRuntimeError =
    /\b(referenceerror|typeerror|syntaxerror|rangeerror|server-side exception|application error|digest:|stack trace|module not found|cannot find module|hydration|build failed|compile error|compilation failed|next\.js error|react error)\b/i.test(
      message
    );

  if (!explicitRuntimeError && DESIGN_REVISION_PATTERN.test(message)) {
    return false;
  }

  return true;
}

function isQuestion(message: string): boolean {
  return QUESTION_PATTERN.test(message.trim());
}

function isVagueBuildRequest(message: string): boolean {
  const text = message.trim();
  if (!isBuildRequest(text)) return false;
  if (text.length > 80) return false;
  if (hasSpecificBuildSubject(text)) return false;
  return VERY_VAGUE_BUILD_PATTERN.test(text) || text.split(/\s+/).length <= 3;
}

function isUnderspecifiedPlanBuildRequest(message: string): boolean {
  const text = message.trim();
  if (!isBuildRequest(text)) return false;
  if (text.length > 280) return false;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 5) return true;

  return words.length <= 18 && !BUILD_DETAIL_PATTERN.test(text);
}

function hasSpecificBuildSubject(message: string): boolean {
  const words = normalizePromptText(message)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2);

  return words.some((word) => !GENERIC_BUILD_WORDS.has(word));
}

function getBuildProgressCopy(
  userMessage: string,
  stage: BuildProgress["stage"],
  percent: number,
  files?: string[]
): BuildProgress {
  const turkish = isLikelyTurkish(userMessage);
  const copy: Record<
    BuildProgress["stage"],
    { tr: [string, string]; en: [string, string] }
  > = {
    scan: {
      tr: ["Proje analiz ediliyor", "Mevcut dosyalar ve çalışma alanı okunuyor."],
      en: ["Analyzing project", "Reading the current files and workspace state."],
    },
    plan: {
      tr: ["Brief netleştiriliyor", "İstek sektöre, hedefe ve sayfa akışına çevriliyor."],
      en: ["Shaping the brief", "Translating the prompt into product, audience, and page flow."],
    },
    architect: {
      tr: ["Mimari plan çıkarılıyor", "Sayfalar, bileşenler, içerik dili ve kabul kriterleri netleştiriliyor."],
      en: ["Creating architecture", "Defining routes, components, content language, and acceptance criteria."],
    },
    draft: {
      tr: ["Kod yazılıyor", "Klawpen Core sayfa yapısını ve arayüz detaylarını üretiyor."],
      en: ["Writing code", "Klawpen Core is generating the page structure and UI details."],
    },
    review: {
      tr: ["Kalite kontrol yapılıyor", "Kod, tasarım hiyerarşisi ve uygulanabilirlik kontrol ediliyor."],
      en: ["Reviewing quality", "Checking code, design hierarchy, and applicability."],
    },
    validate: {
      tr: ["Kapsam doğrulanıyor", "Route, dil, bileşen ve animasyon gereksinimleri taslağa karşı kontrol ediliyor."],
      en: ["Validating scope", "Checking routes, language, components, and motion requirements against the draft."],
    },
    repair: {
      tr: ["Eksikler onarılıyor", "Eksik edit komutları veya bozuk çıktı düzeltiliyor."],
      en: ["Repairing output", "Fixing missing edit operations or invalid output."],
    },
    verify: {
      tr: ["Teknik doğrulama yapılıyor", "Opsiyonel build ve preview kontrolleri yalnızca güvenli modda çalıştırılıyor."],
      en: ["Running technical checks", "Optional build and preview gates run only in safe gated mode."],
    },
    apply: {
      tr: ["Dosyalar güncelleniyor", "Üretilen değişiklikler proje dosyalarına uygulanıyor."],
      en: ["Updating files", "Applying generated changes to the project files."],
    },
    refresh: {
      tr: ["Preview yenileniyor", "Çalışma alanı yeni değişiklikleri göstermek üzere hazırlanıyor."],
      en: ["Refreshing preview", "Preparing the workspace to show the latest changes."],
    },
  };
  const [title, description] = turkish ? copy[stage].tr : copy[stage].en;

  return {
    stage,
    title,
    description,
    percent,
    files,
  };
}

export function shouldUseConversationOnlyMode(
  userMessage: string,
  attachmentCount: number = 0,
  options: BuildOptions = {}
): boolean {
  if (options.forceBuild) return false;
  if (attachmentCount > 0) return false;
  const text = userMessage.trim();
  if (!text || text.length > 1_000) return false;
  if (isBuildRequest(text)) return false;
  return isQuestion(text) || text.split(/\s+/).length <= 20;
}

export function getConversationalShortcutReply(
  userMessage: string,
  attachmentCount: number = 0
): string | null {
  if (attachmentCount > 0) return null;

  const text = userMessage.trim();
  if (!text || text.length > 160 || isBuildRequest(text)) return null;

  const normalized = text
    .toLocaleLowerCase("tr-TR")
    .replace(/[!?.]+$/g, "")
    .trim();
  const compact = normalized.replace(/\s+/g, " ");
  const turkish = isLikelyTurkish(text);

  if (
    /^(kanka\s+)?(merhaba|selam|slm|sa|hello|hi|hey|naber|nas[ıi]ls[ıi]n|nas[ıi]l gidiyor)(\s+kanka)?$/.test(
      compact
    )
  ) {
    return turkish
      ? "Merhaba! Buradayım. İstersen bir soru sorabilir, istersen de ne oluşturmak veya değiştirmek istediğini yazabilirsin."
      : "Hey! I am here. You can ask a question, or tell me what you want to build or change.";
  }

  if (
    /^(te[sş]ekk[üu]rler|te[sş]ekk[üu]r ederim|tesekkurler|tesekkur ederim|sa[gğ] ol|sagol|eyvallah|thanks|thank you)$/.test(
      compact
    )
  ) {
    return turkish
      ? "Rica ederim! Bir sonraki değişikliği yazman yeterli."
      : "You're welcome! Send the next change whenever you're ready.";
  }

  if (
    /^(ne yapabilirsin|neler yapabilirsin|yard[ıi]m|help|what can you do)$/.test(
      compact
    )
  ) {
    return turkish
      ? "Bu projede sayfa, component, stil, içerik, paket ve dosya düzenlemeleri yapabilirim. Net bir değişiklik yazarsan doğrudan uygularım."
      : "I can edit pages, components, styles, copy, packages, and project files. Describe the change clearly and I will apply it.";
  }

  if (
    /^(bir [sş]ey sorabilir miyim|soru sorabilir miyim|sana bir [sş]ey soraca[gğ][ıi]m|can i ask|can i ask a question)$/.test(
      compact
    )
  ) {
    return turkish
      ? "Tabii, sorabilirsin. İstersen teknik, tasarım, iş modeli veya proje akışıyla ilgili sorunu yaz; net cevap vereyim."
      : "Of course. Ask anything about the project, design, backend, security, or workflow and I will answer clearly.";
  }

  return null;
}

export function getBuildClarificationReply(
  userMessage: string,
  options: BuildOptions = {}
): string | null {
  const wordCount = userMessage.trim().split(/\s+/).filter(Boolean).length;
  const needsClarification =
    isVagueBuildRequest(userMessage) ||
    (options.planMode &&
      (isUnderspecifiedPlanBuildRequest(userMessage) ||
        (options.forceBuild && wordCount <= 10))) ||
    (options.forceBuild && !hasSpecificBuildSubject(userMessage));

  if (!needsClarification) return null;

  const turkish = isLikelyTurkish(userMessage);

  return turkish
    ? [
        "Bunu kaliteli yapabilmem için önce birkaç noktayı netleştirelim:",
        "1. Hangi sektör veya ürün için olacak?",
        "2. Hedef kullanıcı kim ve ana amaç ne: satış, kayıt, randevu, demo veya portfolyo?",
        "3. Görsel tarz nasıl olsun: premium, minimal, kurumsal, yaratıcı veya daha cesur?",
        "",
        "İstersen cevap vermeden \"varsayılanlarla devam et\" yaz; ben profesyonel bir brief oluşturup ilerlerim.",
      ].join("\n")
    : [
        "To make this properly, let me clarify a few things first:",
        "1. What industry or product is this for?",
        "2. Who is the target user and main goal: sales, signup, booking, demo, or portfolio?",
        "3. What visual direction should it follow: premium, minimal, corporate, creative, or bold?",
        "",
        "If you prefer, reply \"continue with defaults\" and I will create a professional brief before building.",
      ].join("\n");
}

const PLANNER_SYSTEM_PROMPT = `
You are a senior product strategist for a coding agent.
Given a user's request, produce an implementation brief in concise plain text with:
1) Goal
2) Audience
3) UI/UX Direction
4) Information Architecture
5) Required Routes and Sections
6) Technical Plan
7) Acceptance Checklist
8) Design Differentiators

Only produce an implementation brief when the user clearly asks to build,
change, update, remove, design, or implement something.

If the request is a greeting, thanks, status check, question, or ambiguous
conversation, explicitly say no implementation is required and recommend a
plain conversational answer without code-edit tags.

If a short request has clear build intent, infer missing details professionally.
Treat compact product/design briefs as build requests even if the user does not say "build", "create", "make", "yap", or "oluştur".
Examples that are build requests: "modern restaurant website with menu and reservation", "diş kliniği premium landing page", "SaaS dashboard with auth and pricing".
Do not create a generic SaaS/agency brief unless the user's domain is actually SaaS/agency.
If the user names a sector, make the brief sector-specific: page order, proof points,
CTA logic, objections, copy tone, and visual direction must match that sector.
The generated preview UI must use the user's prompt language for all visible copy:
- navigation labels, route titles, hero text, CTAs, cards, FAQ, forms, error/empty states, metadata, and microcopy
- code identifiers may stay in English, but customer-visible text must not switch language
- if the prompt is Turkish, use correct Turkish characters such as ç, ğ, ı, İ, ö, ş, ü
For broad website/app requests, plan a real multi-route project by default:
- Home route plus 2-4 supporting routes such as about, services/features, pricing/menu/treatments, FAQ, contact, dashboard, or blog when sensible.
- Shared content/config data, reusable components, responsive navigation, and meaningful page transitions.
- Use a modern animated visual system unless the user explicitly asks for static/minimal.
`;

const BUILDER_SYSTEM_PROMPT = `
You are Klawpen Core, a senior full-stack product engineer, frontend architect, UX director, and implementation lead.
Deliver production-minded quality:
- responsive layout
- semantic and accessible structure
- maintainable code
- strong visual hierarchy
- modern motion/animation by default unless the user explicitly asks for static/minimal
- avoid generic repetitive template output
- never produce the same landing page with only the logo/title changed
- never reuse the same visual skeleton across unrelated prompts; the silhouette, section order, composition, card geometry, typography, palette, and motion must visibly change by domain and visual archetype
- avoid the default "nav + centered hero + stat cards + three feature cards + FAQ" skeleton unless the prompt explicitly asks for a conventional SaaS landing page
- use the ARCHITECT SPEC and VISUAL ARCHETYPE as hard product direction, not inspiration
- infer the industry, audience, product promise, trust objections, and CTA from the prompt
- make every generated page visibly prompt-specific through copy, layout, proof, section order, and visual language
- choose a distinct design direction per request: editorial, luxury service, operational dashboard, boutique studio, local business, or clean SaaS when appropriate
- when implementing, output executable edit tags only; plain markdown code is not applied
- for any new website/application, rewrite src/app/page.tsx at minimum
- for broad website/application builds, create a real multi-page App Router project by default: home plus 2-4 supporting routes such as src/app/about/page.tsx, src/app/services/page.tsx, src/app/pricing/page.tsx, src/app/faq/page.tsx, src/app/contact/page.tsx, src/app/dashboard/page.tsx, or domain-specific equivalents
- only keep a broad build as one page when the user explicitly asks for a single-page/one-page/landing-only result
- split the implementation into real files instead of dumping everything into one page: page routes, at least one shared component file, and at least one content/config/data file
- prefer a complete, polished implementation over shallow file count, but never use a tiny one-file toy page for a broad build
- do not use placeholder copy, fake generic stats, lorem ipsum, or repeated card names
- when the request implies a website, create a coherent site experience, not only a decorative hero section
- if multiple pages are explicitly requested, create real App Router pages and navigation
- if pages are not specified, infer the strongest sensible information architecture and implement several real routes
- make the result feel closer to a polished Replit/Lovable-quality prototype than a simple landing-page template
- include thoughtful empty states, microcopy, responsive behavior, conversion logic, hover states, and page/section transitions where relevant
- ask focused questions only when missing information would materially change the product; otherwise make professional defaults and build
- for full website requests, build at least 7 meaningful sections across multiple routes unless the requested scope is smaller
- generated sites must have a clear visual concept: color system, spacing rhythm, typography scale, card geometry, and section transitions
- do not generate a centered hero followed by identical cards unless the user explicitly asks for a minimal template
- if the visual archetype forbids a pattern, do not use that pattern
- every build should include at least one prompt-specific visual metaphor or interaction: menu board, appointment flow, legal case timeline, product console, booking widget, catalog shelf, event ticket, map strip, ROI panel, etc.
- when the user asks for pages such as pricing, FAQ, contact, dashboard, login, register, blog, or about, create those routes/files instead of only naming them in nav
- keep copy in the user's language and make it specific enough that it cannot be reused for an unrelated sector
- all customer-visible UI copy must match the user's prompt language: navigation, headings, CTA buttons, route page titles, form labels, FAQ, cards, status/empty/error text, and metadata
- if the prompt is Turkish, use natural Turkish with Turkish characters; do not leave English labels such as Home, Services, About, Contact, Get Started, Learn More, Features, Pricing, or FAQ in the preview
- code identifiers, component names, filenames, and comments may stay in English; only visible UI copy must follow the prompt language
- Klawpen is the builder brand, not the default brand for the generated customer website; do not name the generated project "Klawpen", "Klawpen Cloud", or "Klawpen Studio" unless the user explicitly asks for it
- client-facing copy rule: visible preview text must speak as the generated business, product, publication, or service itself; never as Klawpen, an AI, a freelancer, an agency proposal, or a site builder describing the work
- never put implementation/meta words in visible UI copy: prompt, generated, AI, yapay zeka, Klawpen, Core, Builder, template, şablon, fallback, component, design direction, tasarım yönü, first version, ilk sürüm, launch-ready, yayına hazır, freelancer, proposal, tasarım süreci, gelişmiş studio
- do not append "Studio", "Works", "Labs", "Agency", or "Ajans" as a lazy fallback brand unless the user's sector clearly makes that name natural
- design scale rule: avoid crude oversized typography and giant empty cards; prefer refined clamp ranges, compact navigation/buttons, realistic content density, balanced whitespace, and smaller mobile-first cards
- every page must feel like a finished public-facing website for a real client: no internal planning labels, no "we are building this", no "design direction", no "first version", no placeholder/fallback wording
`;

const CRITIC_SYSTEM_PROMPT = `
You are a strict software + design quality reviewer.
Evaluate the assistant output and return EXACTLY this format:

SCORE: <0-100>
VERDICT: <PASS or FAIL>
FEEDBACK:
- <short actionable point 1>
- <short actionable point 2>
- <short actionable point 3>

Scoring criteria:
- Implementation completeness
- Multi-route information architecture for broad website/app requests
- UI/UX quality and hierarchy
- Responsiveness expectations
- Code quality / maintainability
- Avoidance of generic template output
- Visual diversity versus prior/common template silhouettes
- Product-specific information architecture, not just a hero and generic cards
- Professional visual craft: typography, spacing, palette, sections, motion, states, and conversion flow

Rules:
- PASS only if score >= required minimum and quality is clearly strong.
- FAIL generic/simple landing pages that could fit any industry after only changing the logo.
- FAIL outputs that ignore requested pages or do not create routes for explicitly requested pages.
- FAIL broad website/application builds that create only one page unless the user explicitly requested a one-page/landing-only result.
- FAIL broad website/application builds with fewer than 3 real App Router page files.
- FAIL outputs with fewer than 7 meaningful sections across the project for broad website/app requests unless the user asked for something intentionally small.
- FAIL when the visual system is basic, repeated, or looks like a logo/title swap.
- FAIL outputs that look like the same generated site skeleton with only copy/colors changed.
- FAIL if the output uses the forbidden patterns from the visual archetype brief.
- FAIL if a local service, restaurant, clinic, legal, commerce, event, dashboard, or developer tool prompt receives a generic SaaS/agency landing layout.
- FAIL broad website/application builds that lack shared components/content/config structure.
- FAIL broad website/application builds that have no purposeful animation, transition, hover state, or motion system unless the user requested static/minimal.
- FAIL outputs where visible UI copy uses a different language than the user's prompt.
- FAIL Turkish-prompt outputs that leave common English UI labels visible, such as Home, Services, About, Contact, Get Started, Learn More, Features, Pricing, or FAQ.
- FAIL outputs that use Klawpen, Klawpen Cloud, or Klawpen Studio as the generated customer brand unless the user explicitly requested Klawpen itself.
- FAIL outputs with visible builder/meta language such as prompt, generated, AI, yapay zeka, Klawpen, Core, Builder, template, şablon, fallback, component, design direction, tasarım yönü, first version, ilk sürüm, launch-ready, yayına hazır, freelancer, proposal, or "gelişmiş studio".
- FAIL outputs that sound like a freelancer/agency explaining a draft instead of a real business speaking to its customers.
- FAIL outputs with crude oversized headings, oversized CTA buttons, huge empty cards, decorative panels without useful content, or low-density sections that look AI-generated.
- Keep feedback specific and actionable.
`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < retries) {
        await sleep(500 * (i + 1));
      }
    }
  }
  throw lastError;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function supportsResponsesApi(provider: AiProviderConfig): boolean {
  const baseUrl = provider.baseUrl.toLowerCase();
  return (
    baseUrl.includes("api.openai.com") ||
    process.env.AI_FORCE_RESPONSES_API === "true"
  );
}

function clipText(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength)}\n\n[TRUNCATED_FOR_CONTEXT]`;
}

function buildMessageContent(message: string, attachments: Attachment[] = []): any[] {
  const content: any[] = [{ type: "text", text: message }];

  for (const attachment of attachments) {
    if (attachment.type === "image") {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${attachment.mimeType};base64,${attachment.data}`,
        },
      });
    } else if (attachment.type === "document") {
      const decodedText = Buffer.from(attachment.data, "base64").toString("utf-8");
      content.push({
        type: "text",
        text: `\n\nDocument "${attachment.name}" content:\n${decodedText}`,
      });
    }
  }

  return content;
}

function extractResponseText(resp: any): string {
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text;
  }

  const parts: string[] = [];
  for (const item of resp?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === "string") parts.push(c.text);
      if (typeof c?.output_text === "string") parts.push(c.output_text);
      if (typeof c?.value === "string") parts.push(c.value);
    }
  }

  const out = parts.join("").trim();
  return out || "Sorry, I could not generate a response.";
}

function extractChatCompletionText(resp: any): string {
  const text = resp?.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim()
    ? text.trim()
    : "Sorry, I could not generate a response.";
}

async function createAiText(params: {
  provider: AiProviderConfig;
  input: string;
  temperature?: number;
  retries?: number;
}): Promise<string> {
  const client = getAiClient(params.provider);
  const temperature = params.temperature ?? aiTemperature;
  const retries = params.retries ?? aiMaxRetries;

  const createChatCompletion = async () => {
    const response = await withRetries(
      () =>
        withTimeout(
          client.chat.completions.create({
            model: params.provider.model,
            messages: [{ role: "user", content: params.input }],
            // @ts-ignore
            temperature,
          }),
          AI_REQUEST_TIMEOUT_MS,
          `${params.provider.key} chat completion`
        ),
      retries
    );

    recordProviderRequest(params.provider.key);
    return extractChatCompletionText(response);
  };

  if (!supportsResponsesApi(params.provider)) {
    return createChatCompletion();
  }

  try {
    const response = await withRetries(
      () =>
        withTimeout(
          client.responses.create({
            model: params.provider.model,
            input: params.input,
            // @ts-ignore
            temperature,
          }),
          AI_REQUEST_TIMEOUT_MS,
          `${params.provider.key} responses request`
        ),
      retries
    );

    recordProviderRequest(params.provider.key);
    return extractResponseText(response);
  } catch (responsesError) {
    console.warn(
      "Responses API failed; falling back to chat completions:",
      responsesError instanceof Error ? responsesError.message : responsesError
    );

    return createChatCompletion();
  }
}

async function createAiChatText(params: {
  provider: AiProviderConfig;
  system: string;
  user: string | any[];
  temperature?: number;
  retries?: number;
  timeoutMs?: number;
}): Promise<string> {
  const client = getAiClient(params.provider);
  const temperature = params.temperature ?? aiTemperature;
  const retries = params.retries ?? aiMaxRetries;
  const timeoutMs = params.timeoutMs ?? AI_REQUEST_TIMEOUT_MS;

  const response = await withRetries(
    () =>
      withTimeout(
        client.chat.completions.create({
          model: params.provider.model,
          messages: [
            { role: "system", content: params.system },
            { role: "user", content: params.user },
          ],
          // @ts-ignore
          temperature,
        }),
        timeoutMs,
        `${params.provider.key} structured chat completion`
      ),
    retries
  );

  recordProviderRequest(params.provider.key);
  return extractChatCompletionText(response);
}

function buildFlattenedInput(messages: Array<{ role: string; content: any }>): string {
  return messages
    .map((m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${m.role.toUpperCase()}:\n${c}`;
    })
    .join("\n\n");
}

function parseCriticResult(text: string): CriticResult {
  const scoreMatch = text.match(/SCORE:\s*(\d{1,3})/i);
  const verdictMatch = text.match(/VERDICT:\s*(PASS|FAIL)/i);

  const score = scoreMatch ? Number(scoreMatch[1]) : 0;
  const verdictRaw = verdictMatch?.[1]?.toUpperCase() ?? "FAIL";
  const verdict: "PASS" | "FAIL" = verdictRaw === "PASS" ? "PASS" : "FAIL";

  let feedback = text;
  const feedbackStart = text.search(/FEEDBACK:/i);
  if (feedbackStart >= 0) {
    feedback = text.slice(feedbackStart + "FEEDBACK:".length).trim();
  }

  return {
    score: Number.isFinite(score) ? Math.min(Math.max(score, 0), 100) : 0,
    verdict,
    feedback: feedback || "- Improve overall quality and completeness.",
  };
}

function normalizeProjectPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/^\/app\/my-nextjs-app\/?/, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function getFileName(filePath: string): string {
  const normalized = normalizeProjectPath(filePath);
  return normalized.split("/").filter(Boolean).pop() || normalized || filePath;
}

function getDirectoryName(filePath: string): string {
  const normalized = normalizeProjectPath(filePath);
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") || "root";
}

function splitCodeLines(content: string): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmedTrailingNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  return trimmedTrailingNewline ? trimmedTrailingNewline.split("\n") : [];
}

function countLineDelta(
  beforeContent: string | undefined,
  afterContent: string
): { additions: number; deletions: number } {
  const beforeLines = splitCodeLines(beforeContent || "");
  const afterLines = splitCodeLines(afterContent || "");

  if (beforeContent === undefined) {
    return { additions: afterLines.length, deletions: 0 };
  }

  if (beforeLines.length === 0) {
    return { additions: afterLines.length, deletions: 0 };
  }

  if (afterLines.length === 0) {
    return { additions: 0, deletions: beforeLines.length };
  }

  if (beforeLines.length * afterLines.length > 900_000) {
    return {
      additions: Math.max(0, afterLines.length - beforeLines.length),
      deletions: Math.max(0, beforeLines.length - afterLines.length),
    };
  }

  let previous = new Array(afterLines.length + 1).fill(0);
  let current = new Array(afterLines.length + 1).fill(0);

  for (let i = 1; i <= beforeLines.length; i++) {
    for (let j = 1; j <= afterLines.length; j++) {
      current[j] =
        beforeLines[i - 1] === afterLines[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous.fill(0)];
  }

  const unchanged = previous[afterLines.length] || 0;
  return {
    additions: Math.max(0, afterLines.length - unchanged),
    deletions: Math.max(0, beforeLines.length - unchanged),
  };
}

function flattenFileContentTree(
  items: fileService.FileContentItem[],
  files = new Map<string, string>()
): Map<string, string> {
  for (const item of items) {
    if (item.type === "file" && typeof item.content === "string") {
      files.set(normalizeProjectPath(item.path), item.content);
    }

    if (item.children?.length) {
      flattenFileContentTree(item.children, files);
    }
  }

  return files;
}

function appendChangeSummaryTag(
  assistantContent: string,
  fileContentTree: fileService.FileContentItem[]
): string {
  const snapshotFiles = flattenFileContentTree(fileContentTree);
  const changedFiles: Array<{
    path: string;
    name: string;
    directory: string;
    operation: "created" | "updated" | "deleted" | "renamed";
    additions: number;
    deletions: number;
    fromPath?: string;
  }> = [];
  const dependencies: string[] = [];

  const writePattern =
    /<dec-write\s+(?:path|file_path)="([^"]+)">([\s\S]*?)<\/dec-write>/g;
  const renamePattern =
    /<dec-rename\s+from="([^"]+)"\s+to="([^"]+)"\s*\/>/g;
  const deletePattern =
    /<dec-delete\s+(?:path|file_path)="([^"]+)"\s*\/>/g;
  const dependencyPattern =
    /<dec-add-dependency(?:\s+name="([^"]+)"(?:\s+version="([^"]+)")?)?>(.*?)<\/dec-add-dependency>/g;

  const operations: Array<{
    type: "write" | "rename" | "delete" | "dependency";
    index: number;
    match: RegExpExecArray;
  }> = [];

  let match: RegExpExecArray | null;

  while ((match = writePattern.exec(assistantContent)) !== null) {
    operations.push({ type: "write", index: match.index, match });
  }

  while ((match = renamePattern.exec(assistantContent)) !== null) {
    operations.push({ type: "rename", index: match.index, match });
  }

  while ((match = deletePattern.exec(assistantContent)) !== null) {
    operations.push({ type: "delete", index: match.index, match });
  }

  while ((match = dependencyPattern.exec(assistantContent)) !== null) {
    operations.push({ type: "dependency", index: match.index, match });
  }

  operations.sort((left, right) => left.index - right.index);

  for (const operation of operations) {
    if (operation.type === "dependency") {
      const packageName = (
        operation.match[1] ||
        operation.match[3] ||
        ""
      ).trim();
      if (packageName) dependencies.push(packageName);
      continue;
    }

    if (operation.type === "rename") {
      const fromPathRaw = operation.match[1];
      const toPathRaw = operation.match[2];
      if (!fromPathRaw || !toPathRaw) continue;

      const fromPath = normalizeProjectPath(fromPathRaw);
      const toPath = normalizeProjectPath(toPathRaw);
      const previousContent = snapshotFiles.get(fromPath);

      changedFiles.push({
        path: toPath,
        name: getFileName(toPath),
        directory: getDirectoryName(toPath),
        operation: "renamed",
        additions: 0,
        deletions: 0,
        fromPath,
      });

      snapshotFiles.delete(fromPath);
      if (previousContent !== undefined) {
        snapshotFiles.set(toPath, previousContent);
      }
      continue;
    }

    const filePathRaw = operation.match[1];
    if (!filePathRaw) continue;

    const filePath = normalizeProjectPath(filePathRaw);
    const previousContent = snapshotFiles.get(filePath);

    if (operation.type === "delete") {
      const removedLines = splitCodeLines(previousContent || "").length;
      changedFiles.push({
        path: filePath,
        name: getFileName(filePath),
        directory: getDirectoryName(filePath),
        operation: "deleted",
        additions: 0,
        deletions: removedLines,
      });
      snapshotFiles.delete(filePath);
      continue;
    }

    const nextContentRaw = operation.match[2];
    if (nextContentRaw === undefined) continue;

    const nextContent = nextContentRaw.trim();
    const delta = countLineDelta(previousContent, nextContent);

    changedFiles.push({
      path: filePath,
      name: getFileName(filePath),
      directory: getDirectoryName(filePath),
      operation: previousContent === undefined ? "created" : "updated",
      additions: delta.additions,
      deletions: delta.deletions,
    });
    snapshotFiles.set(filePath, nextContent);
  }

  if (!changedFiles.length && !dependencies.length) {
    return assistantContent.replace(
      /<dec-change-summary>[\s\S]*?<\/dec-change-summary>/g,
      ""
    );
  }

  const folders = Array.from(
    changedFiles.reduce((folderMap, file) => {
      folderMap.set(file.directory, (folderMap.get(file.directory) || 0) + 1);
      return folderMap;
    }, new Map<string, number>())
  ).map(([path, count]) => ({ path, count }));

  const summary = {
    files: changedFiles,
    folders,
    dependencies,
    totals: {
      files: changedFiles.length,
      folders: folders.length,
      additions: changedFiles.reduce((total, file) => total + file.additions, 0),
      deletions: changedFiles.reduce((total, file) => total + file.deletions, 0),
      dependencies: dependencies.length,
    },
  };

  const cleanedContent = assistantContent.replace(
    /<dec-change-summary>[\s\S]*?<\/dec-change-summary>/g,
    ""
  );

  return `${cleanedContent}\n<dec-change-summary>${JSON.stringify(
    summary
  )}</dec-change-summary>`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`${name}=(["'])([\\s\\S]*?)\\1`, "i");
  const match = tag.match(pattern);
  return match?.[2] ? decodeHtmlEntities(match[2]) : null;
}

function extractCodeOperations(assistantContent: string): CodeOperation[] {
  const operations: CodeOperation[] = [];

  const writePattern = /<dec-write\b([^>]*)>([\s\S]*?)<\/dec-write>/gi;
  const renamePattern = /<dec-rename\b([^>]*?)\/>/gi;
  const deletePattern = /<dec-delete\b([^>]*?)\/>/gi;
  const dependencyPattern = /<dec-add-dependency\b([^>]*)>([\s\S]*?)<\/dec-add-dependency>/gi;

  let match: RegExpExecArray | null;

  while ((match = writePattern.exec(assistantContent)) !== null) {
    const path = extractAttribute(match[1] || "", "path") ||
      extractAttribute(match[1] || "", "file_path");
    const content = match[2];

    if (path && content !== undefined) {
      operations.push({
        type: "write",
        index: match.index,
        path,
        content: content.trim(),
      });
    }
  }

  while ((match = renamePattern.exec(assistantContent)) !== null) {
    const from = extractAttribute(match[1] || "", "from");
    const to = extractAttribute(match[1] || "", "to");

    if (from && to) {
      operations.push({ type: "rename", index: match.index, from, to });
    }
  }

  while ((match = deletePattern.exec(assistantContent)) !== null) {
    const path = extractAttribute(match[1] || "", "path") ||
      extractAttribute(match[1] || "", "file_path");

    if (path) {
      operations.push({ type: "delete", index: match.index, path });
    }
  }

  while ((match = dependencyPattern.exec(assistantContent)) !== null) {
    const nameAttr = extractAttribute(match[1] || "", "name");
    const version = extractAttribute(match[1] || "", "version") || undefined;
    const packageName = (nameAttr || match[2] || "").trim();

    if (packageName) {
      operations.push({
        type: "dependency",
        index: match.index,
        packageName,
        version,
      });
    }
  }

  return operations.sort((left, right) => left.index - right.index);
}

function extractMarkdownCodeOperations(assistantContent: string): CodeOperation[] {
  const operations: CodeOperation[] = [];
  const filePathPattern =
    "(?:src|app|components|lib|styles|public)/[^`\\n]+\\.(?:tsx|ts|jsx|js|css|json|mdx?)";
  const fencePattern = new RegExp(
    `(?:^|\\n)\\s*(?:[-*]\\s*)?(?:(?:file|path|filename)\\s*:?\\s*)?[\\\`"']?(${filePathPattern})[\\\`"']?\\s*:?\\s*\\n\\s*\\\`\\\`\\\`[a-zA-Z0-9_-]*\\n([\\s\\S]*?)\\\`\\\`\\\``,
    "gi"
  );
  const headingFencePattern = new RegExp(
    `(?:^|\\n)\\s{0,3}(?:#{1,6}\\s*)?[\\\`"']?(${filePathPattern})[\\\`"']?\\s*\\n\\s*\\\`\\\`\\\`[a-zA-Z0-9_-]*\\n([\\s\\S]*?)\\\`\\\`\\\``,
    "gi"
  );
  let match: RegExpExecArray | null;

  const pushMatch = (match: RegExpExecArray) => {
    const filePath = match[1]?.trim();
    const content = match[2];

    if (filePath && content !== undefined) {
      if (operations.some((operation) => operation.path === filePath)) return;
      operations.push({
        type: "write",
        index: match.index,
        path: filePath,
        content: content.trim(),
      });
    }
  };

  while ((match = fencePattern.exec(assistantContent)) !== null) {
    pushMatch(match);
  }

  while ((match = headingFencePattern.exec(assistantContent)) !== null) {
    pushMatch(match);
  }

  return operations.sort((left, right) => left.index - right.index);
}

function shouldForceFallbackPage(
  userMessage: string,
  assistantContent: string,
  options: BuildOptions = {}
) {
  if (!hasBuildIntent(userMessage, options)) return false;
  if (extractCodeOperations(assistantContent).length > 0) return false;
  if (extractMarkdownCodeOperations(assistantContent).length > 0) return false;

  return true;
}

function hasExecutableCodeOperations(assistantContent: string) {
  return (
    extractCodeOperations(assistantContent).length > 0 ||
    extractMarkdownCodeOperations(assistantContent).length > 0
  );
}

function getExecutableCodeOperations(assistantContent: string): CodeOperation[] {
  const taggedOperations = extractCodeOperations(assistantContent);
  return taggedOperations.length > 0
    ? taggedOperations
    : extractMarkdownCodeOperations(assistantContent);
}

function isBroadBuildRequest(message: string, options: BuildOptions = {}) {
  if (!hasBuildIntent(message, options)) return false;

  const normalized = normalizePromptText(message);
  const hasCreationIntent =
    /\b(yap|yapalim|olustur|hazirla|kur|tasarla|kodla|build|create|make|design|generate)\b/.test(
      normalized
    ) ||
    (/\b(istiyorum|lazim|ihtiyacim|need|want)\b/.test(normalized) &&
      /\b(site|website|web sitesi|landing|landing page|sayfa|dashboard|panel|app|uygulama|platform|product|urun|proje)\b/.test(
        normalized
      )) ||
    isImplicitBuildBrief(message);

  if (!hasCreationIntent && options.forceBuild !== true) return false;

  return (
    /\b(site|website|web sitesi|landing|landing page|sayfa|dashboard|panel|app|uygulama|platform|product|urun|proje)\b/.test(
      normalized
    ) || options.forceBuild === true
  );
}

function resolveBuildOptions(
  userMessage: string,
  options: BuildOptions = {},
  workloadEstimate?: AiWorkloadEstimate
): ResolvedBuildOptions {
  const broadBuild =
    isBroadBuildRequest(userMessage, options) &&
    !isExplicitSinglePageRequest(userMessage);
  const explicitlyPower =
    options.powerMode === true || options.qualityMode === "power";
  const explicitlyFast = options.qualityMode === "fast";
  const workloadIsHeavy =
    workloadEstimate?.tier === "heavy" || workloadEstimate?.tier === "extreme";
  const powerMode =
    !explicitlyFast &&
    (explicitlyPower ||
      (POWER_BUILD_AUTO_ENABLED &&
        (broadBuild || workloadIsHeavy || options.planMode === true)));

  const qualityMode: ResolvedBuildOptions["qualityMode"] = powerMode
    ? "power"
    : explicitlyFast
      ? "fast"
      : "standard";

  return {
    ...options,
    qualityMode,
    powerMode,
  };
}

function shouldUsePowerBuildLayer(options: BuildOptions = {}) {
  return options.powerMode === true || options.qualityMode === "power";
}

function getWriteOperations(assistantContent: string) {
  return getExecutableCodeOperations(assistantContent).filter(
    (operation) => operation.type === "write" && operation.path
  );
}

function isExplicitSinglePageRequest(message: string) {
  const normalized = normalizePromptText(message);

  return /\b(tek sayfa|one page|single page|landing only|landing-only|sadece landing|yalniz landing|yalnizca landing|only landing)\b/.test(
    normalized
  );
}

function getRouteWriteCount(writes: CodeOperation[]) {
  return writes.filter((operation) =>
    /^src\/app\/(?:page|[^/]+\/page)\.tsx$/.test(
      normalizeProjectPath(operation.path || "")
    )
  ).length;
}

function getSupportingRouteWriteCount(writes: CodeOperation[]) {
  return writes.filter((operation) =>
    /^src\/app\/[^/]+\/page\.tsx$/.test(
      normalizeProjectPath(operation.path || "")
    )
  ).length;
}

function hasContentStructure(writes: CodeOperation[]) {
  return writes.some((operation) =>
    /^src\/(lib|data|config)\//.test(normalizeProjectPath(operation.path || ""))
  );
}

function hasComponentStructure(writes: CodeOperation[]) {
  return writes.some((operation) =>
    /^src\/components\//.test(normalizeProjectPath(operation.path || ""))
  );
}

function hasMotionSystem(writes: CodeOperation[]) {
  const combined = writes.map((operation) => operation.content || "").join("\n");

  return /\b(animate-|transition-|duration-|ease-|hover:|group-hover:|motion-safe|@keyframes|animation:|framer-motion|whileHover|initial=|animate=)\b/.test(
    combined
  );
}

function getCombinedWrittenContent(assistantContent: string): string {
  return getWriteOperations(assistantContent)
    .map((operation) => operation.content || "")
    .join("\n");
}

const BUILDER_META_VISIBLE_COPY_PATTERNS = [
  /\bprompt\b/i,
  /\bgenerated\b/i,
  /\bAI\b/i,
  /\byapay\s+zeka\b/i,
  /\bKlawpen\s*(?:Core|Builder|Studio|Cloud|Dashboard|AI)?\b/i,
  /\bBuilder\b/i,
  /\btemplate\b/i,
  /\bşablon\b/i,
  /\bfallback\b/i,
  /\bcomponent\b/i,
  /\bdesign\s+direction\b/i,
  /\btasarım\s+yönü\b/i,
  /\bfirst\s+version\b/i,
  /\bilk\s+sürüm\b/i,
  /\blaunch-ready\b/i,
  /\byayına\s+hazır\b/i,
  /\bfreelancer\b/i,
  /\bproposal\b/i,
  /\bgelişmiş\s+studio\b/i,
  /\badvanced\s+studio\b/i,
];

function decodeStringLiteral(value: string) {
  return value
    .replace(/\\n/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\`/g, "`")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeCodeOnlyString(value: string) {
  const text = value.trim();
  if (!text) return true;
  if (/[\\/]/.test(text)) return true;
  if (/\.(tsx?|jsx?|css|json|mdx?)\b/i.test(text)) return true;
  if (/^#(?:[0-9a-f]{3,8})$/i.test(text)) return true;
  if (/\b(?:flex|grid|rounded|text-|bg-|px-|py-|mx-|my-|mt-|mb-|gap-|shadow|border|transition|duration|hover:|focus:|items-|justify-|max-w-|min-h-)\b/.test(text)) {
    return true;
  }
  if (/^(?:true|false|null|undefined|use client|use server)$/i.test(text)) {
    return true;
  }
  if (BUILDER_META_VISIBLE_COPY_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }
  return false;
}

function getLikelyVisibleUiCopy(assistantContent: string) {
  const combined = getCombinedWrittenContent(assistantContent)
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const chunks: string[] = [];
  const stringPattern = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  const jsxTextPattern = />\s*([^<>{}\n][^<>{}]*)\s*</g;
  let match: RegExpExecArray | null;

  while ((match = stringPattern.exec(combined)) !== null) {
    const value = decodeStringLiteral(match[2] || "");
    if (!value) continue;
    const hasNaturalLanguage =
      /\s/.test(value) ||
      /[çğıİöşü]/i.test(value) ||
      BUILDER_META_VISIBLE_COPY_PATTERNS.some((pattern) => pattern.test(value));
    if (!hasNaturalLanguage || looksLikeCodeOnlyString(value)) continue;
    chunks.push(value);
  }

  while ((match = jsxTextPattern.exec(combined)) !== null) {
    const value = decodeStringLiteral(match[1] || "");
    if (!value || looksLikeCodeOnlyString(value)) continue;
    chunks.push(value);
  }

  return chunks.join("\n");
}

function hasBuilderMetaVisibleCopy(
  userMessage: string,
  assistantContent: string
) {
  const visibleCopy = getLikelyVisibleUiCopy(assistantContent);
  if (!visibleCopy) return false;
  const allowKlawpen = /\bklawpen\b/i.test(userMessage);
  const allowAi = /\b(ai|artificial intelligence|yapay zeka)\b/i.test(userMessage);

  return BUILDER_META_VISIBLE_COPY_PATTERNS.some((pattern) => {
    if (allowKlawpen && pattern.source.includes("Klawpen")) return false;
    if (allowAi && (pattern.source.includes("\\bAI") || pattern.source.includes("yapay"))) {
      return false;
    }
    return pattern.test(visibleCopy);
  });
}

function hasOversizedCrudeVisualSystem(assistantContent: string) {
  const combined = getCombinedWrittenContent(assistantContent);
  const oversizedTypeSignals = [
    /clamp\([^)]*(?:7|8|9|10)rem/gi,
    /\btext-(?:7xl|8xl|9xl)\b/g,
  ].reduce((count, pattern) => count + (combined.match(pattern) || []).length, 0);
  const oversizedSpacingSignals = [
    /\b(?:px|p)-(?:10|12|14|16)\b/g,
    /\b(?:py)-(?:6|8|10|12)\b/g,
  ].reduce((count, pattern) => count + (combined.match(pattern) || []).length, 0);
  const sparseDecorativePanels = (
    combined.match(/aspect-\[[^\]]+\][^>]*(?:\/>|>\s*<\/div>)/g) || []
  ).length;

  return (
    oversizedTypeSignals >= 2 ||
    (oversizedTypeSignals >= 1 &&
      oversizedSpacingSignals >= 2 &&
      sparseDecorativePanels >= 2)
  );
}

function hasGenericLandingSkeleton(assistantContent: string): boolean {
  const combined = getCombinedWrittenContent(assistantContent);
  if (!combined) return false;

  const centeredHeroSignals = [
    /text-center/g,
    /mx-auto[^"\n]*(max-w-|text-)/g,
    /justify-center/g,
    /items-center/g,
  ].reduce((count, pattern) => count + (combined.match(pattern) || []).length, 0);
  const repeatedCardSignals = [
    /\.map\(\(/g,
    /grid[^"\n]*(md:grid-cols-3|lg:grid-cols-3)/g,
    /rounded-\[?2/g,
    /stats\.map|features\.map|services\.map/gi,
  ].reduce((count, pattern) => count + (combined.match(pattern) || []).length, 0);
  const genericSectionSignals = [
    /\b(hero|features|services|stats|workflow|proof|faq|contact)\b/gi,
    /\b(Feature|Service|Solution|Workflow|Proof|FAQ)\b/g,
  ].reduce((count, pattern) => count + (combined.match(pattern) || []).length, 0);

  return (
    centeredHeroSignals >= 7 &&
    repeatedCardSignals >= 8 &&
    genericSectionSignals >= 14
  );
}

function getVisualDiversityIssues(
  userMessage: string,
  assistantContent: string,
  spec: ArchitectSpec | null
): string[] {
  const issues: string[] = [];
  const archetype = selectVisualArchetype(userMessage);
  const combined = getCombinedWrittenContent(assistantContent);
  const normalizedContent = normalizePromptText(combined);
  const normalizedPrompt = normalizePromptText(userMessage);

  if (!combined) return issues;

  if (hasGenericLandingSkeleton(assistantContent)) {
    issues.push(
      "The implementation appears to reuse a generic centered hero/stats/cards/FAQ skeleton; create a distinct page silhouette and section rhythm."
    );
  }

  if (hasOversizedCrudeVisualSystem(assistantContent)) {
    issues.push(
      "The visual system looks oversized or low-density; reduce headline/button/card scale and add useful content density with refined spacing."
    );
  }

  if (
    /\b(blog|magazin|magazine|haber|news|article|makale|yazar|icerik|içerik|publishing|yayin|yayın)\b/.test(
      normalizedPrompt
    )
  ) {
    const blogSignals = [
      /\b(article|articles|blog|post|posts|story|stories|magazine|editor|author|newsletter|topic|category|reading time|read time)\b/i,
      /\b(yaz[ıi]|makale|haber|dosya|edit[öo]r|yazar|b[üu]lten|kategori|konu|okuma s[üu]resi)\b/i,
    ];

    if (!blogSignals.some((pattern) => pattern.test(combined))) {
      issues.push(
        "Blog/editorial request lacks real publication modules: add featured story, article cards, categories, authors, reading-time metadata, and newsletter capture."
      );
    }

    if (/\b(Anlaml[ıi] b[öo]l[üu]m|Net d[öo]n[üu][sş][üu]m ad[ıi]m[ıi]|First-value clarity|Meaningful sections|Clear conversion steps)\b/i.test(combined)) {
      issues.push(
        "Blog/editorial request contains generic landing-page stats; replace them with editorial metrics, article metadata, or topic/author details."
      );
    }
  }

  const archetypePatternMap: Record<string, RegExp[]> = {
    "editorial-luxury": [/pull|quote|story|magazine|editorial|serif|prose/i, /grid-cols-\[|asym|span-2|col-span/i],
    "neo-brutal-product": [/border-2|border-4|shadow-\[|uppercase|tracking-\[/i, /rotate-|translate-|offset|sticker/i],
    "operational-dashboard": [/metric|analytics|status|workflow|dashboard|panel|empty state/i, /grid-cols-\[|tab|segment|chart|progress/i],
    "boutique-studio": [/portfolio|case|studio|floating|drift|gallery/i, /blur-3xl|rotate-|absolute|organic/i],
    "local-service-premium": [/booking|randevu|appointment|availability|location|service area|trust/i, /form|contact|phone|map|hours/i],
    "commerce-catalog": [/catalog|product|cart|checkout|sepet|category|price/i, /filter|grid|sku|basket|compare/i],
    "immersive-event": [/ticket|bilet|schedule|speaker|venue|program|timeline/i, /glow|radial-gradient|countdown|date/i],
    "technical-terminal": [/api|sdk|terminal|console|integration|docs|endpoint/i, /font-mono|code|pre|status|cursor/i],
  };
  const archetypePatterns = archetypePatternMap[archetype.key] || [];
  const archetypeHits = archetypePatterns.filter((pattern) =>
    pattern.test(combined)
  ).length;

  if (archetypePatterns.length > 0 && archetypeHits === 0) {
    issues.push(
      `The implementation does not show enough structural evidence of the required visual archetype: ${spec?.visualArchetype || archetype.name}.`
    );
  }

  const domainSpecificSignals = [
    /\b(menu|reservation|booking|randevu|tedavi|implant|clinic|klinik|case|dava|contract|s[öo]zle[sş]me|ticket|bilet|schedule|speaker|catalog|cart|checkout|sepet|api|sdk|terminal|metric|analytics|dashboard|article|post|story|author|editor|newsletter|topic|category)\b/i,
    /\b(service area|practice area|treatment|product catalog|appointment|availability|location|integration|workflow|timeline|pricing table|reading time|editor picks|featured story)\b/i,
  ];

  if (
    /\b(restoran|restaurant|cafe|klinik|clinic|dental|hukuk|law|legal|event|ecommerce|dashboard|api|developer|hotel|otel|fitness|gym|blog|magazin|magazine|haber|news|article|makale)\b/.test(
      normalizedPrompt
    ) &&
    !domainSpecificSignals.some((pattern) => pattern.test(combined))
  ) {
    issues.push(
      "The generated UI lacks domain-specific modules/interactions; add prompt-specific structures such as booking, menu, case timeline, catalog, dashboard states, API panels, or equivalent."
    );
  }

  return issues;
}

function hasOnlySmallSinglePageBuild(assistantContent: string) {
  const writes = getWriteOperations(assistantContent);

  if (writes.length !== 1) return false;

  const onlyWrite = writes[0];
  if (!onlyWrite) return false;
  const normalizedPath = normalizeProjectPath(onlyWrite.path || "");
  const content = onlyWrite.content || "";

  return (
    normalizedPath === "src/app/page.tsx" &&
    (content.length < 12_000 || splitCodeLines(content).length < 240)
  );
}

function hasShallowBroadBuildStructure(assistantContent: string) {
  const writes = getWriteOperations(assistantContent);
  if (!writes.length) return false;

  const hasPageWrite = writes.some(
    (operation) => normalizeProjectPath(operation.path || "") === "src/app/page.tsx"
  );
  const hasSupportingStructure = writes.some((operation) =>
    /^src\/(components|lib|data|config)\//.test(
      normalizeProjectPath(operation.path || "")
    )
  );
  const totalWrittenBytes = writes.reduce(
    (total, operation) => total + (operation.content || "").length,
    0
  );
  const routeWriteCount = getRouteWriteCount(writes);
  const supportingRouteWriteCount = getSupportingRouteWriteCount(writes);

  return (
    !hasPageWrite ||
    routeWriteCount < 3 ||
    supportingRouteWriteCount < 2 ||
    writes.length < 3 ||
    !hasSupportingStructure ||
    !hasComponentStructure(writes) ||
    !hasContentStructure(writes) ||
    !hasMotionSystem(writes) ||
    totalWrittenBytes < 20_000 ||
    hasOnlySmallSinglePageBuild(assistantContent)
  );
}

function shouldRepairBuildDepth(
  userMessage: string,
  assistantContent: string,
  options: BuildOptions = {}
) {
  return (
    isBroadBuildRequest(userMessage, options) &&
    !isExplicitSinglePageRequest(userMessage) &&
    hasShallowBroadBuildStructure(assistantContent)
  );
}

function shouldRepairGeneratedBrandReuse(
  userMessage: string,
  assistantContent: string
) {
  if (/\bklawpen\b/i.test(userMessage)) return false;

  return getWriteOperations(assistantContent).some((operation) =>
    /\bKlawpen\s+(Cloud|Studio|Dashboard|App|AI|Core)\b/i.test(
      operation.content || ""
    )
  );
}

function shouldRepairVisibleLanguageMismatch(
  userMessage: string,
  assistantContent: string
) {
  const writes = getWriteOperations(assistantContent);
  if (!writes.length) return false;

  const visibleCopy = writes
    .map((operation) => operation.content || "")
    .join("\n")
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  if (isLikelyTurkish(userMessage)) {
    const englishUiLabels =
      /(["'`>])\s*(Home|Services|Service|About|About us|Contact|Get Started|Get started|Start Now|Learn More|Learn more|Features|Pricing|FAQ|Book now|Book Now|Request demo|View details|Explore|Sign in|Sign up|Subscribe|Dashboard|Testimonials|Case Studies|Case studies)\s*(["'`<])/i;
    const turkishSignalCount = (
      visibleCopy.match(/[çğıİöşü]|(Ana sayfa|Hizmetler|Hakkımızda|İletişim|Başla|Daha fazla|Özellikler|Fiyatlar|SSS|Randevu|Demo|Giriş|Kayıt)/gi) ||
      []
    ).length;

    return englishUiLabels.test(visibleCopy) || turkishSignalCount < 3;
  }

  const turkishUiLabels =
    /(["'`>])\s*(Ana sayfa|Hizmetler|Hakkımızda|İletişim|Başla|Hemen başla|Daha fazla|Özellikler|Fiyatlar|SSS|Randevu al|Demo iste|Giriş yap|Kayıt ol|Abone ol|Panel|Yorumlar)\s*(["'`<])/i;

  return turkishUiLabels.test(visibleCopy);
}

function normalizePromptText(userMessage: string) {
  return userMessage
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");
}

function hashPromptSeed(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function selectVisualArchetype(userMessage: string): VisualArchetype {
  const normalized = normalizePromptText(userMessage);

  if (/\b(dashboard|panel|admin|crm|analytics|metric|rapor|report|workflow|operasyon|operation)\b/.test(normalized)) {
    return VISUAL_ARCHETYPES.find((item) => item.key === "operational-dashboard")!;
  }

  if (/\b(ecommerce|e commerce|store|shop|marketplace|pazar|urun katalog|catalog|cart|checkout|sepet)\b/.test(normalized)) {
    return VISUAL_ARCHETYPES.find((item) => item.key === "commerce-catalog")!;
  }

  if (/\b(event|festival|konferans|conference|summit|ticket|bilet|schedule|program|speaker)\b/.test(normalized)) {
    return VISUAL_ARCHETYPES.find((item) => item.key === "immersive-event")!;
  }

  if (/\b(blog|magazin|magazine|haber|news|article|makale|yazar|icerik|içerik|publishing|yayin|yayın)\b/.test(normalized)) {
    return VISUAL_ARCHETYPES.find((item) => item.key === "editorial-luxury")!;
  }

  if (/\b(api|developer|docs|sdk|devtool|terminal|database|backend|integration|entegrasyon)\b/.test(normalized)) {
    return VISUAL_ARCHETYPES.find((item) => item.key === "technical-terminal")!;
  }

  if (/\b(restoran|restaurant|cafe|kafe|dis|dental|klinik|clinic|tesisat|plumb|avukat|hukuk|law|legal|kuafor|barber|hotel|otel|emlak|real estate)\b/.test(normalized)) {
    const localOptions = ["local-service-premium", "editorial-luxury", "boutique-studio"];
    const key = localOptions[hashPromptSeed(normalized) % localOptions.length];
    return VISUAL_ARCHETYPES.find((item) => item.key === key)!;
  }

  const index = hashPromptSeed(normalized) % VISUAL_ARCHETYPES.length;
  return VISUAL_ARCHETYPES[index] || VISUAL_ARCHETYPES[0]!;
}

function formatVisualArchetype(archetype: VisualArchetype): string {
  return [
    `Name: ${archetype.name}`,
    `Composition: ${archetype.composition}`,
    `Palette: ${archetype.palette}`,
    `Typography: ${archetype.typography}`,
    `Motion: ${archetype.motion}`,
    `Avoid: ${archetype.forbidden.join("; ")}`,
  ].join("\n");
}

function inferBusinessTitle(userMessage: string) {
  const normalized = userMessage.replace(/\s+/g, " ").replace(/[.!?]+$/g, "").trim();
  const plain = normalizePromptText(userMessage);

  if (/blog|magazin|magazine|haber|news|article|makale|yazar|icerik|içerik/.test(plain)) {
    return isLikelyTurkish(userMessage) ? "Fikir Atlası" : "Field Notes Magazine";
  }
  if (/dis|dent|ortodont|klinik|implant/.test(plain)) return "DentaNova Clinic";
  if (/tesisat|plumb|su kacagi|komb|petek/.test(plain)) return "Vurkany Tesisat";
  if (/avukat|hukuk|law|legal/.test(plain)) return "Lexora Hukuk";
  if (/restoran|restaurant|cafe|kahve|menu/.test(plain)) return "Mira Table";
  if (/fitness|gym|spor|pilates/.test(plain)) return isLikelyTurkish(userMessage) ? "Pulse Hareket" : "Pulse Athletics";
  if (/saas|software|dashboard|crm|app/.test(plain)) return "OrbitOps";

  const stopWords = new Set([
    "bana",
    "bir",
    "icin",
    "ile",
    "modern",
    "site",
    "website",
    "landing",
    "page",
    "yap",
    "olustur",
    "tasarla",
    "gelismis",
    "gelişmiş",
    "profesyonel",
    "premium",
  ]);
  const firstWords = normalizePromptText(normalized)
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .slice(0, 2)
    .map((word) => word.charAt(0).toLocaleUpperCase("tr-TR") + word.slice(1))
    .join(" ");

  if (firstWords) return isLikelyTurkish(userMessage) ? `${firstWords} Kolektif` : `${firstWords} Works`;
  return isLikelyTurkish(userMessage) ? "Yeni Marka" : "Northline";
}

type FallbackProfile = {
  sector: "blog" | "dental" | "plumbing" | "legal" | "restaurant" | "fitness" | "saas" | "studio";
  layout: "split" | "editorial" | "cards" | "magazine";
  palette: {
    bg: string;
    text: string;
    muted: string;
    primary: string;
    primaryText: string;
    panel: string;
    panelText: string;
    accent: string;
    soft: string;
    border: string;
  };
  badge: string;
  headline: string;
  intro: string;
  primary: string;
  secondary: string;
  trust: string[];
  servicesTitle: string;
  services: Array<[string, string]>;
  processTitle: string;
  steps: string[];
  testimonial: string;
  faq: Array<[string, string]>;
  ctaTitle: string;
  ctaText: string;
};

function chooseFallbackProfile(userMessage: string): FallbackProfile {
  const plain = normalizePromptText(userMessage);
  const isTurkish = isLikelyTurkish(userMessage);
  const palettes = {
    dental: { bg: "#f4fbfb", text: "#102023", muted: "#5a7074", primary: "#29b6b1", primaryText: "#062527", panel: "#0e3438", panelText: "#f4ffff", accent: "#ffb86b", soft: "#d9f4f2", border: "#bfe7e4" },
    plumbing: { bg: "#f5f1e8", text: "#17201a", muted: "#667168", primary: "#e08b48", primaryText: "#17201a", panel: "#17201a", panelText: "#fffaf0", accent: "#265849", soft: "#e7ddcc", border: "#ddd1bd" },
    legal: { bg: "#f6f1e9", text: "#17110d", muted: "#766a5f", primary: "#b58b4a", primaryText: "#17110d", panel: "#211a16", panelText: "#fff7ec", accent: "#6d1f1a", soft: "#eadfce", border: "#ded0bc" },
    restaurant: { bg: "#fff5ea", text: "#22120b", muted: "#7c5d4c", primary: "#ef6b3a", primaryText: "#fff8ef", panel: "#34150d", panelText: "#fff8ef", accent: "#1f7a5b", soft: "#f7dfc8", border: "#efcfb4" },
    blog: { bg: "#fbf4ea", text: "#1c1712", muted: "#75675c", primary: "#c94f32", primaryText: "#fffaf2", panel: "#241611", panelText: "#fff9ef", accent: "#2e6f62", soft: "#efe2d0", border: "#decdb8" },
    fitness: { bg: "#f2f4ef", text: "#10140f", muted: "#616b5c", primary: "#b8ff4d", primaryText: "#11160d", panel: "#121812", panelText: "#f8ffe9", accent: "#4d70ff", soft: "#dde8d7", border: "#ccd9c4" },
    saas: { bg: "#f3f7ff", text: "#0e1729", muted: "#61708a", primary: "#4d8bff", primaryText: "#ffffff", panel: "#111c33", panelText: "#f7fbff", accent: "#6ee7d8", soft: "#dce8ff", border: "#c8d7f3" },
    studio: { bg: "#f7f1ff", text: "#1d1428", muted: "#75677f", primary: "#ff7a59", primaryText: "#1d1428", panel: "#241433", panelText: "#fff8ff", accent: "#7cc7ff", soft: "#eadcf8", border: "#dac8ee" },
  } as const;

  const layoutSeed = Array.from(plain).reduce((total, char) => total + char.charCodeAt(0), 0);
  const layouts: FallbackProfile["layout"][] = ["split", "editorial", "cards", "magazine"];
  const layout = layouts[layoutSeed % layouts.length] || "split";

  if (/blog|magazin|magazine|haber|news|article|makale|yazar|icerik|içerik|publishing|yayin|yayın/.test(plain)) {
    return {
      sector: "blog",
      layout: "magazine",
      palette: palettes.blog,
      badge: isTurkish ? "Bağımsız dijital yayın deneyimi" : "Independent digital publishing experience",
      headline: isTurkish
        ? "Okunmaya değer fikirleri derinlikli bir yayın akışına dönüştürün"
        : "Turn thoughtful ideas into a premium editorial experience",
      intro: isTurkish
        ? "Yazar profilleri, öne çıkan dosyalar, kategori akışları ve bülten dönüşümüyle profesyonel bir blog/magazin sitesi."
        : "A professional blog and magazine site with featured stories, author profiles, category flows, and newsletter conversion.",
      primary: isTurkish ? "Bültene katıl" : "Join the newsletter",
      secondary: isTurkish ? "Yazıları keşfet" : "Explore articles",
      trust: isTurkish
        ? ["Haftalık editör seçkisi", "Uzman yazar profilleri", "Okuma süresi ve kategori filtreleri"]
        : ["Weekly editor picks", "Expert author profiles", "Reading time and topic filters"],
      servicesTitle: isTurkish ? "Yayın bölümleri" : "Editorial sections",
      services: isTurkish
        ? [
            ["Öne çıkan dosya", "Haftanın ana fikrini güçlü görsel hiyerarşiyle öne çıkaran kapak alanı."],
            ["Kategori akışları", "Teknoloji, kültür, iş ve yaşam gibi konuları okunabilir koleksiyonlara ayırır."],
            ["Bülten ve topluluk", "Sadık okuyucu kitlesi için e-posta yakalama ve editör notu alanı."],
          ]
        : [
            ["Featured dossier", "A cover-style area that gives the week’s main idea strong hierarchy."],
            ["Topic streams", "Readable collections for technology, culture, work, and life."],
            ["Newsletter community", "Email capture and editor notes for loyal readers."],
          ],
      processTitle: isTurkish ? "Yayın akışı" : "Publishing flow",
      steps: isTurkish
        ? ["Konuları kürate et", "Yazıları öne çıkar", "Okuyucuyu aboneye dönüştür"]
        : ["Curate topics", "Feature strong stories", "Convert readers to subscribers"],
      testimonial: isTurkish
        ? "Bu yayın düzeni okuru sadece gezdirmiyor; doğru yazıya, doğru ritimde götürüyor."
        : "This editorial system does not just display posts; it guides readers into the right story at the right rhythm.",
      faq: isTurkish
        ? [
            ["Yazar sayfaları eklenebilir mi?", "Evet, yazar kartları ve profil sayfaları için ölçeklenebilir yapı hazırdır."],
            ["Kategoriler düzenlenebilir mi?", "Evet, konu başlıkları içerik dosyasından hızlıca değiştirilebilir."],
          ]
        : [
            ["Can author pages be added?", "Yes, the structure is ready for scalable author cards and profile pages."],
            ["Can topics be edited?", "Yes, category names can be changed quickly from the content file."],
          ],
      ctaTitle: isTurkish ? "Okuyucuyu geri getiren bir yayın ritmi kurun" : "Build an editorial rhythm readers return to",
      ctaText: isTurkish
        ? "Öne çıkan yazılar, kategoriler ve bülten akışı tek bir premium yayın deneyiminde birleşir."
        : "Featured articles, topics, and newsletter flow come together in one premium publishing experience.",
    };
  }

  if (/dis|dent|ortodont|klinik|implant/.test(plain)) {
    return {
      sector: "dental", layout, palette: palettes.dental,
      badge: isTurkish ? "Dijital randevu ve güvenli klinik deneyimi" : "Digital booking and trusted clinic experience",
      headline: isTurkish ? "Gülüş tasarımını daha sakin, şeffaf ve premium hale getirin" : "Make dental care feel calm, transparent, and premium",
      intro: isTurkish ? "Modern diş kliniği için randevu odaklı, güven veren ve tedavi süreçlerini anlaşılır gösteren dijital deneyim." : "A polished appointment-focused web experience for a modern dental clinic, shaped to make treatments clear and reassuring.",
      primary: isTurkish ? "Randevu al" : "Book appointment",
      secondary: isTurkish ? "Tedavileri incele" : "Explore treatments",
      trust: isTurkish ? ["Aynı gün ön görüşme", "Şeffaf tedavi planı", "Steril ve premium klinik"] : ["Same-day consult", "Transparent treatment plan", "Sterile premium clinic"],
      servicesTitle: isTurkish ? "Tedavi alanları" : "Treatment areas",
      services: isTurkish ? [["İmplant ve cerrahi", "Eksik dişler için güvenli, planlı ve uzun ömürlü çözümler."], ["Estetik diş hekimliği", "Gülüş tasarımı, beyazlatma ve porselen uygulamalar."], ["Ortodonti", "Şeffaf plak ve tel tedavileriyle ölçülü hizalama."]] : [["Implant care", "Planned long-term solutions for missing teeth."], ["Cosmetic dentistry", "Smile design, whitening, and porcelain treatments."], ["Orthodontics", "Clear aligners and braces for precise alignment."]],
      processTitle: isTurkish ? "Klinik akış" : "Clinic flow",
      steps: isTurkish ? ["Ön değerlendirme", "Kişisel tedavi planı", "Konforlu uygulama"] : ["Initial consult", "Personal treatment plan", "Comfort-led care"],
      testimonial: isTurkish ? "İlk görüşmeden itibaren süreç çok netti; kendimi güvende hissettim." : "The process was clear from the first consultation; I felt genuinely safe.",
      faq: isTurkish ? [["Randevu ne kadar sürer?", "İlk görüşme genellikle 20-30 dakika sürer."], ["Fiyat nasıl belirlenir?", "Muayene sonrası kişisel tedavi planına göre netleşir."]] : [["How long is a consult?", "Most first visits take 20-30 minutes."], ["How is pricing set?", "After examination, pricing follows the personal treatment plan."]],
      ctaTitle: isTurkish ? "Daha sağlıklı bir gülüş için ilk adımı atın" : "Take the first step toward a healthier smile",
      ctaText: isTurkish ? "Ekibimiz ihtiyacınızı dinleyip uygun randevu ve tedavi planını netleştirir." : "Our team will clarify the right appointment and treatment plan for your needs.",
    };
  }

  if (/avukat|hukuk|law|legal/.test(plain)) {
    return {
      sector: "legal", layout, palette: palettes.legal,
      badge: isTurkish ? "Kurumsal hukuki danışmanlık" : "Corporate legal advisory",
      headline: isTurkish ? "Karmaşık hukuki süreçleri sakin ve stratejik şekilde yönetin" : "Navigate complex legal matters with calm strategy",
      intro: isTurkish ? "Şirketler ve bireyler için güven veren, uzmanlık alanlarını net anlatan premium hukuk ofisi deneyimi." : "A premium law office experience that communicates expertise and trust for companies and individuals.",
      primary: isTurkish ? "Ön görüşme talep et" : "Request consultation",
      secondary: isTurkish ? "Uzmanlıkları gör" : "View expertise",
      trust: isTurkish ? ["Gizli ön değerlendirme", "Stratejik dosya analizi", "Kurumsal raporlama"] : ["Confidential review", "Strategic case analysis", "Corporate reporting"],
      servicesTitle: isTurkish ? "Uzmanlık alanları" : "Practice areas",
      services: isTurkish ? [["Ticaret hukuku", "Sözleşme, ortaklık ve uyuşmazlık süreçlerinde stratejik destek."], ["İş hukuku", "İşveren ve çalışan süreçlerinde önleyici danışmanlık."], ["Dava ve tahkim", "Dosya stratejisi, takip ve temsil hizmetleri."]] : [["Commercial law", "Strategic support for contracts and disputes."], ["Employment law", "Preventive advisory for workplace matters."], ["Litigation", "Case strategy, tracking, and representation."]],
      processTitle: isTurkish ? "Çalışma modeli" : "Engagement model",
      steps: isTurkish ? ["Ön analiz", "Strateji notu", "Uygulama ve takip"] : ["Initial analysis", "Strategy memo", "Execution and tracking"],
      testimonial: isTurkish ? "Süreç boyunca riskleri sade ve net şekilde gördük." : "We understood the risks clearly throughout the process.",
      faq: isTurkish ? [["Görüşme gizli mi?", "Evet, tüm ön görüşmeler gizlilik ilkesiyle yürütülür."], ["Online görüşme var mı?", "Uygun dosyalar için online ön görüşme yapılabilir."]] : [["Is consultation confidential?", "Yes, every consultation follows confidentiality standards."], ["Do you offer online meetings?", "Online consultations are available for suitable matters."]],
      ctaTitle: isTurkish ? "Dosyanızı net bir stratejiyle ele alalım" : "Let us approach your matter with a clear strategy",
      ctaText: isTurkish ? "Kısa bir ön bilgi gönderin; uygun yol haritasını birlikte netleştirelim." : "Send a brief summary and we will clarify the right path forward.",
    };
  }

  const isPlumbing = /tesisat|plumb|su kacagi|komb|petek/.test(plain);
  const isRestaurant = /restoran|restaurant|cafe|kahve|menu/.test(plain);
  const isFitness = /fitness|gym|spor|pilates/.test(plain);
  const isSaas = /saas|software|dashboard|crm|app/.test(plain);
  type GenericFallbackSector = "plumbing" | "restaurant" | "fitness" | "saas" | "studio";
  type GenericSectorCopy = Pick<
    FallbackProfile,
    "badge" | "headline" | "intro" | "primary" | "secondary" | "servicesTitle" | "services"
  >;
  const sector: GenericFallbackSector = isPlumbing ? "plumbing" : isRestaurant ? "restaurant" : isFitness ? "fitness" : isSaas ? "saas" : "studio";
  const palette = palettes[sector];
  const sectorCopies: Record<GenericFallbackSector, GenericSectorCopy> = {
    plumbing: {
      badge: isTurkish ? "7/24 güvenilir servis" : "Reliable service, 24/7",
      headline: isTurkish ? "Tesisat sorunlarını hızlı, temiz ve garantili şekilde çözün" : "Solve plumbing issues quickly, cleanly, and reliably",
      intro: isTurkish ? "Acil servis, bakım ve yenileme hizmetlerini güven veren modern bir akışla sunan dijital deneyim." : "A modern web experience for emergency repair, maintenance, and renovation services.",
      primary: isTurkish ? "Hemen teklif al" : "Get a quote",
      secondary: isTurkish ? "Hizmetleri incele" : "Explore services",
      servicesTitle: isTurkish ? "Öne çıkan hizmetler" : "Featured services",
      services: isTurkish ? [["Acil tesisat onarımı", "Su kaçağı, tıkanıklık ve arıza durumlarında hızlı müdahale."], ["Banyo ve mutfak yenileme", "Temiz montaj ve planlı dönüşüm işleri."], ["Kombi ve petek hattı", "Isıtma hattı kontrolü, bakım ve verimlilik iyileştirme."]] : [["Emergency repair", "Fast response for leaks and clogs."], ["Kitchen and bath upgrades", "Clean installation and planned renovation."], ["Heating lines", "Maintenance and efficiency improvements."]],
    },
    restaurant: {
      badge: isTurkish ? "Rezervasyon odaklı lezzet deneyimi" : "Reservation-led dining experience",
      headline: isTurkish ? "Mekanınızın atmosferini daha ilk ekranda hissettirin" : "Make guests feel the atmosphere before they arrive",
      intro: isTurkish ? "Menü, rezervasyon ve sosyal kanıt odaklı sıcak ama premium bir restoran sitesi." : "A warm premium restaurant site focused on menu, booking, and social proof.",
      primary: isTurkish ? "Rezervasyon yap" : "Book a table",
      secondary: isTurkish ? "Menüyü gör" : "View menu",
      servicesTitle: isTurkish ? "Deneyim alanları" : "Experience highlights",
      services: isTurkish ? [["İmza lezzetler", "Mevsimsel ürünlerle hazırlanan seçili tabaklar."], ["Özel etkinlikler", "Kutlamalar ve ekip yemekleri için özel kurgu."], ["Şef menüsü", "Dönemsel tadım akışları ve öneriler."]] : [["Signature dishes", "Selected plates with seasonal ingredients."], ["Private events", "Tailored setup for celebrations and teams."], ["Chef menu", "Seasonal tasting flows and recommendations."]],
    },
    fitness: {
      badge: isTurkish ? "Kişisel hedefe göre antrenman" : "Goal-led training",
      headline: isTurkish ? "Enerjisi yüksek, ölçülebilir ve motive eden bir stüdyo deneyimi" : "A high-energy studio experience that keeps progress visible",
      intro: isTurkish ? "Üyelik, ders programı ve eğitmen güvenini öne çıkaran dinamik fitness deneyimi." : "A dynamic fitness experience shaped around membership, classes, and coach trust.",
      primary: isTurkish ? "Deneme dersi al" : "Book a trial",
      secondary: isTurkish ? "Programları gör" : "View programs",
      servicesTitle: isTurkish ? "Programlar" : "Programs",
      services: isTurkish ? [["Kişisel antrenman", "Hedefe göre takip edilen bire bir program."], ["Grup dersleri", "Enerjik ve ritimli sınıf deneyimi."], ["Performans takibi", "Ölçüm, rapor ve gelişim planı."]] : [["Personal training", "One-to-one programs tracked by goal."], ["Group classes", "Rhythmic high-energy classes."], ["Progress tracking", "Measurement, reporting, and planning."]],
    },
    saas: {
      badge: isTurkish ? "Ekipler için akıllı operasyon" : "Smarter operations for teams",
      headline: isTurkish ? "Dağınık iş akışlarını tek, net ve ölçeklenebilir panele taşıyın" : "Move scattered workflows into one clear scalable platform",
      intro: isTurkish ? "Ürün değerini, entegrasyonları ve dönüşümü net anlatan premium SaaS deneyimi." : "A premium SaaS experience that explains value, integrations, and conversion clearly.",
      primary: isTurkish ? "Demo iste" : "Request demo",
      secondary: isTurkish ? "Özellikleri gör" : "See features",
      servicesTitle: isTurkish ? "Temel özellikler" : "Core features",
      services: isTurkish ? [["Canlı dashboard", "Metrikler ve iş akışları tek ekranda."], ["Otomasyon", "Tekrarlayan işleri güvenli şekilde hızlandırın."], ["Ekip yönetimi", "Rol, yetki ve bildirimleri merkezileştirin."]] : [["Live dashboard", "Metrics and workflows in one place."], ["Automation", "Speed up repeatable work safely."], ["Team control", "Centralize roles, permissions, and alerts."]],
    },
    studio: {
      badge: isTurkish ? "Marka odaklı dijital deneyim" : "Brand-led digital experience",
      headline: isTurkish ? "Fikrinizi güçlü bir ilk izlenime dönüştüren modern web deneyimi" : "Turn your idea into a strong first digital impression",
      intro: isTurkish ? "Hedef kitleye güven veren, mesajı net ve görsel dili tutarlı bir dijital deneyim." : "A digital experience with clear messaging, trust, and cohesive visual language.",
      primary: isTurkish ? "Projeyi başlat" : "Start project",
      secondary: isTurkish ? "Detayları gör" : "See details",
      servicesTitle: isTurkish ? "Neler sunuyoruz" : "What we deliver",
      services: isTurkish ? [["Stratejik anlatı", "Ürünün değerini hızlı anlatan sayfa akışı."], ["Görsel sistem", "Renk, tipografi ve bölüm ritmi."], ["Dönüşüm odaklı CTA", "Kullanıcıyı doğru aksiyona taşıyan yapı."]] : [["Strategic story", "A page flow that explains value quickly."], ["Visual system", "Color, type, and section rhythm."], ["Conversion CTA", "Structure that moves users to action."]],
    },
  };
  const copyBySector = sectorCopies[sector];

  return {
    sector,
    layout,
    palette,
    badge: copyBySector.badge,
    headline: copyBySector.headline,
    intro: copyBySector.intro,
    primary: copyBySector.primary,
    secondary: copyBySector.secondary,
    trust: isTurkish ? ["Net anlatım", "Mobil uyumlu", "Güven veren deneyim"] : ["Clear message", "Mobile ready", "Trust-first experience"],
    servicesTitle: copyBySector.servicesTitle,
    services: copyBySector.services,
    processTitle: isTurkish ? "Yol haritası" : "Journey",
    steps: isTurkish ? ["İhtiyacı seç", "Seçenekleri karşılaştır", "Doğru adımı at"] : ["Choose a need", "Compare options", "Take the right step"],
    testimonial: isTurkish ? "Aradığım bilgiyi hızlı buldum; sonraki adım çok netti." : "I found the right information quickly and knew exactly what to do next.",
    faq: isTurkish ? [["Mobil uyumlu mu?", "Evet, sayfa mobil, tablet ve masaüstü için responsive hazırlanır."], ["Metinler değiştirilebilir mi?", "Evet, marka tonuna göre kolayca düzenlenebilir."]] : [["Is it responsive?", "Yes, the page is built for mobile, tablet, and desktop."], ["Can copy be changed?", "Yes, copy can be adjusted to your brand tone."]],
    ctaTitle: isTurkish ? "Sizin için en doğru adımı birlikte netleştirelim" : "Find the right next step with confidence",
    ctaText: isTurkish ? "Kısa bir bilgi bırakın; ekibimiz ihtiyacınıza göre en uygun yolu önersin." : "Share a few details and the team will recommend the right path for your needs.",
  };
}

function buildFallbackSiteContent(userMessage: string) {
  const businessName = inferBusinessTitle(userMessage);
  const profile = chooseFallbackProfile(userMessage);
  const visualArchetype = selectVisualArchetype(userMessage);
  const isTurkish = isLikelyTurkish(userMessage);

  const stats = isTurkish
    ? profile.sector === "blog"
      ? [
          ["12", "Öne çıkan yazı"],
          ["6", "Editör kategorisi"],
          ["8 dk", "Ortalama okuma"],
        ]
      : [
          ["7+", "Anlamlı bölüm"],
          ["3", "Net dönüşüm adımı"],
          ["24s", "İlk değer algısı"],
        ]
    : profile.sector === "blog"
      ? [
          ["12", "Featured stories"],
          ["6", "Editorial topics"],
          ["8 min", "Average read"],
        ]
      : [
          ["7+", "Meaningful sections"],
          ["3", "Clear conversion steps"],
          ["24s", "First-value clarity"],
        ];

  const nav = isTurkish
    ? profile.sector === "blog"
      ? [
          ["Yazılar", "#solution"],
          ["Kategoriler", "#workflow"],
          ["Editör notu", "#proof"],
          ["SSS", "#faq"],
        ]
      : [
          ["Çözüm", "#solution"],
          ["Akış", "#workflow"],
          ["Kanıt", "#proof"],
          ["SSS", "#faq"],
        ]
    : profile.sector === "blog"
      ? [
          ["Articles", "#solution"],
          ["Topics", "#workflow"],
          ["Editor's note", "#proof"],
          ["FAQ", "#faq"],
        ]
      : [
          ["Solution", "#solution"],
          ["Workflow", "#workflow"],
          ["Proof", "#proof"],
          ["FAQ", "#faq"],
        ];

  const signals = profile.services.map(([title, text], index) => ({
    title,
    text,
    eyebrow: profile.sector === "blog"
      ? isTurkish
        ? `Dosya 0${index + 1}`
        : `Issue 0${index + 1}`
      : isTurkish
        ? `Sinyal 0${index + 1}`
        : `Signal 0${index + 1}`,
  }));

  const workflow = profile.steps.map((step, index) => ({
    step,
    text: isTurkish
      ? profile.sector === "blog"
        ? [
            "Editör gündemi, konu kümeleri ve yayın takvimi net bir ritme bağlanır.",
            "Öne çıkan yazılar, kategori akışları ve okuma kartları hiyerarşik olarak kurgulanır.",
            "Bülten, yazar profili ve konu filtreleriyle okuyucu tekrar ziyarete yönlendirilir.",
          ][index] || "Yayın deneyimi ölçümlenebilir ve büyütülebilir hale getirilir."
        : [
            "Ziyaretçi ihtiyacına en yakın seçeneği hızlıca bulur.",
            "Güven unsurları, detaylar ve karşılaştırmalar doğal bir sırayla sunulur.",
            "Sonraki adım; form, randevu, teklif veya iletişim akışıyla netleşir.",
          ][index] || "Deneyim sade, anlaşılır ve aksiyona yakın kalır."
      : profile.sector === "blog"
        ? [
            "Editorial agenda, topic clusters, and publishing cadence are shaped into a clear rhythm.",
            "Featured stories, category streams, and reading cards are arranged with strong hierarchy.",
            "Newsletter, author profile, and topic filters guide readers back into the publication.",
          ][index] || "The editorial experience becomes measurable and scalable."
        : [
            "Visitors quickly find the option closest to their need.",
            "Trust signals, details, and comparisons appear in a natural order.",
            "The next step becomes clear through form, booking, quote, or contact flow.",
          ][index] || "The experience stays clear, calm, and action-oriented.",
  }));

  const outcomes = isTurkish
    ? profile.sector === "blog"
      ? [
          ["Editoryal hiyerarşi", "Okuyucu hangi yazının kapak konusu, hangisinin hızlı okuma olduğunu ilk bakışta anlar."],
          ["Konu keşfi", "Kategori rail'leri ve kart metadataları okuma akışını daha doğal hale getirir."],
          ["Bülten dönüşümü", "Sadık okuyucu kazanmak için bülten ve editör notu net bir alanda birleşir."],
        ]
      : [
          ["Daha net ilk izlenim", "Ziyaretçi ilk ekranda ne sunduğunuzu, neden güveneceğini ve nereye ilerleyeceğini anlar."],
          ["Sektöre özel anlatım", "Metinler hedef kitleye, karar motivasyonuna ve sık itirazlara göre şekillenir."],
          ["Akıcı kullanım", "Mobil ve masaüstünde okunabilir, sade ve aksiyona yakın bir deneyim sunulur."],
        ]
    : profile.sector === "blog"
      ? [
          ["Editorial hierarchy", "Readers instantly understand the cover story, quick reads, and topic depth."],
          ["Topic discovery", "Category rails and article metadata make browsing feel natural."],
          ["Newsletter conversion", "A clear newsletter and editor note area helps build a returning audience."],
        ]
      : [
          ["Sharper first impression", "Visitors understand the offer, trust reason, and next step from the first screen."],
          ["Sector-specific story", "Copy is shaped around audience, decision motivation, and common objections."],
          ["Fluid usage", "Mobile and desktop visitors get a readable, calm, action-oriented experience."],
        ];

  const caseStudy = isTurkish
    ? profile.sector === "blog"
      ? {
          label: "Editör notu",
          title: "Bir blog değil, geri dönülen bir yayın deneyimi",
          text: "Kapak yazısı, kategori akışları, yazar güveni ve bülten alanı birlikte çalışarak okuru sadece gezdirmek yerine doğru yazıya taşır.",
        }
      : {
          label: "Örnek kullanım senaryosu",
          title: "Kararsız ziyaretçiyi yönlendiren net bir akış",
          text: "Ziyaretçi önce temel değeri görür; ardından güven unsurları, seçenekler ve sık sorular karar vermeyi kolaylaştırır.",
        }
    : profile.sector === "blog"
      ? {
          label: "Editor's note",
          title: "Not just a blog, a publication readers return to",
          text: "Cover story, topic streams, author trust, and newsletter capture work together to guide readers into the right piece.",
        }
      : {
          label: "Example use case",
          title: "A clear flow that guides unsure visitors",
          text: "Visitors see the core value first, then trust signals, options, and FAQ content make the decision easier.",
        };

  const labels = isTurkish
    ? {
        primaryCta: profile.primary,
        secondaryCta: profile.secondary,
        heroMeta: profile.sector === "blog" ? "Haftanın kapak yazısı" : "Öne çıkan değer",
        dashboardTitle: profile.sector === "blog" ? "Editörün seçimi" : "Size uygun seçenekler",
        dashboardSubtitle: profile.sector === "blog" ? "Yeni yazılar, yazar notları ve kategori akışı tek yerde." : "Mesaj, kanıt ve aksiyon noktaları tek akışta.",
        signalTitle: profile.sector === "blog" ? "Okuma ritmini güçlendiren yayın bölümleri" : "Ziyaretçinin karar vermesini kolaylaştıran yapı",
        workflowTitle: profile.processTitle,
        workflowIntro: profile.sector === "blog" ? "Her bölüm okuyucuyu bir sonraki yazıya veya bültene doğal şekilde taşır." : "Her bölüm bir sonraki aksiyonu daha doğal hissettirmek için kurgulanır.",
        outcomesTitle: profile.sector === "blog" ? "Yayın deneyimi neyi iyileştirir?" : "Bu sayfa neyi iyileştirir?",
        proofTitle: profile.sector === "blog" ? "Editoryal güven" : "Güven ve dönüşüm alanı",
        faqTitle: "Sık sorulan sorular",
        finalTitle: profile.ctaTitle,
        finalText: profile.ctaText,
        builtBy: profile.sector === "blog" ? "Yayın ritmi" : "Birlikte netleştirelim",
      }
    : {
        primaryCta: profile.primary,
        secondaryCta: profile.secondary,
        heroMeta: profile.sector === "blog" ? "This week's cover story" : "Featured value",
        dashboardTitle: profile.sector === "blog" ? "Editor's pick" : "Options for your needs",
        dashboardSubtitle: profile.sector === "blog" ? "New stories, author notes, and topic streams in one place." : "Message, proof, and action points in one flow.",
        signalTitle: profile.sector === "blog" ? "Editorial sections that strengthen reading rhythm" : "A structure that makes decisions easier",
        workflowTitle: profile.processTitle,
        workflowIntro: profile.sector === "blog" ? "Every section guides readers toward another story or the newsletter." : "Every section is shaped to make the next action feel natural.",
        outcomesTitle: profile.sector === "blog" ? "What the publication improves" : "What this page improves",
        proofTitle: profile.sector === "blog" ? "Editorial trust" : "Trust and conversion area",
        faqTitle: "Frequently asked questions",
        finalTitle: profile.ctaTitle,
        finalText: profile.ctaText,
        builtBy: profile.sector === "blog" ? "Publication rhythm" : "Let's clarify the next step",
      };

  return {
    businessName,
    profile,
    visualArchetype,
    nav,
    stats,
    signals,
    workflow,
    outcomes,
    caseStudy,
    labels,
  };
}

function buildFallbackContentFile(content: ReturnType<typeof buildFallbackSiteContent>): string {
  return `export const siteContent = ${JSON.stringify(content, null, 2)} as const;\n`;
}

function buildFallbackGeneratedSiteComponent(): string {
  return `import { siteContent } from "../lib/generated-site-content";

const sectionPad = "px-4 sm:px-6 lg:px-10";

function ShellNav() {
  const content = siteContent;
  const profile = content.profile;

  return (
    <nav
      className="relative z-20 mx-auto flex max-w-7xl items-center justify-between gap-4 border-b py-5"
      style={{ borderColor: profile.palette.border }}
    >
      <a href="#top" className="text-xl font-black tracking-[-0.06em]">
        {content.businessName}
      </a>
      <div className="hidden items-center gap-1 md:flex">
        {content.nav.map(([label, href]) => (
          <a
            key={href}
            href={href}
            className="px-3 py-2 text-sm font-bold transition hover:opacity-60"
            style={{ color: profile.palette.muted }}
          >
            {label}
          </a>
        ))}
      </div>
      <a
        href="#contact"
        className="rounded-full px-5 py-2.5 text-sm font-black shadow-lg transition hover:-translate-y-0.5"
        style={{ background: profile.palette.primary, color: profile.palette.primaryText }}
      >
        {content.labels.primaryCta}
      </a>
    </nav>
  );
}

function EditorialLayout() {
  const content = siteContent;
  const profile = content.profile;

  return (
    <main className="min-h-screen overflow-hidden" style={{ background: profile.palette.bg, color: profile.palette.text }}>
      <div className={sectionPad}>
        <ShellNav />
      </div>

      <section id="top" className={sectionPad + " relative py-14 sm:py-20"}>
        <div className="absolute left-[8%] top-12 h-72 w-72 rounded-full opacity-40 blur-3xl" style={{ background: profile.palette.soft }} />
        <div className="relative mx-auto grid max-w-7xl gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
          <div>
            <p className="mb-8 inline-flex border-b pb-2 text-xs font-black uppercase tracking-[0.32em]" style={{ borderColor: profile.palette.primary, color: profile.palette.primary }}>
              {profile.badge}
            </p>
            <h1 className="max-w-5xl text-[clamp(2.8rem,6vw,5.7rem)] font-black leading-[0.78] tracking-[-0.1em]">
              {profile.headline}
            </h1>
          </div>
          <aside className="rounded-none border-l-4 p-7" style={{ borderColor: profile.palette.primary }}>
            <p className="text-xl leading-9" style={{ color: profile.palette.muted }}>{profile.intro}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              {profile.trust.map((item) => (
                <span key={item} className="rounded-full border px-4 py-2 text-xs font-bold" style={{ borderColor: profile.palette.border }}>
                  {item}
                </span>
              ))}
            </div>
          </aside>
        </div>
      </section>

      <section id="solution" className={sectionPad + " py-16"}>
        <div className="mx-auto grid max-w-7xl gap-px overflow-hidden rounded-[2rem] border" style={{ borderColor: profile.palette.border, background: profile.palette.border }}>
          {content.signals.map((item, index) => (
            <article key={item.title} className="grid gap-5 bg-white/70 p-7 md:grid-cols-[0.22fr_0.78fr] md:p-10" style={{ backgroundColor: index % 2 ? profile.palette.bg : profile.palette.soft }}>
              <p className="text-4xl font-black tracking-[-0.09em]" style={{ color: profile.palette.primary }}>0{index + 1}</p>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.28em]" style={{ color: profile.palette.accent }}>{item.eyebrow}</p>
                <h2 className="mt-4 text-4xl font-black tracking-[-0.06em]">{item.title}</h2>
                <p className="mt-4 max-w-3xl text-lg leading-8" style={{ color: profile.palette.muted }}>{item.text}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section id="workflow" className={sectionPad + " py-16"}>
        <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[0.8fr_1.2fr]">
          <div className="sticky top-6 h-fit">
            <p className="text-sm font-black uppercase tracking-[0.3em]" style={{ color: profile.palette.primary }}>{content.labels.workflowTitle}</p>
            <h2 className="mt-5 text-4xl font-black leading-none tracking-[-0.08em]">{content.labels.outcomesTitle}</h2>
          </div>
          <div className="grid gap-5">
            {content.workflow.map((item) => (
              <article key={item.step} className="border-b pb-8" style={{ borderColor: profile.palette.border }}>
                <h3 className="text-3xl font-black tracking-[-0.05em]">{item.step}</h3>
                <p className="mt-3 text-lg leading-8" style={{ color: profile.palette.muted }}>{item.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <ProofAndFaq />
      <FinalCta />
    </main>
  );
}

function DashboardLayout() {
  const content = siteContent;
  const profile = content.profile;

  return (
    <main className="min-h-screen overflow-hidden" style={{ background: profile.palette.panel, color: profile.palette.panelText }}>
      <section id="top" className={sectionPad + " py-5"}>
        <ShellNav />
        <div className="mx-auto mt-10 grid max-w-7xl gap-5 lg:grid-cols-[280px_1fr]">
          <aside className="rounded-[2rem] border bg-white/8 p-5" style={{ borderColor: profile.palette.primary + "55" }}>
            <p className="text-xs font-black uppercase tracking-[0.32em]" style={{ color: profile.palette.primary }}>{profile.badge}</p>
            <div className="mt-7 space-y-3">
              {content.nav.map(([label, href]) => (
                <a key={href} href={href} className="block rounded-2xl bg-white/10 px-4 py-3 text-sm font-bold transition hover:bg-white/15">
                  {label}
                </a>
              ))}
            </div>
          </aside>
          <div className="rounded-[2.4rem] border bg-white/8 p-5 sm:p-8" style={{ borderColor: profile.palette.primary + "55" }}>
            <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
              <div>
                <h1 className="text-[clamp(2.5rem,5vw,5.1rem)] font-black leading-[0.84] tracking-[-0.09em]">{profile.headline}</h1>
                <p className="mt-6 max-w-3xl text-lg leading-8 opacity-75">{profile.intro}</p>
              </div>
              <div className="grid gap-3">
                {content.stats.map(([value, label]) => (
                  <div key={label} className="rounded-[1.5rem] bg-black/20 p-5">
                    <p className="text-4xl font-black" style={{ color: profile.palette.primary }}>{value}</p>
                    <p className="mt-1 text-sm opacity-70">{label}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-7 rounded-[2rem] bg-black/25 p-5">
              <div className="mb-4 flex items-center justify-between">
                <p className="font-black">{content.labels.dashboardTitle}</p>
                <span className="rounded-full px-3 py-1 text-xs font-black" style={{ background: profile.palette.primary, color: profile.palette.primaryText }}>LIVE</span>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                {content.signals.map((item) => (
                  <div key={item.title} className="rounded-2xl border border-white/10 bg-white/7 p-4">
                    <p className="text-xs uppercase tracking-[0.22em] opacity-50">{item.eyebrow}</p>
                    <h3 className="mt-6 text-xl font-black">{item.title}</h3>
                    <p className="mt-2 text-sm leading-6 opacity-65">{item.text}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
      <DashboardSections />
      <FinalCta dark />
    </main>
  );
}

function CommerceLayout() {
  const content = siteContent;
  const profile = content.profile;

  return (
    <main className="min-h-screen" style={{ background: profile.palette.bg, color: profile.palette.text }}>
      <div className={sectionPad}>
        <ShellNav />
      </div>
      <section id="top" className={sectionPad + " py-12"}>
        <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
          <div>
            <p className="rounded-full border px-4 py-2 text-xs font-black uppercase tracking-[0.28em]" style={{ borderColor: profile.palette.border, color: profile.palette.primary }}>{profile.badge}</p>
            <h1 className="mt-7 text-[clamp(2.6rem,5.6vw,5.4rem)] font-black leading-[0.85] tracking-[-0.09em]">{profile.headline}</h1>
            <p className="mt-6 text-lg leading-8" style={{ color: profile.palette.muted }}>{profile.intro}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {content.signals.concat(content.outcomes.map(([title, text]) => ({ title, text, eyebrow: content.labels.proofTitle }))).slice(0, 4).map((item, index) => (
              <article key={item.title} className="group rounded-[2rem] border bg-white p-5 shadow-sm transition hover:-translate-y-1 hover:shadow-2xl" style={{ borderColor: profile.palette.border }}>
                <div className="aspect-[4/3] rounded-[1.5rem]" style={{ background: index % 2 ? profile.palette.soft : profile.palette.panel }} />
                <p className="mt-5 text-xs font-black uppercase tracking-[0.22em]" style={{ color: profile.palette.primary }}>{item.eyebrow}</p>
                <h3 className="mt-3 text-2xl font-black tracking-[-0.04em]">{item.title}</h3>
                <p className="mt-2 leading-7" style={{ color: profile.palette.muted }}>{item.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
      <ProofAndFaq />
      <FinalCta />
    </main>
  );
}

function BlogEditorialLayout() {
  const content = siteContent;
  const profile = content.profile;
  const articles = content.signals.concat(content.outcomes.map(([title, text]) => ({
    title,
    text,
    eyebrow: content.labels.proofTitle,
  })));

  return (
    <main className="min-h-screen overflow-hidden" style={{ background: profile.palette.bg, color: profile.palette.text }}>
      <section id="top" className={sectionPad + " relative py-5"}>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[34rem] opacity-80" style={{ background: "radial-gradient(circle at 18% 12%," + profile.palette.soft + ",transparent 34%), radial-gradient(circle at 78% 0%," + profile.palette.accent + "33,transparent 28%)" }} />
        <div className="relative mx-auto flex max-w-7xl items-center justify-between border-b py-5" style={{ borderColor: profile.palette.border }}>
          <a href="#top" className="text-2xl font-black tracking-[-0.07em]">{content.businessName}</a>
          <div className="hidden items-center gap-7 md:flex">
            {content.nav.map(([label, href]) => (
              <a key={href} href={href} className="text-sm font-black transition hover:opacity-55" style={{ color: profile.palette.muted }}>{label}</a>
            ))}
          </div>
          <a href="#contact" className="rounded-full px-5 py-2.5 text-sm font-black shadow-sm transition hover:-translate-y-0.5" style={{ background: profile.palette.primary, color: profile.palette.primaryText }}>
            {content.labels.primaryCta}
          </a>
        </div>

        <div className="relative mx-auto grid max-w-7xl gap-8 py-12 lg:grid-cols-[1.05fr_0.95fr] lg:py-20">
          <div>
            <p className="inline-flex rounded-full border px-4 py-2 text-xs font-black uppercase tracking-[0.28em]" style={{ borderColor: profile.palette.border, color: profile.palette.primary }}>
              {profile.badge}
            </p>
            <h1 className="mt-8 max-w-5xl text-[clamp(2.7rem,5.8vw,5.8rem)] font-black leading-[0.82] tracking-[-0.09em]">
              {profile.headline}
            </h1>
            <p className="mt-7 max-w-2xl text-xl leading-9" style={{ color: profile.palette.muted }}>{profile.intro}</p>
            <div className="mt-9 flex flex-wrap gap-3">
              {profile.trust.map((item) => (
                <span key={item} className="rounded-full border bg-white/55 px-4 py-2 text-xs font-bold" style={{ borderColor: profile.palette.border }}>
                  {item}
                </span>
              ))}
            </div>
          </div>

          <aside className="grid gap-4">
            <article className="overflow-hidden rounded-[2.4rem] border bg-white shadow-[0_26px_80px_rgba(60,38,20,0.14)]" style={{ borderColor: profile.palette.border }}>
              <div className="aspect-[16/9]" style={{ background: "linear-gradient(135deg," + profile.palette.panel + "," + profile.palette.accent + ")" }} />
              <div className="p-6">
                <p className="text-xs font-black uppercase tracking-[0.26em]" style={{ color: profile.palette.primary }}>{content.labels.heroMeta}</p>
                <h2 className="mt-4 text-3xl font-black leading-tight tracking-[-0.05em]">{articles[0]?.title}</h2>
                <p className="mt-3 leading-7" style={{ color: profile.palette.muted }}>{articles[0]?.text}</p>
                <div className="mt-5 flex items-center justify-between border-t pt-4 text-xs font-bold" style={{ borderColor: profile.palette.border, color: profile.palette.muted }}>
                  <span>{content.labels.dashboardTitle}</span>
                  <span>8 dk okuma</span>
                </div>
              </div>
            </article>
            <div className="grid gap-3 sm:grid-cols-2">
              {articles.slice(1, 3).map((item) => (
                <article key={item.title} className="rounded-[1.5rem] border bg-white/70 p-5" style={{ borderColor: profile.palette.border }}>
                  <p className="text-xs font-black uppercase tracking-[0.22em]" style={{ color: profile.palette.accent }}>{item.eyebrow}</p>
                  <h3 className="mt-5 text-xl font-black tracking-[-0.04em]">{item.title}</h3>
                  <p className="mt-3 text-sm leading-6" style={{ color: profile.palette.muted }}>{item.text}</p>
                </article>
              ))}
            </div>
          </aside>
        </div>
      </section>

      <section id="solution" className={sectionPad + " py-16"}>
        <div className="mx-auto max-w-7xl">
          <div className="mb-8 flex flex-col justify-between gap-4 border-b pb-6 md:flex-row md:items-end" style={{ borderColor: profile.palette.border }}>
            <div>
              <p className="text-sm font-black uppercase tracking-[0.28em]" style={{ color: profile.palette.primary }}>{profile.servicesTitle}</p>
              <h2 className="mt-4 text-4xl font-black tracking-[-0.07em]">{content.labels.signalTitle}</h2>
            </div>
            <p className="max-w-md leading-7" style={{ color: profile.palette.muted }}>{content.labels.workflowIntro}</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {content.signals.map((item, index) => (
              <article key={item.title} className="group rounded-[2rem] border bg-white/70 p-6 transition duration-300 hover:-translate-y-1 hover:bg-white" style={{ borderColor: profile.palette.border }}>
                <div className="mb-10 flex items-center justify-between">
                  <span className="rounded-full px-3 py-1 text-xs font-black" style={{ background: profile.palette.soft, color: profile.palette.primary }}>{item.eyebrow}</span>
                  <span className="text-xs font-bold" style={{ color: profile.palette.muted }}>{6 + index} dk</span>
                </div>
                <h3 className="text-3xl font-black leading-tight tracking-[-0.06em]">{item.title}</h3>
                <p className="mt-4 leading-7" style={{ color: profile.palette.muted }}>{item.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="workflow" className={sectionPad + " py-16"}>
        <div className="mx-auto grid max-w-7xl gap-5 lg:grid-cols-[0.8fr_1.2fr]">
          <aside className="rounded-[2.4rem] p-8 text-white" style={{ background: profile.palette.panel }}>
            <p className="text-xs font-black uppercase tracking-[0.28em]" style={{ color: profile.palette.primary }}>{content.labels.workflowTitle}</p>
            <h2 className="mt-5 text-4xl font-black leading-none tracking-[-0.08em]">{content.labels.outcomesTitle}</h2>
            <p className="mt-5 leading-8 text-white/65">{profile.testimonial}</p>
          </aside>
          <div className="grid gap-4 md:grid-cols-3">
            {content.workflow.map((item, index) => (
              <article key={item.step} className="rounded-[1.8rem] border bg-white/75 p-6" style={{ borderColor: profile.palette.border }}>
                <span className="text-4xl font-black tracking-[-0.08em]" style={{ color: profile.palette.primary }}>0{index + 1}</span>
                <h3 className="mt-6 text-2xl font-black tracking-[-0.05em]">{item.step}</h3>
                <p className="mt-3 leading-7" style={{ color: profile.palette.muted }}>{item.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <ProofAndFaq />
      <FinalCta />
    </main>
  );
}

function ClinicLayout() {
  const content = siteContent;
  const profile = content.profile;

  return (
    <main className="min-h-screen overflow-hidden" style={{ background: profile.palette.panel, color: profile.palette.panelText }}>
      <section id="top" className={sectionPad + " relative py-5"}>
        <div className="pointer-events-none absolute inset-0 opacity-70" style={{ background: "radial-gradient(circle at 18% 20%," + profile.palette.primary + "55,transparent 28%), radial-gradient(circle at 82% 12%," + profile.palette.accent + "33,transparent 24%), linear-gradient(160deg," + profile.palette.panel + " 0%," + profile.palette.text + " 120%)" }} />
        <div className="relative mx-auto flex max-w-7xl items-center justify-between border-b border-white/10 py-5">
          <a href="#top" className="text-xl font-black tracking-[-0.06em]">{content.businessName}</a>
          <div className="hidden items-center gap-6 md:flex">
            {content.nav.map(([label, href]) => (
              <a key={href} href={href} className="text-sm font-bold text-white/58 transition hover:text-white">{label}</a>
            ))}
          </div>
          <a href="#contact" className="rounded-full px-5 py-2.5 text-sm font-black" style={{ background: profile.palette.primary, color: profile.palette.primaryText }}>{content.labels.primaryCta}</a>
        </div>
        <div className="relative mx-auto grid max-w-7xl gap-6 py-14 lg:grid-cols-[360px_1fr] lg:py-20">
          <aside className="order-2 rounded-[2.2rem] border border-white/10 bg-white/[0.08] p-5 backdrop-blur lg:order-1">
            <p className="text-xs font-black uppercase tracking-[0.3em]" style={{ color: profile.palette.primary }}>{content.labels.heroMeta}</p>
            <h2 className="mt-5 text-3xl font-black tracking-[-0.05em]">{content.labels.dashboardTitle}</h2>
            <div className="mt-7 space-y-3">
              {profile.trust.map((item, index) => (
                <div key={item} className="flex items-center justify-between rounded-2xl bg-black/20 px-4 py-3">
                  <span className="text-sm font-bold text-white/78">{item}</span>
                  <span className="text-xs font-black" style={{ color: profile.palette.primary }}>0{index + 1}</span>
                </div>
              ))}
            </div>
            <div className="mt-6 rounded-[1.5rem] p-4" style={{ background: profile.palette.primary, color: profile.palette.primaryText }}>
              <p className="text-sm font-black">{content.labels.primaryCta}</p>
              <p className="mt-2 text-sm opacity-75">{content.labels.dashboardSubtitle}</p>
            </div>
          </aside>
          <div className="order-1 lg:order-2">
            <p className="inline-flex rounded-full border border-white/12 px-4 py-2 text-xs font-black uppercase tracking-[0.26em]" style={{ color: profile.palette.accent }}>{profile.badge}</p>
            <h1 className="mt-8 max-w-5xl text-[clamp(2.7rem,6vw,5.9rem)] font-black leading-[0.8] tracking-[-0.1em]">{profile.headline}</h1>
            <p className="mt-8 max-w-3xl text-xl leading-9 text-white/68">{profile.intro}</p>
            <div className="mt-10 grid gap-3 sm:grid-cols-3">
              {content.stats.map(([value, label]) => (
                <div key={label} className="border-t border-white/14 pt-4">
                  <p className="text-4xl font-black" style={{ color: profile.palette.primary }}>{value}</p>
                  <p className="mt-2 text-sm text-white/58">{label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
      <section id="solution" className={sectionPad + " py-16"} style={{ background: profile.palette.bg, color: profile.palette.text }}>
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
            <div>
              <p className="text-sm font-black uppercase tracking-[0.3em]" style={{ color: profile.palette.primary }}>{profile.servicesTitle}</p>
              <h2 className="mt-5 text-4xl font-black leading-none tracking-[-0.08em]">{content.labels.signalTitle}</h2>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {content.signals.map((item) => (
                <article key={item.title} className="rounded-[2rem] border bg-white p-6 shadow-sm transition hover:-translate-y-1" style={{ borderColor: profile.palette.border }}>
                  <p className="text-xs font-black uppercase tracking-[0.22em]" style={{ color: profile.palette.accent }}>{item.eyebrow}</p>
                  <h3 className="mt-8 text-2xl font-black tracking-[-0.04em]">{item.title}</h3>
                  <p className="mt-4 leading-7" style={{ color: profile.palette.muted }}>{item.text}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>
      <section id="workflow" className={sectionPad + " py-16"} style={{ background: profile.palette.bg, color: profile.palette.text }}>
        <div className="mx-auto max-w-7xl rounded-[2.5rem] border p-6 md:p-10" style={{ borderColor: profile.palette.border, background: profile.palette.soft }}>
          <h2 className="text-4xl font-black tracking-[-0.08em]">{content.labels.workflowTitle}</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {content.workflow.map((item, index) => (
              <article key={item.step} className="rounded-[1.7rem] bg-white/80 p-5">
                <span className="text-4xl font-black tracking-[-0.1em]" style={{ color: profile.palette.primary }}>0{index + 1}</span>
                <h3 className="mt-5 text-2xl font-black">{item.step}</h3>
                <p className="mt-3 leading-7" style={{ color: profile.palette.muted }}>{item.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
      <ProofAndFaq />
      <FinalCta />
    </main>
  );
}

function ServiceLayout() {
  const content = siteContent;
  const profile = content.profile;

  return (
    <main className="min-h-screen overflow-hidden" style={{ background: profile.palette.bg, color: profile.palette.text }}>
      <section id="top" className={sectionPad + " relative py-5"}>
        <div className="absolute inset-0 opacity-80" style={{ background: "linear-gradient(135deg," + profile.palette.soft + ",transparent 55%), radial-gradient(circle at 88% 12%," + profile.palette.accent + "44,transparent 26%)" }} />
        <div className="relative"><ShellNav /></div>
        <div className="relative mx-auto mt-12 grid max-w-7xl gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <p className="mb-6 inline-flex rounded-full border bg-white/60 px-4 py-2 text-xs font-black uppercase tracking-[0.24em]" style={{ borderColor: profile.palette.border, color: profile.palette.accent }}>{profile.badge}</p>
            <h1 className="max-w-4xl text-[clamp(2.6rem,5.5vw,5.4rem)] font-black leading-[0.84] tracking-[-0.09em]">{profile.headline}</h1>
            <p className="mt-7 max-w-2xl text-lg leading-8" style={{ color: profile.palette.muted }}>{profile.intro}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#contact" className="rounded-full px-5 py-3 text-sm font-black" style={{ background: profile.palette.primary, color: profile.palette.primaryText }}>{content.labels.primaryCta}</a>
              <a href="#solution" className="rounded-full border bg-white/70 px-5 py-3 text-sm font-black" style={{ borderColor: profile.palette.border }}>{content.labels.secondaryCta}</a>
            </div>
          </div>
          <div className="rounded-[2.4rem] border bg-white/70 p-5 shadow-2xl" style={{ borderColor: profile.palette.border }}>
            <div className="rounded-[1.8rem] p-5" style={{ background: profile.palette.panel, color: profile.palette.panelText }}>
              <p className="text-xs font-black uppercase tracking-[0.28em]" style={{ color: profile.palette.primary }}>{content.labels.heroMeta}</p>
              <h2 className="mt-4 text-3xl font-black tracking-[-0.05em]">{content.labels.dashboardTitle}</h2>
              <div className="mt-6 space-y-3">
                {profile.trust.map((item) => <div key={item} className="rounded-2xl bg-white/10 px-4 py-3 text-sm font-bold">{item}</div>)}
              </div>
            </div>
          </div>
        </div>
      </section>
      <ServiceSections />
      <ProofAndFaq />
      <FinalCta />
    </main>
  );
}

function ServiceSections() {
  const content = siteContent;
  const profile = content.profile;
  return (
    <section id="solution" className={sectionPad + " py-20"}>
      <div className="mx-auto max-w-7xl">
        <div className="mb-10 flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <h2 className="max-w-3xl text-4xl font-black tracking-[-0.07em]">{content.labels.signalTitle}</h2>
          <p className="max-w-md leading-7" style={{ color: profile.palette.muted }}>{content.labels.workflowIntro}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {content.signals.map((item) => (
            <article key={item.title} className="rounded-[2rem] border bg-white/70 p-6 transition hover:-translate-y-1" style={{ borderColor: profile.palette.border }}>
              <p className="text-xs font-black uppercase tracking-[0.22em]" style={{ color: profile.palette.primary }}>{item.eyebrow}</p>
              <h3 className="mt-8 text-2xl font-black tracking-[-0.04em]">{item.title}</h3>
              <p className="mt-4 leading-7" style={{ color: profile.palette.muted }}>{item.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function DashboardSections() {
  const content = siteContent;
  const profile = content.profile;
  return (
    <section id="workflow" className={sectionPad + " py-16"}>
      <div className="mx-auto grid max-w-7xl gap-5 lg:grid-cols-3">
        {content.workflow.map((item, index) => (
          <article key={item.step} className="rounded-[2rem] border border-white/10 bg-white/7 p-6">
            <span className="text-4xl font-black" style={{ color: profile.palette.primary }}>0{index + 1}</span>
            <h3 className="mt-6 text-2xl font-black">{item.step}</h3>
            <p className="mt-3 leading-7 opacity-70">{item.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProofAndFaq() {
  const content = siteContent;
  const profile = content.profile;
  return (
    <>
      <section id="proof" className={sectionPad + " py-16"}>
        <div className="mx-auto grid max-w-7xl gap-5 lg:grid-cols-[1.15fr_0.85fr]">
          <article className="rounded-[2.4rem] border p-8 sm:p-12" style={{ borderColor: profile.palette.border, background: profile.palette.soft }}>
            <p className="text-xs font-black uppercase tracking-[0.28em]" style={{ color: profile.palette.primary }}>{content.caseStudy.label}</p>
            <h2 className="mt-5 text-3xl font-black tracking-[-0.05em] sm:text-5xl">{content.caseStudy.title}</h2>
            <p className="mt-5 max-w-2xl text-lg leading-8" style={{ color: profile.palette.muted }}>{content.caseStudy.text}</p>
          </article>
          <article className="rounded-[2.4rem] p-8 text-white" style={{ background: profile.palette.panel }}>
            <p className="text-sm font-black uppercase tracking-[0.28em]" style={{ color: profile.palette.primary }}>{content.labels.proofTitle}</p>
            <p className="mt-8 text-3xl font-black leading-tight tracking-[-0.05em]">“{profile.testimonial}”</p>
          </article>
        </div>
      </section>
      <section id="faq" className={sectionPad + " py-16"}>
        <div className="mx-auto max-w-7xl">
          <h2 className="text-4xl font-black tracking-[-0.07em]">{content.labels.faqTitle}</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            {profile.faq.map(([question, answer]) => (
              <article key={question} className="rounded-[1.6rem] border p-6" style={{ borderColor: profile.palette.border }}>
                <h3 className="text-xl font-black">{question}</h3>
                <p className="mt-3 leading-7" style={{ color: profile.palette.muted }}>{answer}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function FinalCta({ dark = false }: { dark?: boolean }) {
  const content = siteContent;
  const profile = content.profile;
  return (
    <section id="contact" className={sectionPad + " pb-24 pt-10"}>
      <div className="mx-auto max-w-6xl rounded-[2.6rem] p-8 text-center sm:p-14" style={{ background: profile.palette.panel, color: profile.palette.panelText }}>
        <p className="text-xs font-black uppercase tracking-[0.3em]" style={{ color: profile.palette.primary }}>{content.labels.builtBy}</p>
        <h2 className="mx-auto mt-5 max-w-4xl text-3xl font-black tracking-[-0.05em] sm:text-5xl">{content.labels.finalTitle}</h2>
        <p className="mx-auto mt-5 max-w-2xl leading-8 opacity-75">{content.labels.finalText}</p>
        <a href="mailto:hello@example.com" className="mt-9 inline-flex rounded-full px-6 py-3 text-sm font-black" style={{ background: profile.palette.primary, color: profile.palette.primaryText }}>
          {content.labels.primaryCta}
        </a>
      </div>
    </section>
  );
}

export function GeneratedLandingPage() {
  const key = siteContent.visualArchetype.key;

  if (siteContent.profile.sector === "blog") return <BlogEditorialLayout />;
  if (siteContent.profile.sector === "dental") return <ClinicLayout />;
  if (key === "operational-dashboard" || key === "technical-terminal") return <DashboardLayout />;
  if (key === "commerce-catalog" || key === "immersive-event") return <CommerceLayout />;
  if (key === "editorial-luxury" || key === "boutique-studio" || key === "neo-brutal-product") return <EditorialLayout />;
  return <ServiceLayout />;
}
`;
}
function buildFallbackLandingPage(_userMessage: string): string {
  return `import type { Metadata } from "next";
import { GeneratedLandingPage } from "../components/generated-site";
import { siteContent } from "../lib/generated-site-content";

export const metadata: Metadata = {
  title: siteContent.businessName,
  description: siteContent.profile.intro,
};

export default function Home() {
  return <GeneratedLandingPage />;
}
`;
}

function buildFallbackServicesPage(_userMessage: string): string {
  return `import type { Metadata } from "next";
import { GeneratedLandingPage } from "../../components/generated-site";
import { siteContent } from "../../lib/generated-site-content";

export const metadata: Metadata = {
  title: siteContent.profile.servicesTitle + " | " + siteContent.businessName,
  description: siteContent.profile.intro,
};

export default function ServicesPage() {
  return <GeneratedLandingPage />;
}
`;
}

function buildFallbackContactPage(_userMessage: string): string {
  return `import type { Metadata } from "next";
import { GeneratedLandingPage } from "../../components/generated-site";
import { siteContent } from "../../lib/generated-site-content";

export const metadata: Metadata = {
  title: siteContent.labels.finalTitle + " | " + siteContent.businessName,
  description: siteContent.labels.finalText,
};

export default function ContactPage() {
  return <GeneratedLandingPage />;
}
`;
}

function buildFallbackOperations(userMessage: string): CodeOperation[] {
  const content = buildFallbackSiteContent(userMessage);
  const supportRoutePath =
    content.profile.sector === "blog" ? "src/app/articles/page.tsx" : "src/app/services/page.tsx";
  const conversionRoutePath =
    content.profile.sector === "blog" ? "src/app/newsletter/page.tsx" : "src/app/contact/page.tsx";

  return [
    {
      type: "write",
      index: Number.MAX_SAFE_INTEGER - 4,
      path: "src/lib/generated-site-content.ts",
      content: buildFallbackContentFile(content),
    },
    {
      type: "write",
      index: Number.MAX_SAFE_INTEGER - 3,
      path: "src/components/generated-site.tsx",
      content: buildFallbackGeneratedSiteComponent(),
    },
    {
      type: "write",
      index: Number.MAX_SAFE_INTEGER - 2,
      path: "src/app/page.tsx",
      content: buildFallbackLandingPage(userMessage),
    },
    {
      type: "write",
      index: Number.MAX_SAFE_INTEGER - 1,
      path: supportRoutePath,
      content: buildFallbackServicesPage(userMessage),
    },
    {
      type: "write",
      index: Number.MAX_SAFE_INTEGER,
      path: conversionRoutePath,
      content: buildFallbackContactPage(userMessage),
    },
  ];
}

function buildFallbackAssistantContent(userMessage: string, reason: string): string {
  const writes = buildFallbackOperations(userMessage).map(
    (operation) =>
      `<dec-write path="${operation.path}">${operation.content || ""}</dec-write>`
  );

  return [
    "<dec-code>",
    "Plan:",
    "- " + reason,
    "- Build a structured multi-page version with content, shared UI, and page files.",
    ...writes,
    "</dec-code>",
    isLikelyTurkish(userMessage)
      ? "Çok sayfalı yapı hazırlandı; istersen marka tonunu ve bölüm detaylarını daha da keskinleştirebilirsin."
      : "A multi-page structure is ready; you can refine the brand tone and section details further.",
  ].join("\n");
}

function getOperationFilePaths(assistantContent: string): string[] {
  const paths = new Set<string>();

  for (const operation of [
    ...extractCodeOperations(assistantContent),
    ...extractMarkdownCodeOperations(assistantContent),
  ]) {
    if (operation.path) paths.add(normalizeProjectPath(operation.path));
    if (operation.to) paths.add(normalizeProjectPath(operation.to));
    if (operation.from) paths.add(normalizeProjectPath(operation.from));
  }

  return Array.from(paths).slice(0, 8);
}

async function applyCodeOperations(
  containerId: string,
  assistantContent: string,
  userMessage: string,
  progress?: ProgressReporter,
  options: BuildOptions = {}
): Promise<{ applied: number; failed: Array<{ label: string; error: string }> }> {
  let operations = extractCodeOperations(assistantContent);

  if (!operations.length) {
    operations = extractMarkdownCodeOperations(assistantContent);
  }

  if (
    !operations.length &&
    shouldForceFallbackPage(userMessage, assistantContent, options)
  ) {
    operations = buildFallbackOperations(userMessage);
    console.warn(
      "AI response did not include executable edit tags; applying fallback landing page."
    );
  }

  const result: {
    applied: number;
    failed: Array<{ label: string; error: string }>;
  } = { applied: 0, failed: [] };

  if (!operations.length) return result;

  console.log(
    `Applying ${operations.length} AI code operation(s) to ${containerId}`
  );

  for (const operation of operations) {
    const operationLabel =
      operation.path ||
      operation.to ||
      operation.from ||
      operation.packageName ||
      operation.type;
    const reportAppliedProgress = async () => {
      await progress?.(
        getBuildProgressCopy(
          userMessage,
          "apply",
          Math.min(94, 84 + Math.round((result.applied / operations.length) * 10)),
          [
            operation.path,
            operation.to,
            operation.from,
            operation.packageName,
          ].filter(Boolean) as string[]
        )
      );
    };

    try {
      if (operation.type === "write" && operation.path !== undefined) {
        await fileService.writeFile(
          containerId,
          operation.path,
          operation.content || ""
        );
        result.applied += 1;
        await reportAppliedProgress();
        continue;
      }

      if (
        operation.type === "rename" &&
        operation.from !== undefined &&
        operation.to !== undefined
      ) {
        await fileService.renameFile(containerId, operation.from, operation.to);
        result.applied += 1;
        await reportAppliedProgress();
        continue;
      }

      if (operation.type === "delete" && operation.path !== undefined) {
        await fileService.removeFile(containerId, operation.path);
        result.applied += 1;
        await reportAppliedProgress();
        continue;
      }

      if (operation.type === "dependency" && operation.packageName) {
        const packageSpec = operation.version
          ? `${operation.packageName}@${operation.version}`
          : operation.packageName;

        await packageService.addDependency(containerId, packageSpec, false);
        result.applied += 1;
        await reportAppliedProgress();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(
        `AI code operation failed (${operation.type}: ${operationLabel}):`,
        message
      );
      result.failed.push({
        label: `${operation.type}: ${operationLabel}`,
        error: message,
      });
    }
  }

  console.log(
    `AI code operations finished for ${containerId}: ${result.applied} applied, ${result.failed.length} failed`
  );

  return result;
}

async function createPlannerBrief(
  userMessage: string,
  recentConversation: string,
  provider: AiProviderConfig,
  options: BuildOptions = {}
): Promise<string> {
  const visualArchetype = selectVisualArchetype(userMessage);
  const plannerInput = `
SYSTEM:
${PLANNER_SYSTEM_PROMPT}

PLAN_MODE:
${options.planMode ? "Enabled. Produce a stronger product plan and identify only the questions that materially affect the result." : "Disabled. Infer sensible defaults unless the request is materially underspecified."}

VISUAL ARCHETYPE TO ENFORCE:
${formatVisualArchetype(visualArchetype)}

RECENT CONVERSATION:
${recentConversation || "No prior conversation."}

USER REQUEST:
${userMessage}
`;

  return createAiText({
    provider,
    input: plannerInput,
    temperature: Math.min(aiTemperature, 0.2),
  });
}

function createLocalPlannerBrief(
  userMessage: string,
  options: BuildOptions = {}
): string {
  const turkish = isLikelyTurkish(userMessage);
  const inferredTitle = inferBusinessTitle(userMessage);
  const inferredProfile = chooseFallbackProfile(userMessage);
  const visualArchetype = selectVisualArchetype(userMessage);
  const visualDirectionLine = turkish
    ? `Visual Archetype: ${visualArchetype.name}. Kompozisyon=${visualArchetype.composition}. Palet=${visualArchetype.palette}. Tipografi=${visualArchetype.typography}. Kaçın=${visualArchetype.forbidden.join("; ")}.`
    : `Visual Archetype: ${visualArchetype.name}. Composition=${visualArchetype.composition}. Palette=${visualArchetype.palette}. Typography=${visualArchetype.typography}. Avoid=${visualArchetype.forbidden.join("; ")}.`;
  const planningLine = options.planMode
    ? turkish
      ? "Planning Mode: Önce bilgi mimarisi, sayfa yapısı, tasarım yönü ve kritik belirsizlikleri netleştir; eksik ama kritik bilgi varsa en fazla 3 soru sor."
      : "Planning Mode: First clarify information architecture, page structure, visual direction, and critical unknowns; ask up to 3 questions only when they materially affect the result."
    : turkish
      ? "Planning Mode: Kapalı; eksik kalan küçük detaylarda profesyonel varsayımlar yap ve üret."
      : "Planning Mode: Off; make professional assumptions for minor gaps and build.";

  if (turkish) {
    return [
      `Goal: ${inferredTitle} için üretime hazır, modern, mobil uyumlu ve çok sayfalı bir web projesi oluştur.`,
      `Inferred Context: Sektör=${inferredProfile.sector}, tasarım yönü=${inferredProfile.layout}, ana CTA=${inferredProfile.primary}.`,
      visualDirectionLine,
      planningLine,
      "Audience: Hizmet veya ürün arayan son kullanıcılar.",
      "UI/UX Direction: Prompt'a özel, güven veren, net hiyerarşili, premium, modern ve animasyonlu bir ürün/site deneyimi.",
      "Information Architecture: Ana sayfa + 2-4 destek sayfası oluştur; örnek route'lar: hizmetler/özellikler, fiyatlar/menü/tedaviler, hakkımızda, SSS, iletişim veya sektöre uygun eşdeğerleri.",
      "Required Pages/Sections: Her route kendi amacına sahip olsun; hero, kanıt, hizmet mimarisi, süreç, sosyal kanıt, SSS, iletişim/dönüşüm CTA ve sektöre özel ek bölümler projeye yayılsın.",
      "Technical Plan: Next.js App Router içinde src/app/page.tsx yanında gerçek route dosyaları, shared component dosyası, content/config dosyası ve modern transition/hover animasyonları oluştur.",
      "Acceptance Checklist: En az 3 gerçek page route, shared component/content yapısı, responsive tasarım, anlamlı sektörel metinler, erişilebilir HTML, bozuk import yok, tek sayfa/template hissi yok.",
    ].join("\n");
  }

  return [
    `Goal: Build a production-ready, modern, mobile-responsive multi-page web project for ${inferredTitle}.`,
    `Inferred Context: Sector=${inferredProfile.sector}, design direction=${inferredProfile.layout}, primary CTA=${inferredProfile.primary}.`,
    visualDirectionLine,
    planningLine,
    "Audience: End users evaluating the service or product.",
    "UI/UX Direction: Prompt-specific, trustworthy, premium, modern, animated product/site experience with clear hierarchy.",
    "Information Architecture: Build a homepage plus 2-4 supporting pages; sensible routes include services/features, pricing/menu/treatments, about, FAQ, contact, dashboard, blog, or domain-specific equivalents.",
    "Required Pages/Sections: Each route should have a clear job; distribute hero, proof, service architecture, process, social proof, FAQ, contact/conversion CTA, and sector-specific sections across the project.",
    "Technical Plan: Use Next.js App Router with src/app/page.tsx plus real route files, shared component files, content/config data, and modern transition/hover animation patterns.",
    "Acceptance Checklist: At least 3 real page routes, shared component/content structure, responsive layout, meaningful sector-specific copy, accessible HTML, no broken imports, no one-page/template feel.",
  ].join("\n");
}

function shouldCreateArchitectSpec(
  userMessage: string,
  options: BuildOptions = {}
) {
  return (
    ARCHITECT_SPEC_ENABLED &&
    shouldUsePowerBuildLayer(options) &&
    isBroadBuildRequest(userMessage, options) &&
    !isExplicitSinglePageRequest(userMessage)
  );
}

function normalizeArchitectRoutePath(routePath: string): string {
  const normalized = `/${String(routePath || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")}`;

  if (normalized === "/") return "/";
  if (!/^\/[a-z0-9][a-z0-9-/]*$/i.test(normalized)) return "/";
  return normalized.replace(/\/+/g, "/").toLowerCase();
}

function routePathToPageFile(routePath: string): string {
  const normalized = normalizeArchitectRoutePath(routePath);
  return normalized === "/"
    ? "src/app/page.tsx"
    : `src/app${normalized}/page.tsx`;
}

function dedupeArchitectRoutes(routes: ArchitectSpecRoute[]) {
  const seen = new Set<string>();
  const cleaned: ArchitectSpecRoute[] = [];

  for (const route of routes) {
    const pathName = normalizeArchitectRoutePath(route.path);
    if (seen.has(pathName)) continue;
    seen.add(pathName);
    cleaned.push({
      path: pathName,
      purpose: String(route.purpose || "Support the conversion flow").slice(0, 180),
      visibleTitle: String(route.visibleTitle || pathName || "Home").slice(0, 80),
    });
  }

  return cleaned;
}

function createLocalArchitectSpec(userMessage: string): ArchitectSpec {
  const turkish = isLikelyTurkish(userMessage);
  const plain = normalizePromptText(userMessage);
  const profile = chooseFallbackProfile(userMessage);
  const visualArchetype = selectVisualArchetype(userMessage);
  const isRestaurant = /restoran|restaurant|cafe|kahve|menu/.test(plain);
  const isDental = /dis|dent|ortodont|klinik|implant/.test(plain);
  const isSaas = /saas|software|dashboard|crm|app|platform|urun|product/.test(plain);
  const isLegal = /avukat|hukuk|law|legal/.test(plain);
  const isBlog = /blog|magazin|magazine|haber|news|article|makale|yazar|icerik|içerik|publishing|yayin|yayın/.test(plain);

  const routeLabels = turkish
    ? {
        home: "Ana sayfa",
        services: isRestaurant
          ? "Menü"
          : isDental
            ? "Tedaviler"
            : isLegal
              ? "Uzmanlıklar"
              : isBlog
                ? "Yazılar"
                : isSaas
                  ? "Özellikler"
                  : "Hizmetler",
        proof: isBlog ? "Kategoriler" : isSaas ? "Fiyatlar" : "Süreç",
        contact: isBlog ? "Bülten" : "İletişim",
      }
    : {
        home: "Home",
        services: isRestaurant
          ? "Menu"
          : isDental
            ? "Treatments"
            : isLegal
              ? "Practice Areas"
              : isBlog
                ? "Articles"
                : isSaas
                  ? "Features"
                  : "Services",
        proof: isBlog ? "Topics" : isSaas ? "Pricing" : "Process",
        contact: isBlog ? "Newsletter" : "Contact",
      };

  const servicePath = isRestaurant
    ? "/menu"
    : isDental
      ? "/treatments"
      : isLegal
        ? "/practice-areas"
        : isBlog
          ? "/articles"
          : isSaas
            ? "/features"
            : "/services";
  const proofPath = isBlog ? "/topics" : isSaas ? "/pricing" : "/process";
  const contactPath = isBlog ? "/newsletter" : "/contact";

  return {
    projectType: `${profile.sector} ${isSaas ? "product" : "website"} prototype`,
    language: turkish ? "tr" : "en",
    visualArchetype: visualArchetype.name,
    routes: [
      {
        path: "/",
        purpose: turkish
          ? isBlog
            ? "Yayının editoryal vaadini, kapak yazısını ve okuma yollarını güçlü biçimde sunar."
            : "Marka vaadini, güven unsurlarını ve ana dönüşüm aksiyonunu anlatır."
          : isBlog
            ? "Present the publication promise, cover story, and reading paths with strong hierarchy."
            : "Explain the brand promise, trust proof, and primary conversion action.",
        visibleTitle: routeLabels.home,
      },
      {
        path: servicePath,
        purpose: turkish
          ? isBlog
            ? "Yazı listesi, öne çıkan makaleler, okuma süresi ve yazar metadatalarını gösterir."
            : "Ana hizmet/ürün mimarisini sektöre özel ve karar vermeyi kolaylaştıracak şekilde detaylandırır."
          : isBlog
            ? "Show article list, featured posts, reading time, and author metadata."
            : "Detail the service/product architecture in a domain-specific decision-friendly way.",
        visibleTitle: routeLabels.services,
      },
      {
        path: proofPath,
        purpose: turkish
          ? isBlog
            ? "Kategori, konu filtreleri, editör seçkileri ve keşif akışını sunar."
            : "Karar sürecini güçlendiren paket, süreç, kanıt veya karşılaştırma bilgilerini sunar."
          : isBlog
            ? "Show categories, topic filters, editor picks, and discovery flow."
            : "Show package, process, proof, or comparison content that strengthens decision-making.",
        visibleTitle: routeLabels.proof,
      },
      {
        path: contactPath,
        purpose: turkish
          ? isBlog
            ? "Bülten kayıt alanı, editör notu ve okuyucu topluluğu CTA'sı sunar."
            : "Form, iletişim bilgisi ve son CTA ile dönüşümü tamamlar."
          : isBlog
            ? "Offer newsletter signup, editor note, and reader community CTA."
            : "Complete the conversion flow with a form, contact details, and final CTA.",
        visibleTitle: routeLabels.contact,
      },
    ],
    designDirection: turkish
      ? `Sektöre özel ${profile.layout} kompozisyon. Zorunlu görsel yön: ${formatVisualArchetype(visualArchetype)}`
      : `Domain-specific ${profile.layout} composition. Mandatory visual direction: ${formatVisualArchetype(visualArchetype)}`,
    animationPlan: turkish
      ? [
          "Sayfa yüklenirken yumuşak reveal geçişleri",
          "Kartlarda hover/press geri bildirimi",
          "Route ve bölüm geçişlerinde hissedilir ama hafif motion",
        ]
      : [
          "Soft page-load reveal transitions",
          "Hover/press feedback on cards",
          "Noticeable but lightweight route and section motion",
        ],
    components: [
      "src/components/site-shell.tsx",
      "src/components/site-sections.tsx",
      "src/components/animated-card.tsx",
    ],
    contentFiles: ["src/lib/site-content.ts"],
    acceptanceCriteria: turkish
      ? [
          "En az 3 gerçek App Router route dosyası oluşturulmalı.",
          "Görünen tüm metinler Türkçe ve doğru Türkçe karakterlerle yazılmalı.",
          "Tek sayfalık jenerik template hissi olmamalı.",
          "Ortak component ve content/config yapısı kullanılmalı.",
          "Responsive, erişilebilir ve animasyonlu ilk sürüm olmalı.",
        ]
      : [
          "Create at least 3 real App Router route files.",
          "All preview-visible copy must be English.",
          "Avoid one-page generic template feel.",
          "Use shared components and content/config structure.",
          "Ship a responsive, accessible, animated first version.",
        ],
  };
}

function sanitizeArchitectSpec(
  value: Partial<ArchitectSpec> | null,
  fallback: ArchitectSpec
): ArchitectSpec {
  const routes = Array.isArray(value?.routes)
    ? dedupeArchitectRoutes(
        value.routes
          .filter(Boolean)
          .map((route) => ({
            path: String((route as ArchitectSpecRoute).path || "/"),
            purpose: String((route as ArchitectSpecRoute).purpose || ""),
            visibleTitle: String((route as ArchitectSpecRoute).visibleTitle || ""),
          }))
      )
    : [];
  const mergedRoutes = dedupeArchitectRoutes([
    ...(routes.some((route) => route.path === "/") ? [] : fallback.routes.slice(0, 1)),
    ...routes,
    ...fallback.routes,
  ]).slice(0, 5);

  return {
    projectType: String(value?.projectType || fallback.projectType).slice(0, 120),
    language: value?.language === "en" || value?.language === "tr"
      ? value.language
      : fallback.language,
    routes: mergedRoutes.length >= 3 ? mergedRoutes : fallback.routes,
    visualArchetype: String(value?.visualArchetype || fallback.visualArchetype || "").slice(
      0,
      120
    ),
    designDirection: String(value?.designDirection || fallback.designDirection).slice(
      0,
      900
    ),
    animationPlan:
      Array.isArray(value?.animationPlan) && value.animationPlan.length
        ? value.animationPlan.map(String).slice(0, 6)
        : fallback.animationPlan,
    components:
      Array.isArray(value?.components) && value.components.length
        ? value.components.map(String).slice(0, 8)
        : fallback.components,
    contentFiles:
      Array.isArray(value?.contentFiles) && value.contentFiles.length
        ? value.contentFiles.map(String).slice(0, 6)
        : fallback.contentFiles,
    acceptanceCriteria:
      Array.isArray(value?.acceptanceCriteria) && value.acceptanceCriteria.length
        ? value.acceptanceCriteria.map(String).slice(0, 10)
        : fallback.acceptanceCriteria,
  };
}

function extractJsonObject<T>(text: string): T | null {
  const cleaned = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start < 0 || end <= start) return null;

  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

async function createArchitectSpec(params: {
  userMessage: string;
  plannerBrief: string;
  recentMessages: string;
  provider: AiProviderConfig;
}): Promise<ArchitectSpec> {
  const fallback = createLocalArchitectSpec(params.userMessage);
  const turkish = isLikelyTurkish(params.userMessage);
  const system = `
You are Klawpen Core's product architect.
Create a compact JSON implementation spec for a professional multi-page Next.js App Router build.
Return JSON only. No markdown.
Schema:
{
  "projectType": "short type",
  "language": "tr" | "en",
  "routes": [{"path": "/", "purpose": "short", "visibleTitle": "label"}],
  "visualArchetype": "selected visual archetype name",
  "designDirection": "specific visual direction",
  "animationPlan": ["short motion requirement"],
  "components": ["src/components/example.tsx"],
  "contentFiles": ["src/lib/site-content.ts"],
  "acceptanceCriteria": ["testable criterion"]
}
Rules:
- Language must be ${turkish ? "tr" : "en"}.
- Use 3-5 real routes. The home route must be "/".
- Routes must match the user's domain, not a generic SaaS template.
- Follow the visual archetype from LOCAL_FALLBACK_SPEC unless there is a clearly better domain-specific reason to choose a different one.
- The designDirection must explicitly describe composition, palette, typography, motion, and forbidden template patterns.
- Prefer reusable components and content/config files.
- The spec must protect quality without making tiny edits slow; this is only for power builds.
`;
  const user = `
RECENT_CONVERSATION:
${clipText(params.recentMessages || "No recent conversation.", 8_000)}

PLANNER_BRIEF:
${clipText(params.plannerBrief, 12_000)}

USER_REQUEST:
${params.userMessage}

LOCAL_FALLBACK_SPEC:
${JSON.stringify(fallback, null, 2)}
`;

  try {
    const raw = await createAiChatText({
      provider: params.provider,
      system,
      user,
      temperature: 0.08,
      retries: 1,
    });
    const parsed = extractJsonObject<Partial<ArchitectSpec>>(raw);
    return sanitizeArchitectSpec(parsed, fallback);
  } catch (error) {
    console.warn(
      "AI architect spec failed; continuing with local architect spec:",
      error instanceof Error ? error.message : error
    );
    return fallback;
  }
}

function formatArchitectSpec(spec: ArchitectSpec | null): string {
  return spec ? JSON.stringify(spec, null, 2) : "No architect spec required.";
}

function validateBuildAgainstSpec(params: {
  userMessage: string;
  assistantContent: string;
  spec: ArchitectSpec | null;
  options?: BuildOptions;
}): ValidationResult {
  const issues: string[] = [];
  const { userMessage, assistantContent, spec } = params;
  const options = params.options || {};

  if (!hasBuildIntent(userMessage, options)) {
    return { passed: true, issues };
  }

  if (!hasExecutableCodeOperations(assistantContent)) {
    issues.push("The response has no executable edit operations.");
  }

  if (shouldRepairGeneratedBrandReuse(userMessage, assistantContent)) {
    issues.push("The generated customer-facing brand reuses Klawpen without user intent.");
  }

  if (hasBuilderMetaVisibleCopy(userMessage, assistantContent)) {
    issues.push(
      "Visible UI copy contains builder/meta language; rewrite it as customer-facing business copy."
    );
  }

  if (shouldRepairVisibleLanguageMismatch(userMessage, assistantContent)) {
    issues.push(
      isLikelyTurkish(userMessage)
        ? "Visible UI copy does not consistently use Turkish with correct Turkish characters."
        : "Visible UI copy does not consistently use English."
    );
  }

  if (
    isBroadBuildRequest(userMessage, options) &&
    !isExplicitSinglePageRequest(userMessage)
  ) {
    if (hasShallowBroadBuildStructure(assistantContent)) {
      issues.push(
        "Broad build is too shallow: it needs real routes, shared components, content/config structure, motion, and deeper implementation."
      );
    }

    issues.push(...getVisualDiversityIssues(userMessage, assistantContent, spec));

    const writes = getWriteOperations(assistantContent);
    const writtenPaths = new Set(
      writes.map((operation) => normalizeProjectPath(operation.path || ""))
    );
    const requiredRoutes = spec?.routes?.length
      ? spec.routes.slice(0, 4)
      : createLocalArchitectSpec(userMessage).routes.slice(0, 3);

    for (const route of requiredRoutes) {
      const routeFile = routePathToPageFile(route.path);
      if (!writtenPaths.has(routeFile)) {
        issues.push(
          `Architect spec route "${route.path}" is missing; write ${routeFile}.`
        );
      }
    }

    if (spec?.components?.length) {
      const hasAnySpecComponent = spec.components.some((filePath) =>
        writtenPaths.has(normalizeProjectPath(filePath))
      );
      if (!hasAnySpecComponent && !hasComponentStructure(writes)) {
        issues.push("Architect spec requires reusable shared components.");
      }
    }

    if (spec?.contentFiles?.length) {
      const hasAnySpecContentFile = spec.contentFiles.some((filePath) =>
        writtenPaths.has(normalizeProjectPath(filePath))
      );
      if (!hasAnySpecContentFile && !hasContentStructure(writes)) {
        issues.push("Architect spec requires a shared content/config/data file.");
      }
    }
  }

  return { passed: issues.length === 0, issues };
}

async function repairSpecValidationIssues(params: {
  userMessage: string;
  plannerBrief: string;
  architectSpec: ArchitectSpec | null;
  codeContext: string;
  draft: string;
  provider: AiProviderConfig;
  options?: BuildOptions;
}): Promise<string> {
  if (!shouldUsePowerBuildLayer(params.options)) return params.draft;

  const validation = validateBuildAgainstSpec({
    userMessage: params.userMessage,
    assistantContent: params.draft,
    spec: params.architectSpec,
    options: params.options,
  });

  if (validation.passed) return params.draft;

  console.warn("Architect/spec validation failed; requesting repair:", validation.issues);

  const repairInput = `
SYSTEM:
${prompt}

${BUILDER_SYSTEM_PROMPT}

You are repairing a draft that failed Klawpen's architect/spec validator.
Return exactly one <dec-code> block with executable edit tags only.
Do not explain outside the tags.

USER_REQUEST:
${params.userMessage}

PLANNER_BRIEF:
${params.plannerBrief}

ARCHITECT_SPEC:
${formatArchitectSpec(params.architectSpec)}

VISUAL_ARCHETYPE_CONTRACT:
${formatVisualArchetype(selectVisualArchetype(params.userMessage))}

VALIDATOR_ISSUES:
${validation.issues.map((issue) => `- ${issue}`).join("\n")}

PREVIOUS_DRAFT:
${params.draft}

CURRENT_CODEBASE_SNAPSHOT:
${clipText(params.codeContext, 80_000)}
`;

  try {
    const repaired = await createBuilderResponse(
      repairInput,
      params.provider,
      params.userMessage,
      params.options
    );
    const repairedValidation = validateBuildAgainstSpec({
      userMessage: params.userMessage,
      assistantContent: repaired,
      spec: params.architectSpec,
      options: params.options,
    });

    if (hasExecutableCodeOperations(repaired) && repairedValidation.passed) {
      return repaired;
    }

    console.warn(
      "Spec repair remained incomplete; keeping best executable response or falling back.",
      repairedValidation.issues
    );

    if (hasExecutableCodeOperations(repaired)) {
      return repaired;
    }

    if (hasExecutableCodeOperations(params.draft)) {
      console.warn(
        "Spec repair did not return executable edit tags; keeping the original executable AI draft instead of replacing it with fallback."
      );
      return params.draft;
    }

    const premiumAttempt = await createPremiumFallbackAttempt({
      userMessage: params.userMessage,
      plannerBrief: params.plannerBrief,
      architectSpec: params.architectSpec,
      codeContext: params.codeContext,
      provider: params.provider,
      options: params.options,
      reason: "Architect/spec validation repair did not return executable edit tags.",
    });

    if (premiumAttempt) return premiumAttempt;

    return buildFallbackAssistantContent(
      params.userMessage,
      "Architect/spec validation repair did not return executable edit tags."
    );
  } catch (error) {
    console.warn(
      "Spec validation repair failed; keeping previous draft:",
      error instanceof Error ? error.message : error
    );
    return params.draft;
  }
}

async function createBuilderResponse(
  input: string,
  provider: AiProviderConfig,
  userMessage?: string,
  options: BuildOptions = {}
): Promise<string> {
  if (userMessage && hasBuildIntent(userMessage, options)) {
    const visualArchetype = selectVisualArchetype(userMessage);
    return createAiChatText({
      provider,
      system: input,
      user: [
        "USER BUILD REQUEST:",
        userMessage,
        "",
        "Return exactly one <dec-code> block.",
        "Use executable edit tags only.",
        "Rewrite src/app/page.tsx completely.",
        "VISUAL ARCHETYPE CONTRACT:",
        formatVisualArchetype(visualArchetype),
        "The preview must visibly follow this archetype. Change the page silhouette, section rhythm, component geometry, palette, typography, and motion accordingly.",
        "Do not reuse the same nav/hero/stats/cards/FAQ skeleton across different prompts.",
        isLikelyTurkish(userMessage)
          ? "VISIBLE UI LANGUAGE: Turkish. Every preview-visible label, heading, CTA, form label, FAQ, route title, metadata title/description, empty state, and error/status text must be Turkish with correct Turkish characters. Do not leave English UI labels like Home, Services, Contact, Get Started, Learn More, Features, Pricing, or FAQ."
          : "VISIBLE UI LANGUAGE: English. Every preview-visible label, heading, CTA, form label, FAQ, route title, metadata title/description, empty state, and error/status text must be English.",
        "CLIENT-FACING COPY CONTRACT: The generated preview must read like the real business/product/publication speaking to its customers. Never write visible copy as Klawpen, an AI, a builder, a freelancer, or an agency explaining a draft.",
        "FORBIDDEN VISIBLE META WORDS: prompt, generated, AI, yapay zeka, Klawpen, Core, Builder, template, şablon, fallback, component, design direction, tasarım yönü, first version, ilk sürüm, launch-ready, yayına hazır, freelancer, proposal, gelişmiş studio.",
        "REFINED SCALE CONTRACT: no huge crude headings/buttons/cards. Use tasteful clamp ranges, compact nav, normal-sized CTAs, useful card content, balanced whitespace, and realistic density.",
        isBroadBuildRequest(userMessage, options) &&
        !isExplicitSinglePageRequest(userMessage)
          ? [
              "This is a broad website/app build: create a multi-page project, not a one-page landing.",
              "Create at least 3 real App Router page files: src/app/page.tsx plus 2+ supporting routes that fit the domain.",
              "Create shared components for navigation/layout/sections and a content/config/data file to avoid hardcoded repetition.",
              "Navigation links must point to real routes or real anchors; do not fake pages with navbar labels only.",
              "Include purposeful modern motion: page/section reveal classes, hover transitions, animated visual details, or CSS keyframes.",
              "If the prompt asks for a blog, magazine, news, article, content, writer, or publishing site: build a real editorial product with featured article, category rails, author cards, newsletter capture, article previews, reading-time metadata, topic filters, and at least one article/category route. Do not use SaaS stats cards.",
            ].join("\n")
          : "If the user explicitly requested a single-page result, keep it one route but still make it polished and componentized.",
        "Do not name the generated customer-facing brand Klawpen unless the user asks for Klawpen itself.",
        "The result must be specific to this prompt, not a reused generic template.",
        "Hard design fail conditions: giant headline with empty cards, generic stats unrelated to the prompt, blank panels, nav + hero + three cards template, fallback-style layout, freelancer/proposal copy, or any UI text that describes the build process.",
        options.planMode
          ? "Plan mode is enabled and the clarification gate has already passed: include a concise implementation plan inside the <dec-code> block, then implement decisively."
          : "Plan mode is disabled: infer professional defaults for missing minor details and implement directly.",
        "Raise the UI quality bar: build polished navigation, rich routes, responsive behavior, refined typography, deliberate color, animations, states, and product-specific copy. Avoid simple toy layouts and AI-looking oversized blocks.",
      ].join("\n"),
      temperature: Math.max(aiTemperature, 0.22),
      timeoutMs: AI_BUILDER_TIMEOUT_MS,
    });
  }

  return createAiText({
    provider,
    input,
    temperature: aiTemperature,
  });
}

async function createPremiumFallbackAttempt(params: {
  userMessage: string;
  plannerBrief: string;
  architectSpec?: ArchitectSpec | null;
  codeContext: string;
  provider: AiProviderConfig;
  options?: BuildOptions;
  reason: string;
}): Promise<string | null> {
  const turkish = isLikelyTurkish(params.userMessage);
  const visualArchetype = selectVisualArchetype(params.userMessage);
  const isBlogLike = /\b(blog|magazin|magazine|haber|news|article|makale|yazar|writer|content|i[cç]erik|publishing|yay[ıi]n)\b/i.test(
    normalizePromptText(params.userMessage)
  );

  const system = `
${prompt}

${BUILDER_SYSTEM_PROMPT}

You are in LAST-CHANCE PREMIUM BUILD MODE.
The previous build attempt failed because: ${params.reason}

This is not a place for a safe generic fallback. Produce a professional, prompt-specific, production-quality implementation now.
Return exactly one <dec-code> block with executable tags. No markdown fences.

QUALITY BAR:
- Build for a polished Replit/Lovable-level preview, not a template.
- Create real App Router pages, shared components, and a content/config file.
- The visual concept must be distinct and complete: no empty panels, no unrelated generic stats, no oversized headline-only hero, no nav + hero + three cards skeleton.
- Use real customer-visible copy in ${turkish ? "Turkish with correct Turkish characters" : "English"}.
- Visible UI copy must sound like the real customer website, not a freelancer proposal, builder status, Klawpen output, or AI-generated draft.
- Never show these words in preview copy unless the user explicitly requested that exact subject: prompt, generated, AI, yapay zeka, Klawpen, Core, Builder, template, şablon, fallback, component, design direction, tasarım yönü, first version, ilk sürüm, launch-ready, yayına hazır, freelancer, proposal, gelişmiş studio.
- Use refined proportions: smaller CTAs, compact nav, controlled display type, useful card density, and no huge empty panels.
- Keep code maintainable and imports valid.

${isBlogLike ? `
BLOG / EDITORIAL SPEC:
- Create an editorial/magazine product, not a generic startup landing page.
- Required UI modules: featured story, editor picks, category rail, article cards with reading time/date/author, newsletter capture, author/editor card, topic filters, and a realistic footer.
- Required routes: home, articles or blog, categories or topics, about/contact/newsletter route.
- The hero should feel like a premium digital publication with strong imagery panels, issue metadata, article hierarchy, and tasteful motion.
` : ""}

VISUAL ARCHETYPE:
${formatVisualArchetype(visualArchetype)}
`;

  const user = `
USER REQUEST:
${params.userMessage}

PLANNER BRIEF:
${params.plannerBrief}

ARCHITECT SPEC:
${formatArchitectSpec(params.architectSpec || null)}

CURRENT CODEBASE SNAPSHOT:
${clipText(params.codeContext, 45_000)}
`;

  try {
    const response = await createAiChatText({
      provider: params.provider,
      system,
      user,
      temperature: Math.max(aiTemperature, 0.24),
      retries: Math.max(aiMaxRetries, 2),
      timeoutMs: AI_BUILDER_TIMEOUT_MS,
    });

    if (hasExecutableCodeOperations(response)) {
      return response;
    }

    console.warn(
      "Premium fallback attempt did not return executable edit tags; deterministic fallback may be used."
    );
    return null;
  } catch (error) {
    console.warn(
      "Premium fallback attempt failed:",
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

async function createCriticReview(
  input: string,
  provider: AiProviderConfig
): Promise<CriticResult> {
  const text = await createAiText({
    provider,
    input,
    temperature: 0.1,
  });
  return parseCriticResult(text);
}

function selectReviewerProvider(
  currentProvider: AiProviderConfig,
  options: BuildOptions = {}
): AiProviderConfig {
  if (!CROSS_REVIEW_ENABLED || !shouldUsePowerBuildLayer(options)) {
    return currentProvider;
  }

  try {
    const providers = getAiProviders();
    const preferredReviewer =
      providers.find(
        (provider) =>
          provider.key !== currentProvider.key &&
          (provider.key === "sk" || provider.envPrefix === "SK")
      ) || providers.find((provider) => provider.key !== currentProvider.key);

    return preferredReviewer || currentProvider;
  } catch {
    return currentProvider;
  }
}

async function createConversationalAnswer(
  userMessage: string,
  recentConversation: string,
  provider: AiProviderConfig
): Promise<string> {
  const turkish = isLikelyTurkish(userMessage);
  const input = `
SYSTEM:
You are Klawpen Agent, a concise and professional product-building assistant.
Answer the user's question directly in the same language as the user.
Do not emit code-edit tags. Do not modify files. Do not claim that you changed code.
If the user seems to want a build but has not provided enough detail, ask up to 3 focused clarification questions.
End with a short invitation to share what they want next.

LANGUAGE:
${turkish ? "Turkish" : "English"}

RECENT CONVERSATION:
${recentConversation || "No prior conversation."}

USER:
${userMessage}
`;

  return createAiText({
    provider,
    input,
    temperature: Math.min(aiTemperature, 0.25),
    retries: Math.min(aiMaxRetries, 1),
  });
}

async function reviseBuildAfterLocalQualityGate(params: {
  userMessage: string;
  plannerBrief: string;
  architectSpec?: ArchitectSpec | null;
  codeContext: string;
  draft: string;
  provider: AiProviderConfig;
  options?: BuildOptions;
  reason: string;
}) {
  const revisionInput = `
SYSTEM:
${prompt}

${BUILDER_SYSTEM_PROMPT}

The previous build failed a local Klawpen quality gate:
${params.reason}

Return exactly one <dec-code> block with executable edit tags only.
Preserve the user's intent, but rewrite the implementation so the preview feels like a finished public-facing website for a real business.

USER_REQUEST:
${params.userMessage}

PLANNER_BRIEF:
${params.plannerBrief}

ARCHITECT_SPEC:
${formatArchitectSpec(params.architectSpec || null)}

VISUAL_ARCHETYPE_CONTRACT:
${formatVisualArchetype(selectVisualArchetype(params.userMessage))}

PREVIOUS_DRAFT:
${params.draft}

CURRENT_CODEBASE_SNAPSHOT:
${clipText(params.codeContext, 80_000)}
`;

  try {
    const revised = await createBuilderResponse(
      revisionInput,
      params.provider,
      params.userMessage,
      params.options
    );
    return hasExecutableCodeOperations(revised) ? revised : params.draft;
  } catch (error) {
    console.warn(
      "Local quality gate revision failed; keeping current draft:",
      error instanceof Error ? error.message : error
    );
    return params.draft;
  }
}

async function improveWithCriticLoop(params: {
  userMessage: string;
  plannerBrief: string;
  architectSpec?: ArchitectSpec | null;
  codeContext: string;
  recentMessages: string;
  draft: string;
  provider: AiProviderConfig;
  options?: BuildOptions;
}): Promise<string> {
  let currentDraft = params.draft;
  const reviewerProvider = selectReviewerProvider(
    params.provider,
    params.options
  );

  for (let round = 1; round <= aiMaxCriticRounds; round++) {
    const criticInput = `
SYSTEM:
${CRITIC_SYSTEM_PROMPT}

MINIMUM_SCORE:
${aiMinQualityScore}

USER_REQUEST:
${params.userMessage}

PLANNER_BRIEF:
${params.plannerBrief}

ARCHITECT_SPEC:
${formatArchitectSpec(params.architectSpec || null)}

VISUAL_ARCHETYPE_CONTRACT:
${formatVisualArchetype(selectVisualArchetype(params.userMessage))}

RECENT_CONVERSATION:
${params.recentMessages || "No recent conversation."}

ASSISTANT_OUTPUT_TO_REVIEW:
${currentDraft}
`;

    if (hasBuilderMetaVisibleCopy(params.userMessage, currentDraft)) {
      currentDraft = await reviseBuildAfterLocalQualityGate({
        userMessage: params.userMessage,
        plannerBrief: params.plannerBrief,
        architectSpec: params.architectSpec || null,
        codeContext: params.codeContext,
        draft: currentDraft,
        provider: params.provider,
        options: params.options,
        reason:
          "Visible UI copy contains builder/meta language. Rewrite it as finished customer-facing website copy with no Klawpen/AI/prompt/template/first-version language.",
      });
      continue;
    }

    if (hasOversizedCrudeVisualSystem(currentDraft)) {
      currentDraft = await reviseBuildAfterLocalQualityGate({
        userMessage: params.userMessage,
        plannerBrief: params.plannerBrief,
        architectSpec: params.architectSpec || null,
        codeContext: params.codeContext,
        draft: currentDraft,
        provider: params.provider,
        options: params.options,
        reason:
          "The visual system is oversized and low-density. Reduce heading/button/card scale, add useful content density, and make the UI feel refined instead of AI-generated.",
      });
      continue;
    }

    let critic: CriticResult;
    try {
      critic = await createCriticReview(criticInput, reviewerProvider);
    } catch (error) {
      console.warn(
        "AI critic review failed; keeping the current executable draft:",
        error instanceof Error ? error.message : error
      );
      return currentDraft;
    }

    const passes =
      critic.verdict === "PASS" && critic.score >= aiMinQualityScore;

    if (passes) {
      return currentDraft;
    }

    const revisionInput = `
SYSTEM:
${prompt}

${BUILDER_SYSTEM_PROMPT}

You are revising a previous assistant response after strict quality review.
Improve the response quality based on feedback while preserving user intent.

USER_REQUEST:
${params.userMessage}

PLANNER_BRIEF:
${params.plannerBrief}

ARCHITECT_SPEC:
${formatArchitectSpec(params.architectSpec || null)}

VISUAL_ARCHETYPE_CONTRACT:
${formatVisualArchetype(selectVisualArchetype(params.userMessage))}

QUALITY_FEEDBACK:
${critic.feedback}

PREVIOUS_ASSISTANT_OUTPUT:
${currentDraft}

CURRENT_CODEBASE_SNAPSHOT:
${params.codeContext}
`;

    let revised: string;
    try {
      revised = await createBuilderResponse(
        revisionInput,
        params.provider,
        params.userMessage,
        params.options
      );
    } catch (error) {
      console.warn(
        "AI critic revision failed; keeping the current executable draft:",
        error instanceof Error ? error.message : error
      );
      return currentDraft;
    }

    if (hasExecutableCodeOperations(revised)) {
      currentDraft = revised;
      continue;
    }

    if (!hasExecutableCodeOperations(currentDraft)) {
      currentDraft = revised;
      continue;
    }

    console.warn(
      "AI critic revision had no executable edit tags; keeping previous executable draft."
    );
    return currentDraft;
  }

  return currentDraft;
}

async function repairMissingExecutableEdits(params: {
  userMessage: string;
  plannerBrief: string;
  architectSpec?: ArchitectSpec | null;
  codeContext: string;
  draft: string;
  provider: AiProviderConfig;
  options?: BuildOptions;
}): Promise<string> {
  const missingExecutableEdits = shouldForceFallbackPage(
    params.userMessage,
    params.draft,
    params.options
  );
  const shallowBroadBuild = shouldRepairBuildDepth(
    params.userMessage,
    params.draft,
    params.options
  );
  const reusedBuilderBrand = shouldRepairGeneratedBrandReuse(
    params.userMessage,
    params.draft
  );
  const builderMetaCopy = hasBuilderMetaVisibleCopy(
    params.userMessage,
    params.draft
  );
  const languageMismatch = shouldRepairVisibleLanguageMismatch(
    params.userMessage,
    params.draft
  );
  const oversizedVisualSystem =
    isBroadBuildRequest(params.userMessage, params.options) &&
    hasOversizedCrudeVisualSystem(params.draft);

  if (
    !missingExecutableEdits &&
    !shallowBroadBuild &&
    !reusedBuilderBrand &&
    !builderMetaCopy &&
    !languageMismatch &&
    !oversizedVisualSystem
  ) {
    return params.draft;
  }

  console.warn(
    "AI build response needs repair before apply:",
    {
      missingExecutableEdits,
      shallowBroadBuild,
      reusedBuilderBrand,
      builderMetaCopy,
      languageMismatch,
      oversizedVisualSystem,
    }
  );

  const repairReason = missingExecutableEdits
    ? "The previous assistant output is invalid because it did not contain executable edit operations."
    : shallowBroadBuild
      ? "The previous assistant output was too shallow for a broad build: it did not create enough real routes, shared structure, motion, or implementation depth."
      : reusedBuilderBrand
        ? "The previous assistant output reused Klawpen as the customer-facing generated brand without user intent."
        : builderMetaCopy
          ? "The previous assistant output used builder/meta language in customer-visible UI copy."
          : oversizedVisualSystem
            ? "The previous assistant output used oversized, low-density typography/cards/buttons that made the preview look crude and AI-generated."
            : "The previous assistant output used visible UI copy in a different language than the user's prompt.";

  const repairInput = `
SYSTEM:
${prompt}

${BUILDER_SYSTEM_PROMPT}

${repairReason}
Return exactly one <dec-code> block with executable edit tags.
For this build request, rewrite src/app/page.tsx and create a real multi-page App Router project:
- at least 3 page files total, including src/app/page.tsx plus 2+ supporting routes that fit the user's domain
- shared component files for navigation, layout, cards/sections, and reusable visual primitives
- a content/config/data file so copy and page metadata are organized instead of hardcoded repeatedly
- real links between pages and meaningful CTAs
- purposeful modern motion: transitions, hover states, reveal animations, or CSS keyframes
Visual archetype contract:
${formatVisualArchetype(selectVisualArchetype(params.userMessage))}
Do not reuse the generic centered hero + stat cards + three cards + FAQ skeleton. Change the silhouette, section order, geometry, and domain-specific modules.
The implementation must feel prompt-specific, visually polished, responsive, and complete enough to preview as a finished public website.
Customer-facing copy rule:
- Visible text must speak as the business/product/publication itself, not as Klawpen, an AI, a builder, a freelancer, or an agency explaining work.
- Never show builder/meta wording in the preview: prompt, generated, AI, yapay zeka, Klawpen, Core, Builder, template, şablon, fallback, component, design direction, tasarım yönü, first version, ilk sürüm, launch-ready, yayına hazır, freelancer, proposal, gelişmiş studio.
Refined design rule:
- Avoid giant headings, huge CTA buttons, empty decorative cards, and oversized rounded boxes.
- Use compact navigation/buttons, balanced card sizes, realistic content density, refined typography scale, and purposeful animation.
Visible UI language requirement:
- The user's prompt language is ${isLikelyTurkish(params.userMessage) ? "Turkish" : "English"}.
- All customer-visible UI copy must be ${isLikelyTurkish(params.userMessage) ? "Turkish with correct Turkish characters" : "English"}: navigation, page titles, headings, CTA buttons, cards, forms, FAQ, empty/error states, and metadata.
- Code identifiers and filenames may remain English, but preview text must not switch language.
Do not use Klawpen, Klawpen Cloud, or Klawpen Studio as the customer-facing site name unless the user explicitly asks for Klawpen.
Do not use markdown code fences. Do not only explain. Do not repeat the previous invalid response.

USER_REQUEST:
${params.userMessage}

PLANNER_BRIEF:
${params.plannerBrief}

ARCHITECT_SPEC:
${formatArchitectSpec(params.architectSpec || null)}

PREVIOUS_INVALID_OUTPUT:
${params.draft}

CURRENT_CODEBASE_SNAPSHOT:
${clipText(params.codeContext, 80_000)}
`;

  try {
    const repaired = await createBuilderResponse(
      repairInput,
      params.provider,
      params.userMessage,
      params.options
    );
    if (hasExecutableCodeOperations(repaired)) {
      if (
        !shouldRepairBuildDepth(params.userMessage, repaired, params.options) &&
        !shouldRepairGeneratedBrandReuse(params.userMessage, repaired) &&
        !hasBuilderMetaVisibleCopy(params.userMessage, repaired) &&
        !shouldRepairVisibleLanguageMismatch(params.userMessage, repaired) &&
        !hasOversizedCrudeVisualSystem(repaired)
      ) {
        return repaired;
      }

      console.warn(
        "AI repair response was executable but still shallow, meta-copy, oversized, reused builder branding, or mixed visible UI language; keeping executable AI output instead of replacing it with fallback."
      );
      return repaired;
    }

    console.warn(
      "AI repair response still did not meet executable/depth/branding requirements; falling back to generated landing page."
    );
    if (hasExecutableCodeOperations(params.draft)) {
      console.warn(
        "AI repair response had no executable edit tags; keeping the original executable AI draft instead of replacing it with fallback."
      );
      return params.draft;
    }

    const premiumAttempt = await createPremiumFallbackAttempt({
      userMessage: params.userMessage,
      plannerBrief: params.plannerBrief,
      architectSpec: params.architectSpec,
      codeContext: params.codeContext,
      provider: params.provider,
      options: params.options,
      reason: "AI repair response still had no executable edit tags.",
    });

    if (premiumAttempt) return premiumAttempt;

    return buildFallbackAssistantContent(
      params.userMessage,
      "AI repair response still had no executable edit tags."
    );
  } catch (error) {
    console.warn(
      "AI repair pass failed; falling back to generated landing page:",
      error instanceof Error ? error.message : error
    );
    if (hasExecutableCodeOperations(params.draft)) {
      console.warn(
        "AI repair pass failed; keeping the original executable AI draft instead of replacing it with fallback."
      );
      return params.draft;
    }

    const premiumAttempt = await createPremiumFallbackAttempt({
      userMessage: params.userMessage,
      plannerBrief: params.plannerBrief,
      architectSpec: params.architectSpec,
      codeContext: params.codeContext,
      provider: params.provider,
      options: params.options,
      reason: "AI repair pass failed before returning executable edit tags.",
    });

    if (premiumAttempt) return premiumAttempt;

    return buildFallbackAssistantContent(
      params.userMessage,
      "AI repair pass failed before returning executable edit tags."
    );
  }
}

async function runPostApplyQualityGates(params: {
  containerId: string;
  userMessage: string;
  assistantContent: string;
  applyResult: { applied: number; failed: Array<{ label: string; error: string }> };
  progress?: ProgressReporter;
  options?: BuildOptions;
}): Promise<string[]> {
  const reports: string[] = [];

  if (
    !shouldUsePowerBuildLayer(params.options) ||
    params.applyResult.applied <= 0 ||
    params.applyResult.failed.length > 0
  ) {
    return reports;
  }

  const isBroad =
    isBroadBuildRequest(params.userMessage, params.options) &&
    !isExplicitSinglePageRequest(params.userMessage);

  if (!isBroad) return reports;

  if (BUILD_GATE_ENABLED) {
    await params.progress?.(getBuildProgressCopy(params.userMessage, "verify", 92));

    try {
      const output = await withTimeout(
        fileService.runProjectCommand(params.containerId, ["npm", "run", "build"]),
        90_000,
        "project build gate"
      );
      reports.push(
        `Build gate passed.\n${clipText(output.trim() || "npm run build completed.", 2_000)}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reports.push(`Build gate failed:\n${clipText(message, 3_000)}`);
      console.warn("Build gate failed:", message);
    }
  }

  if (PREVIEW_CHECK_ENABLED) {
    await params.progress?.(
      getBuildProgressCopy(params.userMessage, "verify", BUILD_GATE_ENABLED ? 94 : 92)
    );

    try {
      const runtime = await dockerService.getPreviewRuntime(params.containerId);
      const url = dockerService.buildRawPreviewUrl(runtime.port);
      const response = await withTimeout(fetch(url), 20_000, "preview gate");
      const html = await response.text();

      if (!response.ok) {
        reports.push(`Preview gate failed: ${response.status} ${response.statusText}`);
      } else if (!html || html.length < 500) {
        reports.push("Preview gate warning: preview HTML was unexpectedly small.");
      } else {
        reports.push(`Preview gate passed: ${url}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reports.push(`Preview gate failed:\n${clipText(message, 2_000)}`);
      console.warn("Preview gate failed:", message);
    }
  }

  return reports;
}

export async function createChatSession(containerId: string): Promise<ChatSession> {
  const sessionId = `${containerId}-${Date.now()}`;
  const session: ChatSession = {
    id: sessionId,
    containerId,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  chatSessions.set(sessionId, session);
  return session;
}

export function getChatSession(sessionId: string): ChatSession | undefined {
  return chatSessions.get(sessionId);
}

export function getOrCreateChatSession(containerId: string): ChatSession {
  const existingSession = Array.from(chatSessions.values()).find(
    (session) => session.containerId === containerId
  );

  if (existingSession) {
    return existingSession;
  }

  const sessionId = `${containerId}-${Date.now()}`;
  const session: ChatSession = {
    id: sessionId,
    containerId,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  chatSessions.set(sessionId, session);
  return session;
}

function removeTrailingUnansweredUserMessage(
  session: ChatSession,
  userMessage: string
) {
  const lastMessage = session.messages[session.messages.length - 1];
  if (lastMessage?.role !== "user") return;
  if (lastMessage.content.trim() !== userMessage.trim()) return;

  session.messages.pop();
  session.updatedAt = new Date().toISOString();
}

export function addConversationalMessage(
  containerId: string,
  userMessage: string,
  assistantReply: string
): { userMessage: Message; assistantMessage: Message } {
  const session = getOrCreateChatSession(containerId);
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const userMsg: Message = {
    id: `user-${now}`,
    role: "user",
    content: userMessage,
    timestamp,
  };
  const assistantMsg: Message = {
    id: `assistant-${now + 1}`,
    role: "assistant",
    content: assistantReply,
    timestamp: new Date(now + 1).toISOString(),
  };

  session.messages.push(userMsg, assistantMsg);
  session.updatedAt = assistantMsg.timestamp;

  return { userMessage: userMsg, assistantMessage: assistantMsg };
}

export async function answerConversationOnlyMessage(
  containerId: string,
  userMessage: string,
  workloadEstimate?: AiWorkloadEstimate
): Promise<{ userMessage: Message; assistantMessage: Message }> {
  const session = getOrCreateChatSession(containerId);
  const recentConversation = session.messages
    .slice(-8)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");

  const provider = selectAiProvider(workloadEstimate);
  const assistantReply = await createConversationalAnswer(
    userMessage,
    recentConversation,
    provider
  );

  return addConversationalMessage(containerId, userMessage, assistantReply);
}

async function buildAssistantMessageFromSession(
  session: ChatSession,
  containerId: string,
  userMessage: string,
  workloadEstimate?: AiWorkloadEstimate,
  progress?: ProgressReporter,
  options: BuildOptions = {}
): Promise<{ assistantMessage: Message }> {
  const resolvedOptions = resolveBuildOptions(
    userMessage,
    options,
    workloadEstimate
  );
  await progress?.(getBuildProgressCopy(userMessage, "scan", 8));
  const fileContentTree = await fileService.getFileContentTree(
    dockerService.docker,
    containerId
  );

  const rawContext = JSON.stringify(fileContentTree, null, 2);
  const codeContext = clipText(rawContext, 120_000);
  let assistantContent: string;

  if (
    DETERMINISTIC_RUNTIME_FALLBACK_ENABLED &&
    isRuntimeRepairRequest(userMessage)
  ) {
    await progress?.(getBuildProgressCopy(userMessage, "repair", 28, [
      "src/app/page.tsx",
    ]));
    console.warn(
      "Runtime repair request detected; applying deterministic fallback page without waiting for AI."
    );
    assistantContent = buildFallbackAssistantContent(
      userMessage,
      "Replace the broken runtime page with a known-good structured Klawpen build."
    );
  } else {
    const provider = selectAiProvider(workloadEstimate);

    const recentMessages = session.messages
      .slice(-8)
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n");

    let plannerBrief = createLocalPlannerBrief(userMessage, options);
    let architectSpec: ArchitectSpec | null = null;
    await progress?.(getBuildProgressCopy(userMessage, "plan", 18));
    try {
      plannerBrief = await createPlannerBrief(
        userMessage,
        recentMessages,
        provider,
        resolvedOptions
      );
    } catch (error) {
      console.warn(
        "AI planner failed; continuing with local planner brief:",
        error instanceof Error ? error.message : error
      );
    }

    if (shouldCreateArchitectSpec(userMessage, resolvedOptions)) {
      await progress?.(getBuildProgressCopy(userMessage, "architect", 27));
      architectSpec = await createArchitectSpec({
        userMessage,
        plannerBrief,
        recentMessages,
        provider,
      });
    }
    const visualArchetype = selectVisualArchetype(userMessage);

    await progress?.(getBuildProgressCopy(userMessage, "draft", 36, [
      "src/app/page.tsx",
    ]));
    const systemPrompt = `${prompt}

${BUILDER_SYSTEM_PROMPT}

BUILD OPTIONS:
- Plan mode: ${resolvedOptions.planMode ? "enabled" : "disabled"}
- Quality mode: ${resolvedOptions.qualityMode}
- Power build: ${resolvedOptions.powerMode ? "enabled for this broad/heavy request" : "disabled for speed"}
- Quality target: polished Klawpen/Replit-style product prototype, not a basic template
- Visible UI language: ${isLikelyTurkish(userMessage) ? "Turkish. All preview-visible copy must be Turkish with correct Turkish characters." : "English. All preview-visible copy must be English."}

PLANNER BRIEF:
${plannerBrief}

ARCHITECT SPEC:
${formatArchitectSpec(architectSpec)}

VISUAL ARCHETYPE:
${formatVisualArchetype(visualArchetype)}

CURRENT CODEBASE SNAPSHOT:
${codeContext}`;

    const openaiMessages = [
      { role: "system" as const, content: systemPrompt },
      ...session.messages.map((msg) => ({
        role: msg.role as "user" | "assistant",
        content:
          msg.role === "user" && msg.attachments
            ? buildMessageContent(msg.content, msg.attachments)
            : msg.content,
      })),
    ];

    const flattenedInput = buildFlattenedInput(openaiMessages);

    try {
      assistantContent = await createBuilderResponse(
        flattenedInput,
        provider,
        userMessage,
        resolvedOptions
      );

      await progress?.(getBuildProgressCopy(userMessage, "review", 62));
      assistantContent = await improveWithCriticLoop({
        userMessage,
        plannerBrief,
        architectSpec,
        codeContext: clipText(codeContext, 80_000),
        recentMessages: clipText(recentMessages, 10_000),
        draft: assistantContent,
        provider,
        options: resolvedOptions,
      });

      if (shouldUsePowerBuildLayer(resolvedOptions)) {
        await progress?.(getBuildProgressCopy(userMessage, "validate", 70));
        assistantContent = await repairSpecValidationIssues({
          userMessage,
          plannerBrief,
          architectSpec,
          codeContext,
          draft: assistantContent,
          provider,
          options: resolvedOptions,
        });
      }

      await progress?.(getBuildProgressCopy(userMessage, "repair", 76));
      assistantContent = await repairMissingExecutableEdits({
        userMessage,
        plannerBrief,
        architectSpec,
        codeContext,
        draft: assistantContent,
        provider,
        options: resolvedOptions,
      });
    } catch (error) {
      console.error(
        "AI builder generation failed; trying premium fallback attempt before local fallback:",
        error instanceof Error ? error.message : error
      );
      assistantContent =
        (await createPremiumFallbackAttempt({
          userMessage,
          plannerBrief,
          architectSpec,
          codeContext,
          provider,
          options: resolvedOptions,
          reason:
            "AI provider failed or timed out before returning a valid executable build.",
        })) ||
        buildFallbackAssistantContent(
          userMessage,
          "AI provider failed or timed out before returning a valid executable build."
        );
    }
  }

  assistantContent = appendChangeSummaryTag(assistantContent, fileContentTree);
  await progress?.(
    getBuildProgressCopy(
      userMessage,
      "apply",
      86,
      getOperationFilePaths(assistantContent)
    )
  );
  const applyResult = await applyCodeOperations(
    containerId,
    assistantContent,
    userMessage,
    progress,
    resolvedOptions
  );

  const gateReports = await runPostApplyQualityGates({
    containerId,
    userMessage,
    assistantContent,
    applyResult,
    progress,
    options: resolvedOptions,
  });

  if (applyResult.failed.length > 0) {
    const failedItems = applyResult.failed
      .slice(0, 4)
      .map((item) => `- ${item.label}: ${item.error}`)
      .join("\n");

    assistantContent += `\n<dec-error>Some generated edits could not be applied automatically. The backend logged the details:\n${failedItems}</dec-error>`;
  }

  if (gateReports.length > 0) {
    assistantContent += `\n<dec-verification>${gateReports
      .map((report) => clipText(report, 3_500))
      .join("\n\n")}</dec-verification>`;
  }

  await progress?.(
    getBuildProgressCopy(
      userMessage,
      "refresh",
      96,
      getOperationFilePaths(assistantContent)
    )
  );

  const assistantMsg: Message = {
    id: `assistant-${Date.now()}`,
    role: "assistant",
    content: assistantContent,
    timestamp: new Date().toISOString(),
    edits: applyResult,
  };

  session.messages.push(assistantMsg);
  session.updatedAt = new Date().toISOString();

  return {
    assistantMessage: assistantMsg,
  };
}

export async function sendMessage(
  containerId: string,
  userMessage: string,
  attachments: Attachment[] = [],
  workloadEstimate?: AiWorkloadEstimate,
  options: BuildOptions = {}
): Promise<{ userMessage: Message; assistantMessage: Message }> {
  const session = getOrCreateChatSession(containerId);
  removeTrailingUnansweredUserMessage(session, userMessage);

  const userMsg: Message = {
    id: `user-${Date.now()}`,
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
    attachments: attachments.length > 0 ? attachments : undefined,
  };

  session.messages.push(userMsg);

  const { assistantMessage } = await buildAssistantMessageFromSession(
    session,
    containerId,
    userMessage,
    workloadEstimate,
    undefined,
    options
  );

  return {
    userMessage: userMsg,
    assistantMessage,
  };
}

export async function* sendMessageStream(
  containerId: string,
  userMessage: string,
  attachments: Attachment[] = [],
  workloadEstimate?: AiWorkloadEstimate,
  options: BuildOptions = {}
): AsyncGenerator<{ type: "user" | "assistant" | "progress" | "done"; data: any }> {
  const session = getOrCreateChatSession(containerId);
  removeTrailingUnansweredUserMessage(session, userMessage);

  const userMsg: Message = {
    id: `user-${Date.now()}`,
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
    attachments: attachments.length > 0 ? attachments : undefined,
  };

  session.messages.push(userMsg);
  yield { type: "user", data: userMsg };

  const progressQueue: BuildProgress[] = [];
  let wakeProgressReader: (() => void) | null = null;
  let buildFinished = false;

  const buildPromise = buildAssistantMessageFromSession(
    session,
    containerId,
    userMessage,
    workloadEstimate,
    (progress) => {
      progressQueue.push(progress);
      wakeProgressReader?.();
      wakeProgressReader = null;
    },
    options
  ).finally(() => {
    buildFinished = true;
    wakeProgressReader?.();
    wakeProgressReader = null;
  });

  while (!buildFinished || progressQueue.length > 0) {
    while (progressQueue.length > 0) {
      const progress = progressQueue.shift();
      if (progress) yield { type: "progress", data: progress };
    }

    if (buildFinished) break;

    await Promise.race([
      buildPromise.then(() => undefined).catch(() => undefined),
      new Promise<void>((resolve) => {
        wakeProgressReader = resolve;
      }),
    ]);
  }

  const { assistantMessage } = await buildPromise;

  yield { type: "assistant", data: assistantMessage };
  yield { type: "done", data: assistantMessage };
}
