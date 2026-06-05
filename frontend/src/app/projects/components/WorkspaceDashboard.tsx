"use client";

import {
  ChevronDown,
  ChevronsUpDown,
  Download,
  ExternalLink,
  GitBranch,
  Lock,
  Rocket,
  Settings,
  Smartphone,
  Terminal,
  Upload,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "react-hot-toast";
import { fetchAccountSnapshot } from "@/lib/account/client";
import { API_BASE_URL } from "@/lib/backend/api";
import { getBackendAuthHeaders } from "@/lib/backend/auth";
import { createClient as createSupabaseClient } from "@/lib/supabase/client";
import type { AccountSnapshot } from "@/lib/account/types";
import {
  type Container,
  getChatHistory,
  getContainers,
  Message,
  sendChatMessage,
  sendChatMessageStream,
} from "@/lib/backend/api";
import { buildProjectZipFromFileApi } from "../../../lib/export/projectZip";
import { ChatInput } from "../../create/components/ChatInput";
import { ChatMessage } from "../../create/components/ChatMessage";
import CodeEditor from "../../editor/CodeEditor";
import { LivePreview } from "./LivePreview";
import {
  AccountSeatsSection,
  AccountUsageSection,
  AdvancedSection,
  BillingSection,
  PreferencesSection,
  PricingModal,
  ProfileSection,
  PromotionsSection,
  ReferralSummary,
  SecuritySection,
  SETTINGS_LOCAL_STORAGE_KEYS,
  SETTINGS_PROFILE_EMAIL_STORAGE_KEY,
  SettingsSidebar,
  WorkspaceUsageSection,
} from "./SettingsPanelContent";
import type { UiLanguage, UiTheme } from "./ProjectsPage";

interface WorkspaceDashboardProps {
  containerId: string;
}

type BillingCycle = "monthly" | "yearly";
type AccountPlan = "starter" | "core" | "pro" | "enterprise";
type SettingsPanelSection =
  | "profile"
  | "preferences"
  | "promotions"
  | "billing"
  | "security"
  | "usage"
  | "accountUsage"
  | "accountSeats"
  | "advanced";

const ACCOUNT_PLAN_STORAGE_KEY = "december:account-plan";
const PROJECT_METADATA_STORAGE_KEY = "december:project-metadata";
const workspaceProfileStoragePrefix = "december:prefs:kaichen";
const UI_THEME_STORAGE_KEY = "december:ui-theme";
const UI_LANGUAGE_STORAGE_KEY = "december:ui-language";
const WORKSPACE_NOTIFICATIONS_STORAGE_KEY = `${workspaceProfileStoragePrefix}:notifications`;
const WORKSPACE_TWO_FACTOR_STORAGE_KEY = `${workspaceProfileStoragePrefix}:twoFactor`;
const WORKSPACE_LOGIN_ALERTS_STORAGE_KEY = `${workspaceProfileStoragePrefix}:loginAlerts`;

interface StoredProjectMetadata {
  title?: string;
  summary?: string;
  prompt?: string;
}

const isAccountPlan = (value: string | null): value is AccountPlan =>
  value === "starter" ||
  value === "core" ||
  value === "pro" ||
  value === "enterprise";

const isUiTheme = (value: string | null): value is UiTheme =>
  value === "light" || value === "dark";

const isUiLanguage = (value: string | null): value is UiLanguage =>
  value === "en" || value === "tr";

const detectBrowserTheme = (): UiTheme => {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};

const detectBrowserLanguage = (): UiLanguage => {
  if (typeof navigator === "undefined") return "en";
  const primaryLanguage = (
    navigator.languages?.[0] ||
    navigator.language ||
    "en"
  ).toLowerCase();
  return primaryLanguage.startsWith("tr") ? "tr" : "en";
};

const resolveInitialTheme = (): UiTheme => {
  if (typeof window === "undefined") return "light";
  const storedTheme = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
  return isUiTheme(storedTheme) ? storedTheme : detectBrowserTheme();
};

const resolveInitialLanguage = (): UiLanguage => {
  if (typeof window === "undefined") return "en";
  return detectBrowserLanguage();
};

const resolveStoredBoolean = (key: string, fallback: boolean) => {
  if (typeof window === "undefined") return fallback;
  const storedValue = window.localStorage.getItem(key);
  if (storedValue === "true") return true;
  if (storedValue === "false") return false;
  return fallback;
};

const readStoredProjectMetadata = (): Record<string, StoredProjectMetadata> => {
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
  return cleaned ? toTitleCase(cleaned) : "Untitled Project";
};

const cleanContainerName = (name: string | null | undefined, id: string) => {
  const raw = (name || "").replace(/[\/_-]+/g, " ").trim();
  return raw ? toTitleCase(raw) : `Project ${id.slice(0, 8)}`;
};

const getProjectTitle = (
  container: Container,
  metadata: Record<string, StoredProjectMetadata>
) => {
  const saved = metadata[container.id];
  const promptFromLabel =
    container.labels?.prompt ||
    container.labels?.description ||
    container.labels?.title ||
    "";

  return (
    saved?.title ||
    (saved?.prompt ? buildTitleFromPrompt(saved.prompt) : "") ||
    (promptFromLabel ? buildTitleFromPrompt(promptFromLabel) : "") ||
    cleanContainerName(container.name, container.id)
  );
};

const getContainerCreatedTime = (container: Container) => {
  const parsedTime = new Date(container.created).getTime();
  return Number.isFinite(parsedTime) ? parsedTime : 0;
};

export const WorkspaceDashboard = ({
  containerId,
}: WorkspaceDashboardProps) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState<string>("");
  const [viewMode, setViewMode] = useState<"preview" | "editor">("editor");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [hasProcessedPrompt, setHasProcessedPrompt] = useState<boolean>(false);
  const [workspaceRefreshVersion, setWorkspaceRefreshVersion] = useState(0);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(
    null
  );
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isDesktopView, setIsDesktopView] = useState<boolean>(true);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [settingsPanelVisible, setSettingsPanelVisible] = useState(false);
  const [settingsPanelSection, setSettingsPanelSection] =
    useState<SettingsPanelSection>("profile");
  const [displayedSettingsPanelSection, setDisplayedSettingsPanelSection] =
    useState<SettingsPanelSection>("profile");
  const [settingsContentVisible, setSettingsContentVisible] = useState(true);
  const [pricingModalOpen, setPricingModalOpen] = useState(false);
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");
  const [activePlan, setActivePlan] = useState<AccountPlan>("starter");
  const [accountSnapshot, setAccountSnapshot] = useState<AccountSnapshot | null>(null);
  const [settingsTheme, setSettingsTheme] = useState<UiTheme>(resolveInitialTheme);
  const [settingsLanguage, setSettingsLanguage] =
    useState<UiLanguage>(resolveInitialLanguage);
  const [profileAvatarDataUrl, setProfileAvatarDataUrl] = useState<
    string | null
  >(null);
  const [profileFirstName, setProfileFirstName] = useState("kaichen");
  const [profileLastName, setProfileLastName] = useState("Yilmaz");
  const [profileBio, setProfileBio] = useState("");
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [loginAlertsEnabled, setLoginAlertsEnabled] = useState(true);
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectContainers, setProjectContainers] = useState<Container[]>([]);
  const [projectMetadata, setProjectMetadata] = useState<
    Record<string, StoredProjectMetadata>
  >({});
  const [isProjectMenuLoading, setIsProjectMenuLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamCancelRef = useRef<(() => void) | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const workspaceSwitcherRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const settingsPanelCloseTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const settingsContentSwapTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const isDark = settingsTheme === "dark";
  const accountEntitlements = accountSnapshot?.entitlements;
  const profileDisplayName =
    `${profileFirstName} ${profileLastName}`.trim() ||
    accountSnapshot?.profile.displayName ||
    "kaichen";
  const profileStudioName = `${profileDisplayName} Studio`;
  const accountName = profileFirstName.trim() || "kaichen";
  const workspaceInitials =
    `${profileFirstName.trim()[0] || "K"}${profileLastName.trim()[0] || "Y"}`
      .toUpperCase()
      .slice(0, 2);
  const profileUsername =
    accountName.toLowerCase().replace(/\s+/g, "") || "kaichen";
  const profileEmail = accountSnapshot?.profile.email || `${profileUsername}@icloud.com`;
  const bioRemaining = Math.max(0, 140 - profileBio.length);
  const hasPaidPlan = activePlan !== "starter";

  const settingsLabelsEn = {
    workspace: `${accountName}'s Workspace`,
    settings: "Settings",
    workspaceLabel: "Workspace",
    workspaceUsage: "Workspace usage",
    security: "Security",
    accountLabel: "Account",
    billing: "Billing",
    accountSeats: "Account seats",
    accountSeatsTitle: "Account seats",
    accountSeatsSubtitle:
      "Manage who can access this workspace and keep team capacity under control.",
    accountUsage: "Account usage",
    accountUsageTitle: "Account usage",
    accountUsageSubtitle:
      "Track your Klawpen Core limits, model activity, and generation flow for this billing cycle.",
    accountUsagePlan: "Active plan",
    accountUsageAiRequests: "AI requests",
    accountUsageImages: "Image references",
    accountUsageProjects: "Project builds",
    accountUsageRemaining: "remaining",
    accountUsageUpdated: "Updated just now",
    accountUsageTrend: "Usage trend",
    accountUsageModelMix: "Model mix",
    accountUsageSoftLimit: "Soft limit",
    accountUsageHardLimit: "Hard limit",
    accountBalance: "Balance",
    apiAccessEnabled: "API access enabled",
    apiAccessDisabled: "API access disabled",
    managePlan: "Manage plan",
    advanced: "Advanced",
    advancedTitle: "Advanced",
    advancedSubtitle:
      "Fine tune workspace behavior, local cache, and safety controls.",
    owner: "Owner",
    collaborator: "Collaborator",
    emptySeat: "Open seat",
    invitePending: "Ready for invite",
    available: "Available",
    pendingInvite: "Pending invite",
    inviteSent: "Invite sent",
    inviteEmailPlaceholder: "teammate@company.com",
    sendInvite: "Send invite",
    cancel: "Cancel",
    teamSeats: "Team seats",
    inviteMember: "Invite member",
    seatsUsed: "Seats used",
    pendingInvites: "Pending invites",
    seatLimit: "Seat limit",
    commandPalette: "Command palette",
    commandPaletteDesc:
      "Use the quick launcher for files, actions, and workspace commands.",
    dataControls: "Data controls",
    dataControlsDesc:
      "Keep assistant activity and local settings scoped to this browser.",
    workspaceCache: "Workspace cache",
    workspaceCacheDesc:
      "Preload frequently edited files so the code editor opens faster.",
    enabled: "Enabled",
    optimized: "Optimized",
    resetPreferences: "Reset local preferences",
    resetPreferencesDesc:
      "Clear saved theme, language, notification, and security toggles on this browser.",
    reset: "Reset",
    preferencesReset: "Preferences reset",
    userLabel: "User",
    profile: "Profile",
    preferences: "Preferences",
    notifications: "Notifications",
    notificationsDesc:
      "Receive product updates, workspace alerts, and account activity.",
    themePreference: "Theme",
    themePreferenceDesc: "Choose how Klawpen looks across your workspace.",
    languagePreference: "Language",
    languagePreferenceDesc:
      "Apply the interface language across projects, settings, and prompts.",
    light: "Light",
    dark: "Dark",
    promotionsAndReferrals: "Promotions & Referrals",
    securityCenter: "Security Center",
    securityDesc: "Protect your account and keep your workspace safe.",
    securityScore: "Security score",
    recommended: "Recommended",
    secured: "Secured",
    activeSessions: "Active sessions",
    activeSessionsDesc: "Manage signed-in devices linked to your account.",
    deviceThisBrowser: "This browser - Istanbul",
    lastActiveNow: "Last active: now",
    twoFactorAuth: "Two-factor authentication",
    twoFactorDesc: "Add an extra verification step when signing in.",
    loginAlerts: "Login alerts",
    loginAlertsDesc: "Get notified when a new device signs in.",
    signOutOthers: "Sign out other sessions",
    otherSessionsSignedOut: "Other sessions signed out",
    viewPreviousInvoices: "View previous invoices here.",
    hideInvoices: "Hide invoices",
    noPreviousInvoices: "No previous invoices yet",
    billingUsageDelay:
      "Updates take up to 1 hour and may not reflect the latest usage data.",
    currentPlan: "Current plan",
    paymentMethod: "Payment method",
    noPaymentMethod: "No payment method on file",
    changePlan: "Change plan",
    changePlanDesc: "View or change your subscription plan",
    billingUpgrade: "Upgrade",
    promotionsHub: "Promotions Hub",
    promotionsDesc: "Grow your project reach with campaigns and referral perks.",
    referrals: "Referrals",
    referralDesc:
      "Bring your friends to Klawpen. They get bonus credits when they upgrade, and so do you once you're on a paid plan.",
    referralCode: "Referral code",
    rewardRule: "Bonus per paid referral",
    successfulReferrals: "Successful referrals",
    pendingReferrals: "Pending referrals",
    totalRewards: "Total rewards",
    pendingRewards: "Pending rewards",
    copyCode: "Copy code",
    copyLink: "Copy link",
    bonusCta: "Upgrade to Core to claim your bonus credits",
    bonusClaimed: "Bonus claimed",
    referralIntro:
      "Share your referral link with friends. When they subscribe through your code, your reward summary updates automatically.",
    loadingReferralData: "Loading referral data...",
    updatesMayDelay:
      "Updates take up to 1 hour and may not reflect the latest usage data.",
    viewAllUsage: "View all usage",
    hideUsageDetails: "Hide usage details",
    totalUsage: "Total usage",
    agentUsers: "Agent users",
    agentUsage: "Agent usage",
    noAgentUsage: "No agent usage",
    noAgentUsageDesc:
      "No agent usage data is available for this billing period.",
    username: "Username",
    firstName: "First name",
    lastName: "Last name",
    bio: "Bio",
    addBio: "Add a bio",
    saveChanges: "Save changes",
    viewPublicProfile: "View my public profile",
    yourEmail: "Your email",
    yourPassword: "Your password",
    edit: "Edit",
    locked: "Locked",
    publicProfilePreview: "Public profile preview",
    publicProfileOpened: "Hide public profile",
    emailEdit: "Edit email",
    emailSaved: "Email saved",
    passwordUpdated: "Password updated",
    passwordUpdatedDesc: "Last change is saved on this browser.",
    comparePlans: "Compare plans",
    compareSubtitle: "Choose the best plan for you",
    monthly: "Monthly",
    yearly: "Yearly",
    yearlyDiscount: "20% off yearly",
    starter: "Starter",
    corePlan: "Core",
    proPlan: "Pro",
    enterprise: "Enterprise",
    continueCore: "Continue with Core",
    continuePro: "Continue with Pro",
    contactSales: "Contact sales",
    pricingFootnote:
      "Yearly billing applies a 20% discount to the monthly plan price.",
    close: "Close",
    personal: "Personal",
    team: "Team",
    createWorkspace: "Create workspace",
    workspaceCardTitle: "Workspace details",
    workspaceCardText:
      "Choose a workspace mode. Personal is optimized for solo speed. Team is optimized for collaboration.",
    workspaceOwner: "Workspace owner",
    preview: "Preview",
    code: "Code",
    mobile: "Mobile",
    desktop: "Desktop",
    switchToMobile: "Switch preview to mobile",
    switchToDesktop: "Switch preview to desktop",
    openPreview: "Open preview",
    openPreviewProject: "Open preview in a new tab",
    previewLinkUnavailable: "Preview link is not ready yet",
    export: "Export",
    exportProject: "Export project",
    deploy: "Deploy",
    deployProject: "Deploy project",
    workspaceStatus: "Live workspace",
    readyStatus: "Ready",
    buildMode: "Build mode",
    meshFireStudio: "Klawpen Studio",
    currentProject: "Current project",
    projectName: "AI Banking App",
    recentProjects: "Recent projects",
    noOtherProjects: "No other projects yet",
    switchProject: "Switch project",
    aiAssistance: "AI Assistance",
    meshFireAgent: "Klawpen Agent",
    chat: "Chat",
    dropFilesHere: "Drop files here",
    dropFilesDesc: "Images, PDFs, and documents are supported",
    agentThinking: "Klawpen Agent is thinking",
    agentThinkingDesc: "Reading your request and preparing the next change.",
    askFollowUp: "Ask about this code...",
    welcomeAssistantName: "Assistant",
    welcomeTitle:
      "Welcome to your Next.js project. I am here to help you build, modify, and deploy your application.",
    welcomeCanHelp: "I can help you with:",
    welcomeFeatureOne: "Adding new features and components",
    welcomeFeatureTwo: "Modifying existing code",
    welcomeFeatureThree: "Installing packages and dependencies",
    welcomeFeatureFour: "Debugging and troubleshooting",
    welcomeFeatureFive: "Optimizing performance",
    welcomeClosing: "Tell me what you want to change and I will handle it.",
    exportReady: "Export ready",
    exportFailed: "Export failed. Please try again.",
    deploySoon: "Deploy is coming soon",
    profileSaved: "Profile saved",
    copied: "Copied",
    copyFailed: "Copy failed",
    fileUnsupported: "is not a supported file type",
    fileTooLarge: "is too large (max 5MB per file)",
    totalSizeExceeded: "Total file size exceeds 20MB limit",
    processingFilesError: "Error processing files. Please try again.",
    filesTooLarge: "Files are too large. Please reduce the size and try again.",
    connectionError: "Connection error. Please try again.",
    assistantError: "Sorry, I encountered an error. Please try again.",
    initialAssistantError:
      "Sorry, I had trouble processing your request. Please try again.",
    filesReady: "file(s) ready to send!",
    filesAddedPartial: "files added",
    filesOf: "of",
    files: "Files",
    search: "Search",
    components: "Components",
    debug: "Debug",
    issues: "Issues",
    labs: "Labs",
    actions: "Actions",
    upgrade: "Upgrade",
    explorer: "Explorer",
    explorerLayout: "Explorer layout",
    searchFiles: "Search files...",
    searchMatches: "Matching workspace files",
    recentFiles: "Quick open suggestions",
    noSearchResults: "No matching files yet.",
    componentMap: "Reusable UI and route surfaces",
    componentFiles: "Component files",
    routeFiles: "Route files",
    routes: "Routes",
    component: "UI",
    route: "Route",
    noComponents: "No component files found.",
    reviewItems: "Runtime, save and file health",
    unsavedFile: "Unsaved file",
    treeUnavailable: "File tree unavailable",
    treeUnavailableDesc: "Container files could not be loaded yet.",
    contentUnavailable: "File content unavailable",
    emptyWorkspace: "No files indexed",
    emptyWorkspaceDesc: "The file tree is empty right now.",
    noIssues: "No blocking issues",
    noIssuesDesc: "Open files, save state and file tree look healthy.",
    active: "Active",
    loadingFiles: "Loading files...",
    noFilesFound: "No files found",
    openFileFromExplorer: "Open a file from Explorer",
    workspaceFiles: "Workspace files",
    noFileSelected: "No file selected",
    selectFileToEdit: "Select a file from the sidebar to start editing",
    maximizeEditor: "Maximize editor",
    moreEditorActions: "More editor actions",
    closeFile: "Close file",
    unsavedChanges: "Unsaved changes",
    saveFile: "Save file",
    noFileSelectedShort: "No file selected",
    save: "Save",
    saving: "Saving...",
    saved: "Saved",
    lineCountLabel: "lines",
    fileCountLabel: "files",
    folderCountLabel: "folders",
    changeSummary: "Changes",
    changedIn: "in",
    created: "Created",
    deleted: "Deleted",
    renamed: "Renamed",
    moreFiles: "more",
    dependencies: "Dependencies",
    attachedFiles: "Attached files",
    total: "Total",
    removeFile: "Remove file",
    sendMessage: "Send message",
    addImage: "Add image",
    enhancePrompt: "Improve prompt",
    enhancePromptShort: "Refine",
    enhancePromptTooltip:
      "Rewrite this prompt so Klawpen Agent understands it better",
    enhanceStepIntent: "Intent",
    enhanceStepDetails: "Details",
    enhanceStepGuardrails: "Rules",
    enhancePromptEmpty: "Write a prompt first",
    enhancedPromptToast: "Prompt improved",
    deepMode: "Deep Mode",
    deepModeOn: "Deep on",
    selectAgent: "Select AI model",
    agentMenuFeatures: "Capabilities",
    agentMenuModels: "AI models",
    featureDeepThinking: "Deep thinking",
    featureDeepThinkingDesc: "Thinks longer before changing code",
    featureCoding: "Coding",
    featureCodingDesc: "Focused edits and implementation",
    featurePolish: "Polish",
    featurePolishDesc: "Cleaner UI and product details",
    meshFireCoder: "Klawpen Coder",
    meshFireFast: "Klawpen Fast",
    agentBalancedDesc: "Balanced build",
    agentCoderDesc: "Code-heavy changes",
    agentFastDesc: "Quick edits",
    modelOpusDesc: "Deep reasoning",
    modelSonnetDesc: "Balanced build",
    modelFastDesc: "Quick edits",
    dragDropFiles: "Drag & drop files anywhere",
    fileLimitInfo: "Max 5MB per file, 20MB total",
    assistant: "Assistant",
    checkpointMade: "Checkpoint made",
    justNow: "just now",
    oneMinuteAgo: "1 minute ago",
    minutesAgo: "minutes ago",
    oneHourAgo: "1 hour ago",
    hoursAgo: "hours ago",
    oneDayAgo: "1 day ago",
    daysAgo: "days ago",
    workedMoment: "Worked for a moment",
    workedUnderMinute: "Worked for under a minute",
    workedFor: "Worked for",
    minute: "minute",
    minutes: "minutes",
    hour: "hour",
    hours: "hours",
    min: "min",
    doneDefault: "Done - I applied the requested changes.",
    updated: "Updated",
    renameFile: "Rename File",
    deleteFile: "Delete File",
    addDependency: "Add Dependency",
    preparedCodeChanges: "I prepared the code changes.",
    thinkingProcess: "Thinking Process",
    error: "Error",
    success: "Success",
    checkedConsole: "I checked the console output.",
    usedExamples: "I used the provided examples as context.",
    currentRoute: "Current Route",
    reviewedChanges: "I reviewed the recent changes.",
    instructions: "Instructions",
    loadingPreview: "Loading preview...",
    previewError: "Preview Error",
    containerNotFound: "Container not found",
    containerNotRunning: "Container Not Running",
    startContainerPreview: "Start the container to see the live preview",
    status: "Status",
  };


  const settingsLabelsTr = {
    ...settingsLabelsEn,
    workspace: `${accountName} Calisma Alani`,
    settings: "Ayarlar",
    workspaceLabel: "Calisma Alani",
    workspaceUsage: "Calisma alani kullanimi",
    security: "Guvenlik",
    accountLabel: "Hesap",
    billing: "Faturalandirma",
    accountSeats: "Hesap koltuklari",
    accountSeatsTitle: "Hesap koltuklari",
    accountSeatsSubtitle:
      "Bu calisma alanina kimlerin erisecegini ve ekip kapasitesini yonet.",
    accountUsage: "Hesap kullanimi",
    accountUsageTitle: "Hesap kullanimi",
    accountUsageSubtitle:
      "Bu fatura donemi icin Klawpen Core limitlerini, model aktivitesini ve uretim akislarini takip et.",
    accountUsagePlan: "Aktif plan",
    accountUsageAiRequests: "AI istekleri",
    accountUsageImages: "Gorsel referanslar",
    accountUsageProjects: "Proje buildleri",
    accountUsageRemaining: "kaldi",
    accountUsageUpdated: "Simdi guncellendi",
    accountUsageTrend: "Kullanim trendi",
    accountUsageModelMix: "Model dagilimi",
    accountUsageSoftLimit: "Soft limit",
    accountUsageHardLimit: "Hard limit",
    accountBalance: "Bakiye",
    apiAccessEnabled: "API erisimi acik",
    apiAccessDisabled: "API erisimi kapali",
    managePlan: "Plani yonet",
    advanced: "Gelismis",
    advancedTitle: "Gelismis",
    advancedSubtitle:
      "Calisma alani davranisini, lokal cache'i ve guvenlik kontrollerini ince ayarla.",
    owner: "Sahip",
    collaborator: "Ekip uyesi",
    emptySeat: "Bos koltuk",
    invitePending: "Davet icin hazir",
    available: "Musait",
    pendingInvite: "Bekleyen davet",
    inviteSent: "Davet gonderildi",
    inviteEmailPlaceholder: "ekip@firma.com",
    sendInvite: "Davet gonder",
    cancel: "Vazgec",
    teamSeats: "Ekip koltuklari",
    inviteMember: "Uye davet et",
    seatsUsed: "Kullanilan koltuk",
    pendingInvites: "Bekleyen davet",
    seatLimit: "Koltuk limiti",
    commandPalette: "Komut paleti",
    commandPaletteDesc:
      "Dosyalar, aksiyonlar ve workspace komutlari icin hizli baslaticiyi kullan.",
    dataControls: "Veri kontrolleri",
    dataControlsDesc:
      "Asistan aktivitesini ve lokal ayarlari bu tarayiciya sinirla.",
    workspaceCache: "Workspace cache",
    workspaceCacheDesc:
      "Kod editorunun daha hizli acilmasi icin sik duzenlenen dosyalari on yukle.",
    enabled: "Aktif",
    optimized: "Optimize",
    resetPreferences: "Lokal tercihleri sifirla",
    resetPreferencesDesc:
      "Bu tarayicidaki tema, dil, bildirim ve guvenlik tercihlerini temizle.",
    reset: "Sifirla",
    preferencesReset: "Tercihler sifirlandi",
    userLabel: "Kullanici",
    profile: "Profil",
    preferences: "Tercihler",
    notifications: "Bildirimler",
    notificationsDesc:
      "Urun guncellemeleri, calisma alani uyarilari ve hesap aktivitelerini al.",
    themePreference: "Tema",
    themePreferenceDesc: "Klawpen'in calisma alaninda nasil gorunecegini sec.",
    languagePreference: "Dil",
    languagePreferenceDesc:
      "Arayuz dilini projelere, ayarlara ve prompt alanina uygula.",
    light: "Aydinlik",
    dark: "Karanlik",
    promotionsAndReferrals: "Promosyonlar ve Referanslar",
    securityCenter: "Guvenlik Merkezi",
    securityDesc: "Hesabini koru ve calisma alanini guvende tut.",
    securityScore: "Guvenlik skoru",
    recommended: "Onerilen",
    secured: "Guvende",
    activeSessions: "Aktif oturumlar",
    activeSessionsDesc: "Hesabina bagli cihazlari yonet.",
    deviceThisBrowser: "Bu tarayici - Istanbul",
    lastActiveNow: "Son aktiflik: simdi",
    twoFactorAuth: "Iki asamali dogrulama",
    twoFactorDesc: "Giris icin ekstra bir dogrulama adimi ekle.",
    loginAlerts: "Giris uyarilari",
    loginAlertsDesc: "Yeni bir cihaz giris yaptiginda bildirim al.",
    signOutOthers: "Diger oturumlari kapat",
    otherSessionsSignedOut: "Diger oturumlar kapatildi",
    viewPreviousInvoices: "Onceki faturalari burada goruntule.",
    hideInvoices: "Faturalari gizle",
    noPreviousInvoices: "Henuz onceki fatura yok",
    billingUsageDelay:
      "Guncellemeler 1 saate kadar surebilir ve en guncel kullanim verisini yansitmayabilir.",
    currentPlan: "Mevcut plan",
    paymentMethod: "Odeme yontemi",
    noPaymentMethod: "Kayitli odeme yontemi yok",
    changePlan: "Plani degistir",
    changePlanDesc: "Abonelik planini goruntule veya degistir",
    billingUpgrade: "Yukselt",
    promotionsHub: "Promosyon Merkezi",
    promotionsDesc: "Kampanyalar ve referans avantajlariyla projeni buyut.",
    referrals: "Referanslar",
    referralDesc:
      "Arkadaslarini Klawpen'a davet et. Ucretli plana gectiklerinde bonus kredi kazanirsin.",
    referralCode: "Referans kodu",
    rewardRule: "Ucretli referans basina bonus",
    successfulReferrals: "Basarili referanslar",
    pendingReferrals: "Bekleyen referanslar",
    totalRewards: "Toplam odul",
    pendingRewards: "Bekleyen odul",
    copyCode: "Kodu kopyala",
    copyLink: "Linki kopyala",
    bonusCta: "Bonus kredilerini almak icin Core'a yukselt",
    bonusClaimed: "Bonus alindi",
    referralIntro:
      "Referans linkini arkadaslarinla paylas. Kodunla abone olduklarinda odul ozetin otomatik guncellenir.",
    loadingReferralData: "Referans verileri yukleniyor...",
    updatesMayDelay:
      "Guncellemeler 1 saate kadar surebilir ve en yeni kullanim verisini yansitmayabilir.",
    viewAllUsage: "Tum kullanimi gor",
    hideUsageDetails: "Kullanim detaylarini gizle",
    totalUsage: "Toplam kullanim",
    agentUsers: "Agent kullanicilari",
    agentUsage: "Agent kullanimi",
    noAgentUsage: "Agent kullanimi yok",
    noAgentUsageDesc: "Bu fatura donemi icin agent kullanim verisi bulunmuyor.",
    username: "Kullanici adi",
    firstName: "Ad",
    lastName: "Soyad",
    bio: "Biyografi",
    addBio: "Bir biyografi ekle",
    saveChanges: "Degisiklikleri kaydet",
    viewPublicProfile: "Public profilimi goruntule",
    yourEmail: "E-posta adresin",
    yourPassword: "Sifren",
    edit: "Duzenle",
    locked: "Kilitli",
    publicProfilePreview: "Public profil onizlemesi",
    publicProfileOpened: "Public profili gizle",
    emailEdit: "E-postayi duzenle",
    emailSaved: "E-posta kaydedildi",
    passwordUpdated: "Sifre guncellendi",
    passwordUpdatedDesc: "Son degisiklik bu tarayicida kayitli.",
    comparePlans: "Planlari karsilastir",
    compareSubtitle: "Senin icin en uygun plani sec",
    monthly: "Aylik",
    yearly: "Yillik",
    yearlyDiscount: "Yillikta %20 indirim",
    starter: "Starter",
    corePlan: "Core",
    proPlan: "Pro",
    enterprise: "Enterprise",
    continueCore: "Core ile devam et",
    continuePro: "Pro ile devam et",
    contactSales: "Satis ekibi",
    pricingFootnote:
      "Yillik faturalamada aylik plan fiyatina %20 indirim uygulanir.",
    close: "Kapat",
    personal: "Personal",
    team: "Team",
    createWorkspace: "Calisma alani olustur",
    workspaceCardTitle: "Calisma alani detaylari",
    workspaceCardText:
      "Bir calisma alani modu sec. Personal solo hiz, Team ise is birligi icin optimize edilir.",
    workspaceOwner: "Calisma alani sahibi",
    preview: "Onizleme",
    code: "Kod",
    mobile: "Mobil",
    desktop: "Masaustu",
    switchToMobile: "Onizlemeyi mobile al",
    switchToDesktop: "Onizlemeyi masaustune al",
    openPreview: "Onizlemeyi ac",
    openPreviewProject: "Onizlemeyi yeni sekmede ac",
    previewLinkUnavailable: "Onizleme linki henuz hazir degil",
    export: "Disa aktar",
    deploy: "Yayinla",
    workspaceStatus: "Canli calisma alani",
    readyStatus: "Hazir",
    buildMode: "Build modu",
    meshFireStudio: "Klawpen Studio",
    currentProject: "Mevcut proje",
    projectName: "AI Banking App",
    recentProjects: "Son projeler",
    noOtherProjects: "Baska proje yok",
    switchProject: "Projeye gec",
    aiAssistance: "AI Asistani",
    meshFireAgent: "Klawpen Agent",
    chat: "Sohbet",
    dropFilesHere: "Dosyalari buraya birak",
    dropFilesDesc: "Gorseller, PDF'ler ve dokumanlar desteklenir",
    agentThinking: "Klawpen Agent dusunuyor",
    agentThinkingDesc: "Istegini okuyup siradaki degisikligi hazirliyor.",
    askFollowUp: "Kod hakkinda sor...",
    welcomeAssistantName: "Asistan",
    welcomeTitle: "Next.js projen hazir. Ben burada gelistirme, duzenleme ve yayinlama akisinda yardim etmek icin varim.",
    welcomeCanHelp: "Sana sunlarda yardim edebilirim:",
    welcomeFeatureOne: "Yeni ozellik ve komponent ekleme",
    welcomeFeatureTwo: "Mevcut kodu duzenleme",
    welcomeFeatureThree: "Paket ve dependency kurma",
    welcomeFeatureFour: "Debug ve sorun giderme",
    welcomeFeatureFive: "Performans optimizasyonu",
    welcomeClosing: "Ne degistirmek istedigini yaz, birlikte halledelim.",
    exportReady: "Export hazir",
    exportFailed: "Export basarisiz. Lutfen tekrar dene.",
    deploySoon: "Deploy yakinda geliyor",
    profileSaved: "Profil kaydedildi",
    copied: "Kopyalandi",
    copyFailed: "Kopyalama basarisiz",
    fileUnsupported: "desteklenen bir dosya turu degil",
    fileTooLarge: "cok buyuk (dosya basina maksimum 5MB)",
    totalSizeExceeded: "Toplam dosya boyutu 20MB limitini asiyor",
    processingFilesError: "Dosyalar işlenirken hata oluştu. Lütfen tekrar dene.",
    filesTooLarge: "Dosyalar çok büyük. Lütfen boyutları düşürüp tekrar dene.",
    connectionError: "Bağlantı hatası. Lütfen tekrar dene.",
    assistantError: "Üzgünüm, bir hata oluştu. Lütfen tekrar dene.",
    initialAssistantError:
      "Üzgünüm, isteğini işlerken bir hata oluştu. Lütfen tekrar dene.",
    exportProject: "Projeyi disa aktar",
    deployProject: "Projeyi yayinla",
    filesReady: "dosya gonderime hazir!",
    filesAddedPartial: "dosya eklendi",
    filesOf: "/",
    files: "Dosyalar",
    search: "Ara",
    components: "Komponentler",
    debug: "Debug",
    issues: "Issues",
    labs: "Labs",
    actions: "Aksiyonlar",
    upgrade: "Yukselt",
    explorer: "Explorer",
    explorerLayout: "Explorer gorunumu",
    searchFiles: "Dosyalarda ara...",
    searchMatches: "Eslesen calisma alani dosyalari",
    recentFiles: "Hizli acma onerileri",
    noSearchResults: "Eslesen dosya yok.",
    componentMap: "Tekrar kullanilabilir UI ve route yuzeyleri",
    componentFiles: "Komponent dosyalari",
    routeFiles: "Route dosyalari",
    routes: "Route'lar",
    component: "UI",
    route: "Route",
    noComponents: "Komponent dosyasi bulunamadi.",
    reviewItems: "Runtime, kayit ve dosya sagligi",
    unsavedFile: "Kaydedilmemis dosya",
    treeUnavailable: "Dosya agaci kullanilamiyor",
    treeUnavailableDesc: "Container dosyalari henuz yuklenemedi.",
    contentUnavailable: "Dosya icerigi kullanilamiyor",
    emptyWorkspace: "Dosya indekslenmedi",
    emptyWorkspaceDesc: "Dosya agaci su an bos.",
    noIssues: "Engelleyici sorun yok",
    noIssuesDesc: "Acik dosyalar, kayit durumu ve dosya agaci saglikli gorunuyor.",
    active: "Aktif",
    loadingFiles: "Dosyalar yukleniyor...",
    noFilesFound: "Dosya bulunamadi",
    openFileFromExplorer: "Explorer'dan bir dosya ac",
    workspaceFiles: "Calisma alani dosyalari",
    noFileSelected: "Dosya secilmedi",
    selectFileToEdit: "Duzenlemek icin soldan bir dosya sec",
    maximizeEditor: "Editoru buyut",
    moreEditorActions: "Daha fazla editor aksiyonu",
    closeFile: "Dosyayi kapat",
    unsavedChanges: "Kaydedilmemis degisiklikler",
    saveFile: "Dosyayi kaydet",
    noFileSelectedShort: "Dosya secili degil",
    save: "Kaydet",
    saving: "Kaydediliyor...",
    saved: "Kaydedildi",
    lineCountLabel: "satir",
    fileCountLabel: "dosya",
    folderCountLabel: "klasor",
    changeSummary: "Degisiklikler",
    changedIn: "icinde",
    created: "Olusturuldu",
    deleted: "Silindi",
    renamed: "Yeniden adlandi",
    moreFiles: "daha",
    dependencies: "Dependency'ler",
    attachedFiles: "Ekli dosyalar",
    total: "Toplam",
    removeFile: "Dosyayi kaldir",
    sendMessage: "Mesaj gonder",
    addImage: "Gorsel ekle",
    enhancePrompt: "Promptu iyilestir",
    enhancePromptShort: "Netlestir",
    enhancePromptTooltip:
      "Promptunu Klawpen Agent'in daha iyi anlayacagi sekle getirir",
    enhanceStepIntent: "Amac",
    enhanceStepDetails: "Detay",
    enhanceStepGuardrails: "Sinir",
    enhancePromptEmpty: "Once bir prompt yaz",
    enhancedPromptToast: "Prompt iyilestirildi",
    deepMode: "Deep Mode",
    deepModeOn: "Deep acik",
    selectAgent: "AI modelini sec",
    agentMenuFeatures: "Ozellikler",
    agentMenuModels: "Yapay zeka",
    featureDeepThinking: "Derin dusunme",
    featureDeepThinkingDesc: "Kodu degistirmeden once daha uzun dusunur",
    featureCoding: "Kodlama",
    featureCodingDesc: "Dosya degisikliklerine ve uygulamaya odaklanir",
    featurePolish: "Polish",
    featurePolishDesc: "Daha temiz UI ve urun detaylari",
    meshFireCoder: "Klawpen Coder",
    meshFireFast: "Klawpen Fast",
    agentBalancedDesc: "Dengeli gelistirme",
    agentCoderDesc: "Kod agirlikli degisiklikler",
    agentFastDesc: "Hizli duzenleme",
    modelOpusDesc: "Derin muhakeme",
    modelSonnetDesc: "Dengeli gelistirme",
    modelFastDesc: "Hizli duzenleme",
    dragDropFiles: "Dosyalari buraya surukle birak",
    fileLimitInfo: "Dosya basina maks 5MB, toplam 20MB",
    assistant: "Asistan",
    checkpointMade: "Checkpoint olusturuldu",
    justNow: "simdi",
    oneMinuteAgo: "1 dakika once",
    minutesAgo: "dakika once",
    oneHourAgo: "1 saat once",
    hoursAgo: "saat once",
    oneDayAgo: "1 gun once",
    daysAgo: "gun once",
    workedMoment: "Kisa bir an calisti",
    workedUnderMinute: "1 dakikadan az calisti",
    workedFor: "Calisma suresi",
    minute: "dakika",
    minutes: "dakika",
    hour: "saat",
    hours: "saat",
    min: "dk",
    doneDefault: "Tamam - istedigin degisiklikleri uyguladim.",
    updated: "Guncellendi",
    renameFile: "Dosyayi yeniden adlandir",
    deleteFile: "Dosyayi sil",
    addDependency: "Dependency ekle",
    preparedCodeChanges: "Kod degisikliklerini hazirladim.",
    thinkingProcess: "Dusunme sureci",
    error: "Hata",
    success: "Basarili",
    checkedConsole: "Console ciktisini kontrol ettim.",
    usedExamples: "Verilen ornekleri baglam olarak kullandim.",
    currentRoute: "Mevcut route",
    reviewedChanges: "Son degisiklikleri kontrol ettim.",
    instructions: "Talimatlar",
    loadingPreview: "Onizleme yukleniyor...",
    previewError: "Onizleme hatasi",
    containerNotFound: "Container bulunamadi",
    containerNotRunning: "Container calismiyor",
    startContainerPreview: "Canli onizleme icin container'i baslat",
    status: "Durum",
  };

  const settingsLabels =
    settingsLanguage === "tr" ? settingsLabelsTr : settingsLabelsEn;
  const codeEditorLabels = useMemo(
    () => ({
      settings: settingsLabels.settings,
      upgrade: settingsLabels.upgrade,
      files: settingsLabels.files,
      search: settingsLabels.search,
      components: settingsLabels.components,
      debug: settingsLabels.debug,
      issues: settingsLabels.issues,
      explorer: settingsLabels.explorer,
      explorerLayout: settingsLabels.explorerLayout,
      searchFiles: settingsLabels.searchFiles,
      searchMatches: settingsLabels.searchMatches,
      recentFiles: settingsLabels.recentFiles,
      noSearchResults: settingsLabels.noSearchResults,
      componentMap: settingsLabels.componentMap,
      componentFiles: settingsLabels.componentFiles,
      routeFiles: settingsLabels.routeFiles,
      routes: settingsLabels.routes,
      component: settingsLabels.component,
      route: settingsLabels.route,
      noComponents: settingsLabels.noComponents,
      reviewItems: settingsLabels.reviewItems,
      unsavedFile: settingsLabels.unsavedFile,
      treeUnavailable: settingsLabels.treeUnavailable,
      treeUnavailableDesc: settingsLabels.treeUnavailableDesc,
      contentUnavailable: settingsLabels.contentUnavailable,
      emptyWorkspace: settingsLabels.emptyWorkspace,
      emptyWorkspaceDesc: settingsLabels.emptyWorkspaceDesc,
      noIssues: settingsLabels.noIssues,
      noIssuesDesc: settingsLabels.noIssuesDesc,
      active: settingsLabels.active,
      loadingFiles: settingsLabels.loadingFiles,
      noFilesFound: settingsLabels.noFilesFound,
      openFileFromExplorer: settingsLabels.openFileFromExplorer,
      noFileSelected: settingsLabels.noFileSelected,
      selectFileToEdit: settingsLabels.selectFileToEdit,
      maximizeEditor: settingsLabels.maximizeEditor,
      moreEditorActions: settingsLabels.moreEditorActions,
      closeFile: settingsLabels.closeFile,
      unsavedChanges: settingsLabels.unsavedChanges,
      saveFile: settingsLabels.saveFile,
      noFileSelectedShort: settingsLabels.noFileSelectedShort,
      save: settingsLabels.save,
      saving: settingsLabels.saving,
      saved: settingsLabels.saved,
      lineCountLabel: settingsLabels.lineCountLabel,
      fileCountLabel: settingsLabels.fileCountLabel,
      error: settingsLabels.error,
    }),
    [settingsLanguage]
  );
  const previewLabels = useMemo(
    () => ({
      loadingPreview: settingsLabels.loadingPreview,
      previewError: settingsLabels.previewError,
      containerNotFound: settingsLabels.containerNotFound,
      containerNotRunning: settingsLabels.containerNotRunning,
      startContainerPreview: settingsLabels.startContainerPreview,
      status: settingsLabels.status,
    }),
    [settingsLanguage]
  );
  const workspaceUi = {
    root: isDark
      ? "bg-[#222223] text-slate-100"
      : "bg-[#f6f8fb] text-slate-900",
    backdrop: isDark
      ? "bg-[#222223]"
      : "bg-[radial-gradient(circle_at_18%_0%,rgba(147,197,253,0.16),transparent_34%),linear-gradient(180deg,#ffffff_0%,#f6f8fb_58%,#eef3f8_100%)]",
    bottomGlow: isDark
      ? "from-[#222223]/0 via-transparent to-transparent"
      : "from-[#dbeafe]/32 via-transparent to-transparent",
    topGlow: isDark ? "bg-[#222223]/0" : "bg-white/36",
    brandRail: isDark
      ? "from-[#7cc7ff]/34 via-[#31577d]/16 to-transparent"
      : "from-[#31577d]/28 via-[#7cc7ff]/18 to-transparent",
    shell: isDark
      ? "bg-[#222223] ring-1 ring-white/[0.045]"
      : "bg-white shadow-[0_12px_34px_rgba(15,23,42,0.06)] ring-1 ring-slate-900/[0.055]",
    header: isDark
      ? "border-[#333335] bg-[#222223]"
      : "border-[#e2e8f0] bg-white",
    homeButton: isDark
      ? "border-[#31577d]/28 bg-[#31577d]/12 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] hover:border-[#7cc7ff]/28 hover:bg-[#31577d]/18"
      : "border-[#31577d]/14 bg-[#f8fbff] text-slate-800 hover:border-[#31577d]/24 hover:bg-white",
    homeMark: isDark ? "bg-slate-100" : "bg-[#162033]",
    homeMarkDot: isDark ? "bg-[#111316]" : "bg-white",
    slash: isDark ? "text-slate-500" : "text-slate-300",
    studioButton: isDark
      ? "hover:border-[#3a3a3c] hover:bg-[#2a2a2b]/75"
      : "hover:border-[#d9e1eb] hover:bg-white/80",
    studioButtonActive: isDark
      ? "border-[#3a3a3c] bg-[#2a2a2b]/88"
      : "border-[#d9e1eb] bg-white",
    studioBadge: isDark
      ? "bg-[linear-gradient(135deg,#31577d,#4b7fad)] text-white"
      : "bg-[linear-gradient(135deg,#23435f,#31577d)] text-white",
    workspaceMenu: isDark
      ? "border-[#3a3a3c] bg-[#222223]/98 shadow-[0_18px_46px_rgba(0,0,0,0.36)]"
      : "border-[#d9e1eb] bg-white/98 shadow-[0_18px_42px_rgba(15,23,42,0.13)]",
    workspaceMenuItem: isDark
      ? "text-slate-300 hover:bg-white/[0.055] hover:text-slate-100"
      : "text-slate-600 hover:bg-slate-950/[0.04] hover:text-slate-900",
    workspaceMenuLocked: isDark
      ? "bg-white/[0.025] text-slate-500"
      : "bg-slate-950/[0.025] text-slate-400",
    statusPill: isDark
      ? "border-white/[0.055] bg-white/[0.025] text-slate-500"
      : "border-slate-200/75 bg-white text-slate-500",
    statusDot: isDark ? "bg-[#78d89b]" : "bg-[#16a34a]",
    title: isDark ? "text-slate-100" : "text-slate-800",
    muted: isDark ? "text-slate-500" : "text-slate-500",
    chevron: isDark
      ? "text-slate-500 group-hover:text-slate-300"
      : "text-slate-400 group-hover:text-slate-600",
    projectButton: isDark
      ? "border-[#3a3a3c] bg-[#262628] text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:border-[#4c5f72] hover:bg-[#2b2d30]"
      : "border-[#d9e1eb] bg-white text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.035)] hover:border-[#bfd0e2] hover:bg-[#f8fbff]",
    projectIcon: isDark
      ? "bg-[#31577d]/16 text-[#a9d2ff] ring-1 ring-[#31577d]/22"
      : "bg-[#31577d]/9 text-[#31577d] ring-1 ring-[#31577d]/12",
    projectMenu: isDark
      ? "border-[#3a3a3c] bg-[#222223]/98 shadow-[0_18px_50px_rgba(0,0,0,0.38)]"
      : "border-[#d9e1eb] bg-white/98 shadow-[0_18px_46px_rgba(15,23,42,0.14)]",
    projectMenuItem: isDark
      ? "text-slate-300 hover:bg-white/[0.055] hover:text-slate-100"
      : "text-slate-600 hover:bg-slate-950/[0.04] hover:text-slate-900",
    projectMenuMeta: isDark ? "text-slate-500" : "text-slate-400",
    segmented: isDark
      ? "border-[#3a3a3c] bg-[#222223]"
      : "border-[#d9e1eb] bg-[#eef3f8]",
    segmentActive: isDark
      ? "bg-[#dfefff] text-[#0d1723]"
      : "bg-white text-[#162033] shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
    segmentIdle: isDark
      ? "text-slate-400 hover:bg-[#2a2a2b] hover:text-slate-100"
      : "text-slate-500 hover:bg-white hover:text-slate-900",
    actionDock: isDark
      ? "border-[#333335] bg-[#222223]/82 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]"
      : "border-slate-200/80 bg-white/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)]",
    actionGroup: isDark
      ? "border-transparent bg-transparent"
      : "border-transparent bg-transparent",
    actionButton: isDark
      ? "text-slate-500 hover:bg-[#2a2a2b] hover:text-slate-100"
      : "text-slate-500 hover:bg-slate-950/[0.055] hover:text-slate-900",
    exportButton: isDark
      ? "border border-transparent bg-[#2b2b2d] text-slate-100 shadow-none hover:bg-[#333336] hover:text-white active:bg-[#252527]"
      : "border border-slate-200 bg-slate-100 text-slate-800 shadow-none hover:bg-slate-200/80 hover:text-slate-950 active:bg-slate-200",
    activeAction: isDark
      ? "bg-[#24364a] text-[#d7e8fb]"
      : "bg-[#edf6ff] text-[#254260]",
    deployButton: isDark
      ? "border border-[#1689ff] bg-[#1689ff] text-white shadow-none hover:border-[#2f99ff] hover:bg-[#2f99ff] active:bg-[#0f77dd]"
      : "border border-[#1689ff] bg-[#1689ff] text-white shadow-none hover:border-[#2f99ff] hover:bg-[#2f99ff] active:bg-[#0f77dd]",
    editorSurface: isDark
      ? "bg-[#222223]"
      : "bg-white",
    chatPanel: isDark
      ? "border-[#333335] bg-[#222223]"
      : "border-[#e2e8f0] bg-[#fbfdff]",
    chatHeader: isDark
      ? "border-[#333335] bg-[#222223]"
      : "border-[#e2e8f0] bg-[#fbfdff]/95",
    chatTopFade: isDark
      ? "from-[#222223] via-[#222223]/88 to-[#222223]/0"
      : "from-[#fbfdff] via-[#fbfdff]/88 to-[#fbfdff]/0",
    contentCard: isDark
      ? "border-[#3a3a3c] bg-[#222223]"
      : "border-[#dce3ec] bg-white shadow-[0_12px_34px_rgba(15,23,42,0.06)]",
    panelDivider: isDark ? "border-[#333335]" : "border-[#e2e8f0]",
    chatBadge: isDark
      ? "border-[#3a3a3c] bg-[#222223] text-slate-400"
      : "border-[#d9e1eb] bg-[#f8fafc] text-slate-500",
    thinkingCard: isDark
      ? "border-[#3a3a3c] bg-[#222223] text-slate-300"
      : "border-[#d9e1eb] bg-[#f8fafc] text-slate-600",
    overlay: isDark ? "bg-black/50" : "bg-slate-900/24",
    modal: isDark
      ? "border-[#3a3a3c] bg-[#222223]"
      : "border-[#dce3ec] bg-white shadow-[0_24px_70px_rgba(15,23,42,0.12)]",
    modalHeader: isDark ? "border-[#333335]" : "border-[#e2e8f0]",
    modalClose: isDark
      ? "text-slate-300 hover:bg-[#2a2a2b]"
      : "text-slate-500 hover:bg-slate-200/70",
    modalMain: isDark ? "bg-[#222223]" : "bg-[#f8fafc]",
  };
  const activePlanLabel =
    activePlan === "core"
      ? settingsLabels.corePlan
      : activePlan === "pro"
        ? settingsLabels.proPlan
        : activePlan === "enterprise"
          ? settingsLabels.enterprise
          : settingsLabels.starter;
  const pricingPlans = [
    {
      key: "core",
      name: settingsLabels.corePlan,
      desc:
        settingsLanguage === "tr"
          ? "Kisisel projeler ve hizli prototipler icin"
          : "For personal projects and quick prototypes",
      monthly: "$15",
      yearly: "$12",
      noteMonthly:
        settingsLanguage === "tr"
          ? "aylik faturalandirma"
          : "per month billed monthly",
      noteYearly:
        settingsLanguage === "tr"
          ? "aylik, yillik faturalandirma (%20 indirim)"
          : "per month billed annually (20% off)",
      cta: settingsLabels.continueCore,
      features:
        settingsLanguage === "tr"
          ? [
              "Aylik 200 Klawpen Core kredisi",
              "Gorsel referans yukleme",
              "Kisisel proje akislari",
            ]
          : [
              "200 Klawpen Core credits monthly",
              "Image reference uploads",
              "Personal project workflows",
            ],
      featured: true,
    },
    {
      key: "pro",
      name: settingsLabels.proPlan,
      desc:
        settingsLanguage === "tr"
          ? "Ticari ve profesyonel buildler icin"
          : "For commercial and professional builds",
      monthly: "$25",
      yearly: "$20",
      noteMonthly:
        settingsLanguage === "tr"
          ? "aylik faturalandirma"
          : "per month billed monthly",
      noteYearly:
        settingsLanguage === "tr"
          ? "aylik, yillik faturalandirma (%20 indirim)"
          : "per month billed annually (20% off)",
      cta: settingsLabels.continuePro,
      features:
        settingsLanguage === "tr"
          ? [
              "Aylik 600 Klawpen Core kredisi",
              "Klawpen Core otomatik model yonlendirme",
              "Oncelikli uretim akisi",
            ]
          : [
              "600 Klawpen Core credits monthly",
              "Klawpen Core automatic model routing",
              "Priority generation flow",
            ],
    },
    {
      key: "enterprise",
      name: settingsLabels.enterprise,
      desc:
        settingsLanguage === "tr"
          ? "Kurumsal seviye guvenlik ve kontroller icin"
          : "For enterprise-grade security and controls",
      monthly: "$115",
      yearly: "$92",
      noteMonthly:
        settingsLanguage === "tr"
          ? "aylik faturalandirma"
          : "per month billed monthly",
      noteYearly:
        settingsLanguage === "tr"
          ? "aylik, yillik faturalandirma (%20 indirim)"
          : "per month billed annually (20% off)",
      cta: settingsLabels.contactSales,
      features:
        settingsLanguage === "tr"
          ? [
              "Aylik 3.000 Klawpen Core kredisi",
              "En yuksek Core limitleri",
              "Ozel destek ve onboarding",
            ]
          : [
              "3,000 Klawpen Core credits monthly",
              "Highest Core limits",
              "Dedicated support and onboarding",
            ],
    },
  ];

  const referralSummary: ReferralSummary = {
    referralCode: "MESH2026",
    referralLink: "https://klawpen.com/auth/bridge?ref=MESH2026",
    successfulReferrals: 0,
    pendingReferrals: 0,
    totalRewardsUsd: 0,
    pendingRewardsUsd: 0,
    rewardPerConversionUsd: 10,
  };

  const loadProjectSwitcherProjects = useCallback(async () => {
    setProjectMetadata(readStoredProjectMetadata());
    setIsProjectMenuLoading(true);

    try {
      const containers = await getContainers();
      setProjectContainers(containers);
    } catch (error) {
      console.error("Failed to load project switcher projects:", error);
    } finally {
      setIsProjectMenuLoading(false);
    }
  }, []);

  const currentProjectContainer = useMemo(
    () => projectContainers.find((container) => container.id === containerId),
    [containerId, projectContainers]
  );

  const currentProjectTitle = useMemo(() => {
    if (currentProjectContainer) {
      return getProjectTitle(currentProjectContainer, projectMetadata);
    }

    const savedProject = projectMetadata[containerId];
    return (
      savedProject?.title ||
      (savedProject?.prompt ? buildTitleFromPrompt(savedProject.prompt) : "") ||
      settingsLabels.projectName
    );
  }, [
    containerId,
    currentProjectContainer,
    projectMetadata,
    settingsLabels.projectName,
  ]);

  const recentProjectOptions = useMemo(
    () =>
      projectContainers
        .filter((container) => container.id !== containerId)
        .sort(
          (first, second) =>
            getContainerCreatedTime(second) - getContainerCreatedTime(first)
        )
        .slice(0, 4)
        .map((container) => ({
          container,
          title: getProjectTitle(container, projectMetadata),
        })),
    [containerId, projectContainers, projectMetadata]
  );

  const handleSettingsThemeChange = (nextTheme: UiTheme) => {
    setSettingsTheme(nextTheme);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(UI_THEME_STORAGE_KEY, nextTheme);
    }
    if (typeof document !== "undefined") {
      document.documentElement.style.colorScheme = nextTheme;
    }
  };

  const handleSettingsLanguageChange = (nextLanguage: UiLanguage) => {
    setSettingsLanguage(nextLanguage);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, nextLanguage);
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = nextLanguage;
    }
  };

  const handleNotificationsChange = (enabled: boolean) => {
    setNotificationsEnabled(enabled);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        WORKSPACE_NOTIFICATIONS_STORAGE_KEY,
        String(enabled)
      );
    }
  };

  const handleTwoFactorChange = (enabled: boolean) => {
    setTwoFactorEnabled(enabled);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        WORKSPACE_TWO_FACTOR_STORAGE_KEY,
        String(enabled)
      );
    }
  };

  const handleLoginAlertsChange = (enabled: boolean) => {
    setLoginAlertsEnabled(enabled);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        WORKSPACE_LOGIN_ALERTS_STORAGE_KEY,
        String(enabled)
      );
    }
  };

  const handleResetPreferences = () => {
    const nextTheme = detectBrowserTheme();
    const nextLanguage = detectBrowserLanguage();

    setSettingsTheme(nextTheme);
    setSettingsLanguage(nextLanguage);
    setNotificationsEnabled(true);
    setTwoFactorEnabled(false);
    setLoginAlertsEnabled(true);

    if (typeof window !== "undefined") {
      [
        UI_THEME_STORAGE_KEY,
        UI_LANGUAGE_STORAGE_KEY,
        WORKSPACE_NOTIFICATIONS_STORAGE_KEY,
        WORKSPACE_TWO_FACTOR_STORAGE_KEY,
        WORKSPACE_LOGIN_ALERTS_STORAGE_KEY,
        ...SETTINGS_LOCAL_STORAGE_KEYS,
      ].forEach((key) => window.localStorage.removeItem(key));
    }

    if (typeof document !== "undefined") {
      document.documentElement.lang = nextLanguage;
      document.documentElement.style.colorScheme = nextTheme;
    }

    toast.success(settingsLabels.preferencesReset);
  };

  useEffect(() => {
    setSettingsTheme(resolveInitialTheme());
    setSettingsLanguage(resolveInitialLanguage());
    setNotificationsEnabled(
      resolveStoredBoolean(WORKSPACE_NOTIFICATIONS_STORAGE_KEY, true)
    );
    setTwoFactorEnabled(
      resolveStoredBoolean(WORKSPACE_TWO_FACTOR_STORAGE_KEY, false)
    );
    setLoginAlertsEnabled(
      resolveStoredBoolean(WORKSPACE_LOGIN_ALERTS_STORAGE_KEY, true)
    );
    setProjectMetadata(readStoredProjectMetadata());
  }, []);

  useEffect(() => {
    document.documentElement.lang = settingsLanguage;
    document.documentElement.style.colorScheme = settingsTheme;
  }, [settingsLanguage, settingsTheme]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isUiTheme(window.localStorage.getItem(UI_THEME_STORAGE_KEY))) return;

    const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mediaQuery) return;

    const handleSystemThemeChange = (event: MediaQueryListEvent) => {
      if (!isUiTheme(window.localStorage.getItem(UI_THEME_STORAGE_KEY))) {
        setSettingsTheme(event.matches ? "dark" : "light");
      }
    };

    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () =>
      mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const refreshWorkspaceAfterAiEdit = useCallback((message?: Message) => {
    if (message?.edits && message.edits.applied > 0) {
      setWorkspaceRefreshVersion((version) => version + 1);
      setViewMode("preview");
      loadProjectSwitcherProjects();
    }
  }, [loadProjectSwitcherProjects]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    loadProjectSwitcherProjects();
  }, [containerId, loadProjectSwitcherProjects]);

  useEffect(() => {
    if (!workspaceSwitcherOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!workspaceSwitcherRef.current?.contains(event.target as Node)) {
        setWorkspaceSwitcherOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWorkspaceSwitcherOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [workspaceSwitcherOpen]);

  useEffect(() => {
    if (!projectMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node)) {
        setProjectMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectMenuOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    const loadChatHistory = async () => {
      try {
        const response = await getChatHistory(containerId);
        if (response.success) {
          if (response.messages.length === 0 && !hasProcessedPrompt) {
            const urlParams = new URLSearchParams(window.location.search);
            const promptFromUrl = urlParams.get("prompt");

            if (promptFromUrl) {
              setHasProcessedPrompt(true);
              setIsLoading(true);

              try {
                const response = await sendChatMessage(
                  containerId,
                  promptFromUrl,
                  undefined
                );
                if (response.success) {
                  setMessages([
                    response.userMessage,
                    response.assistantMessage,
                  ]);
                  refreshWorkspaceAfterAiEdit(response.assistantMessage);
                }
              } catch (error) {
                console.error("Failed to send initial prompt:", error);
                const errorText =
                  error instanceof Error && error.message
                    ? error.message
                    : settingsLabels.initialAssistantError;
                const errorMessage: Message = {
                  id: `error-${Date.now()}`,
                  role: "assistant",
                  content: errorText,
                  timestamp: new Date().toISOString(),
                };
                setMessages([errorMessage]);
              } finally {
                setIsLoading(false);
              }

              window.history.replaceState(
                {},
                document.title,
                window.location.pathname
              );
            }
          } else {
            setMessages(response.messages);
          }
        }
      } catch (error) {
        console.error("Failed to load chat history:", error);
      }
    };

    if (containerId) {
      loadChatHistory();
    }
  }, [containerId]);

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(",")[1]);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  const validateFiles = (files: File[], existingFiles: File[] = []): File[] => {
    const maxFileSize = 5 * 1024 * 1024;
    const maxTotalSize = 20 * 1024 * 1024;

    const existingTotalSize = existingFiles.reduce(
      (sum, file) => sum + file.size,
      0
    );
    let newTotalSize = existingTotalSize;
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
        toast.error(`${file.name} ${settingsLabels.fileUnsupported}`);
        continue;
      }

      if (file.size > maxFileSize) {
        toast.error(`${file.name} ${settingsLabels.fileTooLarge}`);
        continue;
      }

      if (newTotalSize + file.size > maxTotalSize) {
        toast.error(
          `Cannot add ${file.name}: would exceed total size limit (max 20MB)`
        );
        continue;
      }

      newTotalSize += file.size;
      validFiles.push(file);
    }

    return validFiles;
  };

  const handleSendMessage = async (attachments?: File[]): Promise<void> => {
    const allAttachments = [...(attachments || []), ...pendingFiles];

    if (!inputValue.trim() && allAttachments.length === 0) return;
    if (isLoading) return;

    const totalSize = allAttachments.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > 20 * 1024 * 1024) {
      toast.error(settingsLabels.totalSizeExceeded);
      return;
    }

    const userInput = inputValue;
    setInputValue("");
    setPendingFiles([]);
    setIsLoading(true);

    streamCancelRef.current?.();

    let attachmentData: any[] = [];
    if (allAttachments.length > 0) {
      try {
        attachmentData = await Promise.all(
          allAttachments.map(async (file) => {
            const base64 = await fileToBase64(file);
            return {
              type: file.type.startsWith("image/") ? "image" : "document",
              data: base64,
              name: file.name,
              mimeType: file.type,
              size: file.size,
            };
          })
        );
      } catch (error) {
        console.error("Error processing files:", error);
        toast.error(settingsLabels.processingFilesError);
        setIsLoading(false);
        return;
      }
    }

    const cancel = sendChatMessageStream(
      containerId,
      userInput,
      attachmentData,
      (data) => {
        if (data.type === "user") {
          setMessages((prev) => [...prev, data.data]);
        } else if (data.type === "assistant") {
          setStreamingMessageId(data.data.id);
          setMessages((prev) => {
            const newMessages = [...prev];
            const existingIndex = newMessages.findIndex(
              (msg) => msg.id === data.data.id
            );

            if (existingIndex >= 0) {
              newMessages[existingIndex] = data.data;
            } else {
              newMessages.push(data.data);
            }

            return newMessages;
          });
        } else if (data.type === "done") {
          setStreamingMessageId(null);
          refreshWorkspaceAfterAiEdit(data.data);
        }
      },
      (error) => {
        console.error("Streaming error:", error);
        setIsLoading(false);
        setStreamingMessageId(null);

        if (error.includes("413") || error.includes("Payload Too Large")) {
          toast.error(
            settingsLabels.filesTooLarge
          );
        } else {
          toast.error(error || settingsLabels.connectionError);
        }

        const errorMessage: Message = {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: error || settingsLabels.assistantError,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      },
      () => {
        setIsLoading(false);
        setStreamingMessageId(null);
      }
    );

    streamCancelRef.current = cancel;
  };

  const handleTextareaKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>
  ): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragOver) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const rect = sidebarRef.current?.getBoundingClientRect();
    if (rect) {
      const { clientX, clientY } = e;
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        setIsDragOver(false);
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    const validFiles = validateFiles(droppedFiles, pendingFiles);

    if (validFiles.length > 0) {
      setPendingFiles((prev) => [...prev, ...validFiles]);
      if (validFiles.length === droppedFiles.length) {
        toast.success(`${validFiles.length} ${settingsLabels.filesReady}`);
      } else {
        toast.success(
          `${validFiles.length} ${settingsLabels.filesOf} ${droppedFiles.length} ${settingsLabels.filesAddedPartial}`
        );
      }
    }
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handlePreviewDeviceToggle = () => {
    setViewMode("preview");
    setIsDesktopView((current) => !current);
  };

  const handleOpenPreviewExternal = async () => {
    setViewMode("preview");

    const getStoredPreviewUrl = () => {
      if (typeof window === "undefined") return "";

      try {
        const storedPreview = window.localStorage.getItem(
          `december:preview-container:${containerId}`
        );
        const parsedPreview = storedPreview
          ? (JSON.parse(storedPreview) as Container)
          : null;

        return parsedPreview?.url || "";
      } catch {
        return "";
      }
    };

    let previewUrl = currentProjectContainer?.url || getStoredPreviewUrl();

    if (!previewUrl) {
      try {
        const containers = await getContainers();
        setProjectContainers(containers);
        previewUrl =
          containers.find((container) => container.id === containerId)?.url ||
          "";
      } catch (error) {
        console.error("Failed to resolve preview URL:", error);
      }
    }

    if (!previewUrl) {
      toast.error(settingsLabels.previewLinkUnavailable);
      return;
    }

    window.open(previewUrl, "_blank", "noopener,noreferrer");
  };

  const handleExportCode = async () => {
    if (isExporting) return;

    setIsExporting(true);
    try {
      const response = await fetch(`${API_BASE_URL}/containers/${containerId}/export`, {
        headers: await getBackendAuthHeaders(),
      });

      const blob = response.ok
        ? await response.blob()
        : await buildProjectZipFromFileApi(API_BASE_URL, containerId);
      const contentDisposition = response.headers.get("Content-Disposition");
      const filenameMatch = contentDisposition?.match(/filename="?([^"]+)"?/i);
      const filename =
        filenameMatch?.[1] || `klawpen-project-${containerId.slice(0, 8)}.zip`;

      if (blob.size === 0) {
        throw new Error("Export returned an empty archive");
      }

      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
      toast.success(settingsLabels.exportReady);
    } catch (error) {
      console.error("Export error:", error);
      toast.error(settingsLabels.exportFailed);
    } finally {
      setIsExporting(false);
    }
  };

  const handleDeploy = () => {
    toast(settingsLabels.deploySoon, {
      icon: "->",
      duration: 1400,
    });
  };

  const openSettingsPanel = useCallback((section: SettingsPanelSection = "profile") => {
    const safeSection =
      section === "accountUsage" && !hasPaidPlan ? "billing" : section;

    if (settingsPanelCloseTimeoutRef.current) {
      clearTimeout(settingsPanelCloseTimeoutRef.current);
    }
    if (settingsContentSwapTimeoutRef.current) {
      clearTimeout(settingsContentSwapTimeoutRef.current);
    }

    setSettingsPanelSection(safeSection);
    setDisplayedSettingsPanelSection(safeSection);
    setSettingsContentVisible(true);
    setSettingsPanelOpen(true);
    setTimeout(() => setSettingsPanelVisible(true), 10);
  }, [hasPaidPlan]);

  const openProfileSettingsPanel = useCallback(() => {
    openSettingsPanel("profile");
  }, [openSettingsPanel]);

  const openSubscriptionsPanel = useCallback(() => {
    setPricingModalOpen(true);
  }, []);

  const closeSettingsPanel = () => {
    setSettingsPanelVisible(false);
    if (settingsPanelCloseTimeoutRef.current) {
      clearTimeout(settingsPanelCloseTimeoutRef.current);
    }
    settingsPanelCloseTimeoutRef.current = setTimeout(() => {
      setSettingsPanelOpen(false);
    }, 180);
  };

  const switchSettingsPanelSection = (section: SettingsPanelSection) => {
    if (section === "accountUsage" && !hasPaidPlan) return;
    if (section === settingsPanelSection) return;

    setSettingsPanelSection(section);
    setSettingsContentVisible(false);
    if (settingsContentSwapTimeoutRef.current) {
      clearTimeout(settingsContentSwapTimeoutRef.current);
    }
    settingsContentSwapTimeoutRef.current = setTimeout(() => {
      setDisplayedSettingsPanelSection(section);
      setSettingsContentVisible(true);
    }, 130);
  };

  const handleSelectPlan = (planKey: string) => {
    if (!isAccountPlan(planKey)) return;
    setActivePlan(planKey);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ACCOUNT_PLAN_STORAGE_KEY, planKey);
    }
    setPricingModalOpen(false);
    openSettingsPanel("accountUsage");
  };

  const saveProfileToStorage = () => {
    if (typeof window === "undefined") return;

    window.localStorage.setItem(
      `${workspaceProfileStoragePrefix}:firstName`,
      profileFirstName
    );
    window.localStorage.setItem(
      `${workspaceProfileStoragePrefix}:lastName`,
      profileLastName
    );
    window.localStorage.setItem(
      `${workspaceProfileStoragePrefix}:bio`,
      profileBio
    );
    toast.success(settingsLabels.profileSaved);
  };

  const handleAvatarUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      setProfileAvatarDataUrl(result);
      if (result && typeof window !== "undefined") {
        window.localStorage.setItem(
          `${workspaceProfileStoragePrefix}:avatar`,
          result
        );
      }
    };
    reader.readAsDataURL(file);
  };

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(settingsLabels.copied);
    } catch {
      toast.error(settingsLabels.copyFailed);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    const storedPlan = window.localStorage.getItem(ACCOUNT_PLAN_STORAGE_KEY);
    if (isAccountPlan(storedPlan)) {
      setActivePlan(storedPlan);
    }

    setProfileAvatarDataUrl(
      window.localStorage.getItem(`${workspaceProfileStoragePrefix}:avatar`) ||
        null
    );
    setProfileFirstName(
      window.localStorage.getItem(
        `${workspaceProfileStoragePrefix}:firstName`
      ) || "kaichen"
    );
    setProfileLastName(
      window.localStorage.getItem(`${workspaceProfileStoragePrefix}:lastName`) ||
        "Yilmaz"
    );
    setProfileBio(
      window.localStorage.getItem(`${workspaceProfileStoragePrefix}:bio`) || ""
    );
  }, []);

  useEffect(() => {
    let isMounted = true;
    const supabase = createSupabaseClient();

    const syncAccount = async () => {
      const snapshot = await fetchAccountSnapshot();
      if (!isMounted) return;

      setAccountSnapshot(snapshot);
      if (snapshot.profile.isAuthenticated) {
        setActivePlan(snapshot.entitlements.plan);
        if (snapshot.profile.avatarUrl) {
          setProfileAvatarDataUrl(snapshot.profile.avatarUrl);
        }
        if (typeof window !== "undefined" && snapshot.profile.email) {
          window.localStorage.setItem(SETTINGS_PROFILE_EMAIL_STORAGE_KEY, snapshot.profile.email);
        }

        const parts = snapshot.profile.displayName.split(/\s+/).filter(Boolean);
        if (parts.length > 0) {
          setProfileFirstName(parts[0]);
          setProfileLastName(parts.slice(1).join(" "));
        }
      }
    };

    syncAccount();

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

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pricingModalOpen) setPricingModalOpen(false);
      if (settingsPanelOpen) closeSettingsPanel();
    };

    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
      if (settingsPanelCloseTimeoutRef.current) {
        clearTimeout(settingsPanelCloseTimeoutRef.current);
      }
      if (settingsContentSwapTimeoutRef.current) {
        clearTimeout(settingsContentSwapTimeoutRef.current);
      }
    };
  }, [pricingModalOpen, settingsPanelOpen]);

  const formatMessageContent = (content: string): React.ReactNode[] => {
    return content.split("\n").map((line: string, index: number) => {
      if (line.startsWith("## ")) {
        return (
          <h3 key={index} className="text-lg font-semibold mt-4 mb-2">
            {line.substring(3)}
          </h3>
        );
      }
      if (line.startsWith("### ")) {
        return (
          <h4 key={index} className="text-base font-semibold mt-3 mb-1">
            {line.substring(4)}
          </h4>
        );
      }
      if (line.startsWith("# ")) {
        return (
          <h2 key={index} className="text-xl font-semibold mt-4 mb-2">
            {line.substring(2)}
          </h2>
        );
      }
      if (line.startsWith("- ")) {
        return (
          <li key={index} className="ml-4 list-disc">
            {line.substring(2)}
          </li>
        );
      }
      if (line.match(/^\d+\./)) {
        const match = line.match(/^(\d+\.)\s*(.*)$/);
        return (
          <li key={index} className="ml-4 list-decimal">
            {match ? match[2] : line}
          </li>
        );
      }
      if (line.includes("**") && line.includes("**")) {
        const parts = line.split("**");
        return (
          <p key={index} className="mb-2">
            {parts.map((part: string, i: number) =>
              i % 2 === 1 ? <strong key={i}>{part}</strong> : part
            )}
          </p>
        );
      }
      if (line.includes("`") && line.includes("`")) {
        const parts = line.split("`");
        return (
          <p key={index} className="mb-2">
            {parts.map((part: string, i: number) =>
              i % 2 === 1 ? (
                <code
                  key={i}
                  className={`${isDark ? "bg-slate-800 text-slate-200 border-white/10" : "bg-slate-100 text-slate-700 border-slate-200"} px-1 py-0.5 rounded text-sm font-mono border`}
                >
                  {part}
                </code>
              ) : (
                part
              )
            )}
          </p>
        );
      }
      return line ? (
        <p key={index} className="mb-2">
          {line}
        </p>
      ) : (
        <br key={index} />
      );
    });
  };

  const WelcomeMessage = () => (
    <div className="mb-3 flex flex-col items-start">
      <div className="mb-1.5 flex items-center gap-1.5">
        <img
          className="h-3.5 w-3.5 rounded"
          src="/brand-logo-mark.png"
          alt="Assistant Avatar"
        />
        <span className={`text-[13px] font-medium ${isDark ? "text-white/90" : "text-slate-800"}`}>
          {settingsLabels.welcomeAssistantName}
        </span>
      </div>
      <div
        className={`rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed ${
          isDark
            ? "border-[#3a3a3c] bg-[#222223] text-slate-100"
            : "border-[#dce3ec] bg-white text-slate-700 shadow-[0_4px_12px_rgba(15,23,42,0.035)]"
        }`}
      >
        <div>
          <div
            className={`prose prose-sm max-w-none [&_p]:mb-1.5 [&_ul]:mb-1.5 [&_li]:my-0 ${
              isDark
                ? "prose-invert [&_h2]:text-white [&_h3]:text-white [&_h4]:text-white [&_strong]:text-white"
                : "prose-slate [&_h2]:text-slate-950 [&_h3]:text-slate-950 [&_h4]:text-slate-950 [&_strong]:text-slate-950"
            }`}
          >
            <p className="mb-2">
              {settingsLabels.welcomeTitle}
            </p>
            <p className="mb-2">{settingsLabels.welcomeCanHelp}</p>
            <ul className="list-disc ml-4 mb-2">
              <li>{settingsLabels.welcomeFeatureOne}</li>
              <li>{settingsLabels.welcomeFeatureTwo}</li>
              <li>{settingsLabels.welcomeFeatureThree}</li>
              <li>{settingsLabels.welcomeFeatureFour}</li>
              <li>{settingsLabels.welcomeFeatureFive}</li>
            </ul>
            <p className="mb-0">
              {settingsLabels.welcomeClosing}
            </p>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div
      data-ui-theme={settingsTheme}
      className={`relative flex h-[100dvh] overflow-hidden ${workspaceUi.root}`}
    >
      <div className={`absolute inset-0 ${workspaceUi.backdrop}`} />
      <div className={`absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t ${workspaceUi.bottomGlow}`} />
      <div className={`absolute left-1/2 top-0 h-24 w-[28rem] -translate-x-1/2 rounded-full blur-2xl ${workspaceUi.topGlow}`} />

      <div className="relative z-10 flex h-full w-full p-1 sm:p-1.5">
        <div className={`workspace-soft-shell flex h-full w-full overflow-hidden rounded-xl ${workspaceUi.shell}`}>
          <span className={`pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r ${workspaceUi.brandRail}`} />
          <div className="flex min-w-0 flex-1 flex-col">
            <header className={`relative flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-1.5 border-b px-2 py-1 sm:px-2.5 md:flex-nowrap md:py-0 ${workspaceUi.header}`}>
              <div className="flex min-w-0 items-center gap-1.5">
                <Link
                  href="/"
                  className={`group flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition ${workspaceUi.homeButton}`}
                  aria-label="Klawpen home"
                >
                  <span className={`relative flex h-3 w-3 rotate-45 items-center justify-center rounded-[3px] ${workspaceUi.homeMark}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${workspaceUi.homeMarkDot}`} />
                  </span>
                </Link>

                <span className={workspaceUi.slash}>/</span>

                <div className="relative" ref={workspaceSwitcherRef}>
                  <button
                    type="button"
                    onClick={() => {
                      setProjectMenuOpen(false);
                      setWorkspaceSwitcherOpen((open) => !open);
                    }}
                    className={`group flex min-w-0 items-center gap-1.5 rounded-md border px-1 py-0.5 transition ${
                      workspaceSwitcherOpen
                        ? workspaceUi.studioButtonActive
                        : `border-transparent ${workspaceUi.studioButton}`
                    }`}
                    title={profileStudioName}
                    aria-haspopup="menu"
                    aria-expanded={workspaceSwitcherOpen}
                  >
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded ${workspaceUi.studioBadge}`}>
                      {profileAvatarDataUrl ? (
                        <img
                          src={profileAvatarDataUrl}
                          alt={`${profileDisplayName} avatar`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="text-[10px] font-black leading-none text-white">
                          {workspaceInitials}
                        </span>
                      )}
                    </span>
                    <span className="hidden min-w-0 flex-col items-start leading-none sm:flex">
                      <span className={`max-w-[118px] truncate text-[12px] font-semibold ${workspaceUi.title}`}>
                        {profileStudioName}
                      </span>
                      <span className={`mt-0.5 max-w-[118px] truncate text-[10px] ${workspaceUi.muted}`}>
                        {profileEmail}
                      </span>
                    </span>
                    <ChevronsUpDown
                      className={`hidden h-3.5 w-3.5 shrink-0 transition sm:block ${
                        workspaceSwitcherOpen ? "rotate-180" : ""
                      } ${workspaceUi.chevron}`}
                    />
                  </button>

                  {workspaceSwitcherOpen && (
                    <div
                      className={`workspace-popover-in absolute left-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border p-1.5 backdrop-blur-xl ${workspaceUi.workspaceMenu}`}
                      role="menu"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setWorkspaceSwitcherOpen(false);
                          openProfileSettingsPanel();
                        }}
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition ${workspaceUi.workspaceMenuItem}`}
                        role="menuitem"
                      >
                        <span className={`flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg ${workspaceUi.studioBadge}`}>
                          {profileAvatarDataUrl ? (
                            <img
                              src={profileAvatarDataUrl}
                              alt={`${profileDisplayName} avatar`}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span className="text-[11px] font-black leading-none text-white">
                              {workspaceInitials}
                            </span>
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-[12px] font-semibold ${workspaceUi.title}`}>
                            {profileStudioName}
                          </span>
                          <span className={`mt-0.5 block truncate text-[10px] ${workspaceUi.muted}`}>
                            {profileEmail}
                          </span>
                        </span>
                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${workspaceUi.chatBadge}`}>
                          {settingsLabels.personal}
                        </span>
                      </button>

                      <div className={`mt-1 flex items-center gap-2 rounded-lg px-2 py-2 ${workspaceUi.workspaceMenuLocked}`}>
                        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                          isDark ? "bg-white/[0.04]" : "bg-slate-950/[0.04]"
                        }`}>
                          <Users className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-medium">
                            {settingsLabels.team} workspace
                          </span>
                          <span className="mt-0.5 block truncate text-[10px] opacity-80">
                            {settingsLabels.locked}
                          </span>
                        </span>
                        <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                          isDark ? "bg-white/[0.045] text-slate-500" : "bg-slate-950/[0.045] text-slate-400"
                        }`}>
                          <Lock className="h-3 w-3" />
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <span className={`hidden select-none text-[13px] sm:inline ${workspaceUi.slash}`}>/</span>

                <div className="relative hidden sm:block" ref={projectMenuRef}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!projectMenuOpen) {
                        loadProjectSwitcherProjects();
                      }
                      setProjectMenuOpen((open) => !open);
                    }}
                    className={`workspace-soft-control flex h-7 min-w-0 items-center gap-1.5 rounded-lg border px-2 text-[12px] font-semibold tracking-[-0.01em] transition ${workspaceUi.projectButton}`}
                    title={settingsLabels.currentProject}
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpen}
                  >
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${workspaceUi.projectIcon}`}>
                      <GitBranch className="h-3 w-3" />
                    </span>
                    <span className="max-w-[136px] truncate">
                      {currentProjectTitle}
                    </span>
                    <ChevronDown
                      className={`h-3 w-3 shrink-0 text-slate-500 transition-transform duration-150 ${
                        projectMenuOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>

                  {projectMenuOpen && (
                    <div
                      className={`absolute left-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border p-1.5 backdrop-blur-xl ${workspaceUi.projectMenu}`}
                      role="menu"
                    >
                      <div className={`px-2 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-[0.16em] ${workspaceUi.projectMenuMeta}`}>
                        {settingsLabels.recentProjects}
                      </div>

                      {isProjectMenuLoading && recentProjectOptions.length === 0 ? (
                        <div className="space-y-1 px-1 pb-1">
                          {[0, 1, 2].map((item) => (
                            <div
                              key={item}
                              className={`h-8 rounded-lg ${
                                isDark ? "bg-white/[0.04]" : "bg-slate-950/[0.04]"
                              }`}
                            />
                          ))}
                        </div>
                      ) : recentProjectOptions.length === 0 ? (
                        <div className={`px-2 py-2 text-[11px] ${workspaceUi.projectMenuMeta}`}>
                          {settingsLabels.noOtherProjects}
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {recentProjectOptions.map(({ container, title }) => (
                            <Link
                              key={container.id}
                              href={`/projects/${container.id}`}
                              onClick={() => setProjectMenuOpen(false)}
                              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] transition ${workspaceUi.projectMenuItem}`}
                              role="menuitem"
                              title={settingsLabels.switchProject}
                            >
                              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                                isDark ? "bg-[#31577d]/18 text-[#bfe1ff]" : "bg-[#31577d]/10 text-[#31577d]"
                              }`}>
                                <GitBranch className="h-3 w-3" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">
                                  {title}
                                </span>
                                <span className={`block truncate text-[9px] ${workspaceUi.projectMenuMeta}`}>
                                  {container.status || settingsLabels.switchProject}
                                </span>
                              </span>
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

              </div>

              <div className="order-3 flex w-full justify-center md:absolute md:left-1/2 md:top-1/2 md:order-none md:block md:w-auto md:-translate-x-1/2 md:-translate-y-1/2">
                <div className={`workspace-soft-control flex items-center gap-0.5 rounded-md border p-[2px] ${workspaceUi.segmented}`}>
                  {[
                    { key: "preview", label: settingsLabels.preview },
                    { key: "editor", label: settingsLabels.code },
                  ].map((item) => {
                    const active = viewMode === item.key;

                    return (
                      <button
                        key={item.key}
                        onClick={() =>
                          setViewMode(item.key as "preview" | "editor")
                        }
                        className={
                          "rounded-[5px] px-2 py-0.5 text-[10px] font-medium transition-all " +
                          (active
                            ? workspaceUi.segmentActive
                            : workspaceUi.segmentIdle)
                        }
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="ml-auto flex h-7 items-center justify-end gap-1.5">
                <div className={`flex h-7 items-center justify-end gap-0.5 rounded-md border px-1 ${workspaceUi.actionDock}`}>
                  <button
                    type="button"
                    onClick={handleOpenPreviewExternal}
                    className={`motion-icon-interactive flex h-[22px] w-[22px] items-center justify-center rounded-[5px] transition-all ${workspaceUi.actionButton}`}
                    title={settingsLabels.openPreviewProject}
                    aria-label={settingsLabels.openPreviewProject}
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>

                  <button
                    type="button"
                    onClick={handlePreviewDeviceToggle}
                    className={
                      "motion-icon-interactive flex h-[22px] w-[22px] items-center justify-center rounded-[5px] transition-all " +
                      (!isDesktopView && viewMode === "preview"
                        ? workspaceUi.activeAction
                        : workspaceUi.actionButton)
                    }
                    title={isDesktopView ? settingsLabels.switchToMobile : settingsLabels.switchToDesktop}
                    aria-label={isDesktopView ? settingsLabels.switchToMobile : settingsLabels.switchToDesktop}
                  >
                    <Smartphone className="h-3 w-3" />
                  </button>
                </div>

                <div className={`flex h-7 items-center justify-end gap-1 rounded-md border ${workspaceUi.actionGroup}`}>
                  <button
                    type="button"
                    onClick={handleExportCode}
                    disabled={isExporting}
                    className={`motion-icon-interactive flex h-7 items-center gap-1 rounded-md px-2 text-[10px] font-medium tracking-[-0.01em] transition-all disabled:cursor-not-allowed disabled:opacity-50 sm:gap-1.5 sm:px-2.5 sm:text-[11px] ${workspaceUi.exportButton}`}
                    title={settingsLabels.exportProject}
                    aria-label={settingsLabels.exportProject}
                  >
                    {isExporting ? (
                      <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current/25 border-t-current" />
                    ) : (
                      <Download className="h-3 w-3" />
                    )}
                    <span>{settingsLabels.export}</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleDeploy}
                    className={`motion-icon-interactive flex h-7 items-center gap-1 rounded-md px-2 text-[10px] font-medium tracking-[-0.01em] transition-all sm:gap-1.5 sm:px-2.5 sm:text-[11px] ${workspaceUi.deployButton}`}
                    title={settingsLabels.deployProject}
                    aria-label={settingsLabels.deployProject}
                  >
                    <Rocket className="h-3 w-3" />
                    <span>{settingsLabels.deploy}</span>
                  </button>
                </div>
              </div>
            </header>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
              <section className={`relative min-h-0 min-w-0 flex-[0_0_46%] overflow-hidden lg:flex-1 ${workspaceUi.editorSurface}`}>
                <div className="relative h-full min-h-0 w-full overflow-hidden">
                  <div
                    aria-hidden={viewMode !== "editor"}
                    className={`absolute inset-0 h-full min-h-0 w-full transition-opacity duration-150 ${
                      viewMode === "editor"
                        ? "z-10 pointer-events-auto opacity-100"
                        : "z-0 pointer-events-none opacity-0"
                    }`}
                  >
                    <CodeEditor
                      containerId={containerId}
                      workspaceTheme={isDark ? "dark" : "light"}
                      isVisible={viewMode === "editor"}
                      refreshVersion={workspaceRefreshVersion}
                      labels={codeEditorLabels}
                      onOpenSettings={openProfileSettingsPanel}
                      onOpenSubscriptions={openSubscriptionsPanel}
                    />
                  </div>
                  <div
                    aria-hidden={viewMode !== "preview"}
                    className={`absolute inset-0 h-full min-h-0 w-full transition-opacity duration-150 ${
                      viewMode === "preview"
                        ? "z-10 pointer-events-auto opacity-100"
                        : "z-0 pointer-events-none opacity-0"
                    }`}
                  >
                    <LivePreview
                      containerId={containerId}
                      isDesktopView={isDesktopView}
                      isDark={isDark}
                      refreshVersion={workspaceRefreshVersion}
                      labels={previewLabels}
                    />
                  </div>
                </div>
              </section>

              <aside
                ref={sidebarRef}
                className={`relative flex min-h-0 w-full flex-1 shrink-0 flex-col overflow-hidden border-t lg:w-[392px] lg:flex-none lg:border-l lg:border-t-0 2xl:w-[408px] ${workspaceUi.chatPanel}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                {isDragOver && (
                  <div className="absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-[#7ec0ff]/35 bg-[#31577d]/10 backdrop-blur-sm">
                    <div className="text-center">
                      <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-[#31577d]/16">
                        <Upload className="h-4 w-4 text-[#c8e2ff]" />
                      </div>
                      <div className={`text-[13px] font-semibold ${workspaceUi.title}`}>{settingsLabels.dropFilesHere}</div>
                      <div className={`mt-1 text-[11px] ${workspaceUi.muted}`}>
                        {settingsLabels.dropFilesDesc}
                      </div>
                    </div>
                  </div>
                )}

                <div className={`flex h-10 shrink-0 items-center justify-between border-b px-3.5 ${workspaceUi.chatHeader}`}>
                  <div>
                    <h2 className={`text-[11.5px] font-semibold tracking-[-0.01em] ${workspaceUi.title}`}>
                      {settingsLabels.meshFireAgent}
                    </h2>
                    <p className={`mt-px text-[9px] ${workspaceUi.muted}`}>{settingsLabels.buildMode}</p>
                  </div>
                  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] ${workspaceUi.statusPill}`}>
                    <span className="workspace-live-dot relative flex h-1.5 w-1.5">
                      <span className={`absolute inline-flex h-full w-full rounded-full opacity-70 ${workspaceUi.statusDot}`} />
                      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${workspaceUi.statusDot}`} />
                    </span>
                    {settingsLabels.readyStatus}
                  </span>
                </div>

                <div className="relative min-h-0 flex-1">
                  <div
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-x-0 top-0 z-20 h-14 bg-gradient-to-b ${workspaceUi.chatTopFade}`}
                  >
                    <div className="h-full backdrop-blur-[1.5px] [mask-image:linear-gradient(to_bottom,black_0%,black_42%,transparent_100%)]" />
                  </div>
                  <div className="custom-scrollbar h-full min-h-0 overscroll-contain overflow-y-auto scroll-smooth px-3 pb-3 pt-3 sm:px-4 sm:pb-4">
                    <div className="space-y-4">
                      {messages.length === 0 && <WelcomeMessage />}

                      {messages.map((message, index) => {
                        const previousUserMessage =
                          message.role === "assistant"
                            ? [...messages]
                                .slice(0, index)
                                .reverse()
                                .find((item) => item.role === "user")
                            : undefined;

                        return (
                          <ChatMessage
                            key={message.id}
                            message={message}
                            formatMessageContent={formatMessageContent}
                            containerId={containerId}
                            isStreaming={streamingMessageId === message.id}
                            isDark={isDark}
                            labels={settingsLabels}
                            workStartedAt={previousUserMessage?.timestamp}
                          />
                        );
                      })}
                      {isLoading && !streamingMessageId && (
                        <div className={`rounded-xl border p-2.5 text-sm ${workspaceUi.thinkingCard}`}>
                          <div className="flex items-center gap-2.5">
                            <span className="relative flex h-7 w-7 items-center justify-center rounded-full bg-[#31577d]/14 text-[#c8e2ff]">
                              <span className="absolute h-1.5 w-1.5 animate-pulse rounded-full bg-[#9cc4ee]" />
                              <Terminal className="relative h-3.5 w-3.5" />
                            </span>
                            <div>
                              <div className={`text-[13px] font-medium ${workspaceUi.title}`}>
                                {settingsLabels.agentThinking}
                                <span className="inline-flex w-5 justify-start">
                                  <span className="animate-pulse">...</span>
                                </span>
                              </div>
                              <div className={`text-[11px] ${workspaceUi.muted}`}>
                                {settingsLabels.agentThinkingDesc}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                      <div ref={messagesEndRef} />
                    </div>
                  </div>
                </div>

                <div className={`shrink-0 border-t ${workspaceUi.panelDivider}`}>
                  <ChatInput
                    inputValue={inputValue}
                    setInputValue={setInputValue}
                    onSendMessage={handleSendMessage}
                    textareaRef={textareaRef}
                    onKeyDown={handleTextareaKeyDown}
                    disabled={isLoading}
                    pendingFiles={pendingFiles}
                    onRemovePendingFile={removePendingFile}
                    isDark={isDark}
                    placeholder={settingsLabels.askFollowUp}
                    labels={settingsLabels}
                    compact
                  />
                </div>
              </aside>
            </div>
          </div>
        </div>
      </div>
      {settingsPanelOpen && (
        <div
          className={`motion-overlay fixed inset-0 z-[90] px-2 py-3 backdrop-blur-[2px] sm:px-4 sm:py-10 ${
            settingsPanelVisible
              ? `${workspaceUi.overlay} opacity-100`
              : "bg-black/0 opacity-0"
          }`}
          onClick={closeSettingsPanel}
        >
          <div
            className={`motion-modal-panel mx-auto flex h-[calc(100dvh-24px)] w-full max-w-[1600px] flex-col overflow-hidden rounded-xl border sm:h-[calc(100vh-96px)] sm:rounded-2xl ${
              settingsPanelVisible
                ? "translate-y-0 scale-100 opacity-100"
                : "translate-y-3 scale-[0.985] opacity-0"
            } ${workspaceUi.modal}`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className={`flex items-center justify-between border-b px-3 py-2 sm:px-5 sm:py-3 ${workspaceUi.modalHeader}`}>
              <h2 className={`inline-flex items-center gap-2 text-[22px] font-semibold sm:text-[28px] ${workspaceUi.title}`}>
                <Settings className="h-5 w-5 sm:h-6 sm:w-6" />
                {settingsLabels.settings || "Settings"}
              </h2>
              <button
                type="button"
                onClick={closeSettingsPanel}
                className={`motion-icon-interactive rounded-md p-2 transition-colors ${workspaceUi.modalClose}`}
                aria-label={settingsLabels.close}
              >
                <X className="h-5 w-5 sm:h-6 sm:w-6" />
              </button>
            </header>

            <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr] md:grid-cols-[320px_1fr] md:grid-rows-none">
              <SettingsSidebar
                isDark={isDark}
                settingsPanelSection={settingsPanelSection}
                switchSettingsPanelSection={switchSettingsPanelSection}
                workspaceInitials={workspaceInitials}
                profileAvatarDataUrl={profileAvatarDataUrl}
                labels={settingsLabels}
                closeSettingsPanel={closeSettingsPanel}
                hasPaidPlan={hasPaidPlan}
              />

              <main className={`overflow-y-auto p-4 sm:p-6 md:p-8 ${workspaceUi.modalMain}`}>
                <div
                  className={`motion-tab-panel ${
                    settingsContentVisible
                      ? "translate-y-0 opacity-100"
                      : "pointer-events-none translate-y-2 opacity-0"
                  }`}
                >
                  {displayedSettingsPanelSection === "usage" && (
                    <WorkspaceUsageSection isDark={isDark} labels={settingsLabels} />
                  )}
                  {displayedSettingsPanelSection === "security" && (
                    <SecuritySection
                      isDark={isDark}
                      labels={settingsLabels}
                      twoFactorEnabled={twoFactorEnabled}
                      setTwoFactorEnabled={handleTwoFactorChange}
                      loginAlertsEnabled={loginAlertsEnabled}
                      setLoginAlertsEnabled={handleLoginAlertsChange}
                    />
                  )}
                  {displayedSettingsPanelSection === "billing" && (
                    <BillingSection
                      isDark={isDark}
                      labels={settingsLabels}
                      activePlanLabel={activePlanLabel}
                      onOpenPricing={() => setPricingModalOpen(true)}
                    />
                  )}
                  {displayedSettingsPanelSection === "accountSeats" && (
                    <AccountSeatsSection
                      isDark={isDark}
                      labels={settingsLabels}
                      activePlanLabel={activePlanLabel}
                      onManagePlan={() => setPricingModalOpen(true)}
                    />
                  )}
                  {displayedSettingsPanelSection === "accountUsage" &&
                    hasPaidPlan && (
                      <AccountUsageSection
                        isDark={isDark}
                        labels={settingsLabels}
                        activePlan={activePlan}
                        activePlanLabel={activePlanLabel}
                        billingCycle={billingCycle}
                        onManagePlan={() => setPricingModalOpen(true)}
                        accountEntitlements={accountEntitlements}
                      />
                    )}
                  {displayedSettingsPanelSection === "preferences" && (
                    <PreferencesSection
                      isDark={isDark}
                      labels={settingsLabels}
                      theme={settingsTheme}
                      setTheme={handleSettingsThemeChange}
                      language={settingsLanguage}
                      setLanguage={handleSettingsLanguageChange}
                      notificationsEnabled={notificationsEnabled}
                      setNotificationsEnabled={handleNotificationsChange}
                    />
                  )}
                  {displayedSettingsPanelSection === "advanced" && (
                    <AdvancedSection
                      isDark={isDark}
                      labels={settingsLabels}
                      onResetPreferences={handleResetPreferences}
                    />
                  )}
                  {displayedSettingsPanelSection === "promotions" && (
                    <PromotionsSection
                      isDark={isDark}
                      labels={settingsLabels}
                      referralSummary={referralSummary}
                      isLoadingReferralSummary={false}
                      referralSummaryError={null}
                      onCopyReferralCode={copyToClipboard}
                      onCopyReferralLink={copyToClipboard}
                    />
                  )}
                  {displayedSettingsPanelSection === "profile" && (
                    <ProfileSection
                      isDark={isDark}
                      labels={settingsLabels}
                      workspaceInitials={workspaceInitials}
                      profileAvatarDataUrl={profileAvatarDataUrl}
                      profileUsername={profileUsername}
                      profileEmail={profileEmail}
                      profileFirstName={profileFirstName}
                      setProfileFirstName={setProfileFirstName}
                      profileLastName={profileLastName}
                      setProfileLastName={setProfileLastName}
                      profileBio={profileBio}
                      setProfileBio={setProfileBio}
                      bioRemaining={bioRemaining}
                      saveProfileToStorage={saveProfileToStorage}
                      handleAvatarUpload={handleAvatarUpload}
                    />
                  )}
                </div>
              </main>
            </div>
          </div>
        </div>
      )}

      {pricingModalOpen && (
        <PricingModal
          isDark={isDark}
          labels={settingsLabels}
          billingCycle={billingCycle}
          setBillingCycle={setBillingCycle}
          onClose={() => setPricingModalOpen(false)}
          pricingPlans={pricingPlans}
          onSelectPlan={handleSelectPlan}
        />
      )}
    </div>
  );
};
