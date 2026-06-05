"use client";

import {
  Boxes,
  Gift,
  Home,
  Plus,
  Settings,
  Shield,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { ChangeEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import type { AccountSnapshot } from "@/lib/account/types";
import type { UiLanguage, UiSection, UiTheme } from "./ProjectsPage";
import {
  AccountSeatsSection,
  BillingSection,
  AccountUsageSection,
  AdvancedSection,
  PricingModal,
  PreferencesSection,
  ProfileSection,
  PromotionsSection,
  ReferralSummary,
  SecuritySection,
  SETTINGS_LOCAL_STORAGE_KEYS,
  SETTINGS_PROFILE_EMAIL_STORAGE_KEY,
  SettingsSidebar,
  WorkspaceUsageSection,
} from "./SettingsPanelContent";

interface ProjectsLayoutProps {
  children: ReactNode;
  theme: UiTheme;
  setTheme: (theme: UiTheme) => void;
  language: UiLanguage;
  setLanguage: (language: UiLanguage) => void;
  accountName: string;
  accountSnapshot?: AccountSnapshot | null;
  activeSection: UiSection;
  setActiveSection: (section: UiSection) => void;
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
const ACCOUNT_PLAN_STORAGE_KEY = "klawpen:account-plan";
const UI_THEME_STORAGE_KEY = "klawpen:ui-theme";
const UI_LANGUAGE_STORAGE_KEY = "klawpen:ui-language";
const PROJECTS_NOTIFICATIONS_STORAGE_KEY = "klawpen:projects:notifications";
const PROJECTS_TWO_FACTOR_STORAGE_KEY = "klawpen:projects:two-factor";
const PROJECTS_LOGIN_ALERTS_STORAGE_KEY = "klawpen:projects:login-alerts";

const isAccountPlan = (value: string | null): value is AccountPlan =>
  value === "starter" || value === "core" || value === "pro" || value === "enterprise";

const resolveStoredBoolean = (key: string, fallback: boolean) => {
  if (typeof window === "undefined") return fallback;
  const storedValue = window.localStorage.getItem(key);
  if (storedValue === "true") return true;
  if (storedValue === "false") return false;
  return fallback;
};

const detectBrowserTheme = (): UiTheme => {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const detectBrowserLanguage = (): UiLanguage => {
  if (typeof navigator === "undefined") return "en";
  const primaryLanguage = (navigator.languages?.[0] || navigator.language || "en").toLowerCase();
  return primaryLanguage.startsWith("tr") ? "tr" : "en";
};

const normalizeSeed = (value: string) =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);

const buildFallbackReferralCode = (accountName: string) => {
  const normalized = normalizeSeed(accountName || "DECEMBER");
  if (normalized.length >= 8) return normalized.slice(0, 8);
  return `${normalized}${"DECEMBER".slice(0, Math.max(0, 8 - normalized.length))}`.slice(0, 8);
};

export const ProjectsLayout = ({
  children,
  theme,
  setTheme,
  language,
  setLanguage,
  accountName,
  accountSnapshot,
  activeSection,
  setActiveSection,
}: ProjectsLayoutProps) => {
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [settingsPanelVisible, setSettingsPanelVisible] = useState(false);
  const [settingsPanelSection, setSettingsPanelSection] = useState<SettingsPanelSection>("profile");
  const [displayedSettingsPanelSection, setDisplayedSettingsPanelSection] =
    useState<SettingsPanelSection>("profile");
  const [settingsContentVisible, setSettingsContentVisible] = useState(true);
  const [pricingModalOpen, setPricingModalOpen] = useState(false);
  const [isSidebarHoverOpen, setIsSidebarHoverOpen] = useState(false);
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");
  const [activePlan, setActivePlan] = useState<AccountPlan>("starter");
  const [profileAvatarDataUrl, setProfileAvatarDataUrl] = useState<string | null>(null);
  const [profileFirstName, setProfileFirstName] = useState("kaichen");
  const [profileLastName, setProfileLastName] = useState("Yilmaz");
  const [profileBio, setProfileBio] = useState("");
  const [notificationsEnabled, setNotificationsEnabled] = useState(() =>
    resolveStoredBoolean(PROJECTS_NOTIFICATIONS_STORAGE_KEY, true)
  );
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(() =>
    resolveStoredBoolean(PROJECTS_TWO_FACTOR_STORAGE_KEY, false)
  );
  const [loginAlertsEnabled, setLoginAlertsEnabled] = useState(() =>
    resolveStoredBoolean(PROJECTS_LOGIN_ALERTS_STORAGE_KEY, true)
  );
  const [referralSummary, setReferralSummary] = useState<ReferralSummary | null>(null);
  const [isLoadingReferralSummary, setIsLoadingReferralSummary] = useState(false);
  const [referralSummaryError, setReferralSummaryError] = useState<string | null>(null);

  const settingsPanelCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsContentSwapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarOpenTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarIntentTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarPointerRef = useRef<{ x: number; y: number } | null>(null);
  const isDark = theme === "dark";
  const accountEntitlements = accountSnapshot?.entitlements;
  const workspaceInitials = (accountSnapshot?.profile.displayName || accountName || "AY")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const profileStoragePrefix = `klawpen:prefs:${accountName}`;
  const legacyProfileStoragePrefix = `klawpen:profile:${accountName}`;
  const profileUsername = accountName.toLowerCase().replace(/\s+/g, "");
  const profileEmail = accountSnapshot?.profile.email || `${profileUsername}@icloud.com`;
  const displayedProfileAvatarUrl = profileAvatarDataUrl || accountSnapshot?.profile.avatarUrl || null;
  const profileDisplayName =
    `${profileFirstName} ${profileLastName}`.trim() ||
    accountSnapshot?.profile.displayName ||
    accountName;
  const bioRemaining = Math.max(0, 140 - profileBio.length);
  const monthlyAiLimit = accountEntitlements?.monthlyAiLimit || 100;
  const monthlyAiUsed = Math.min(accountEntitlements?.monthlyAiUsed || 0, monthlyAiLimit);
  const accountUsagePercent = monthlyAiLimit > 0 ? Math.min(100, Math.round((monthlyAiUsed / monthlyAiLimit) * 100)) : 0;
  const accountBalanceCredits = (accountEntitlements?.balanceCents || 0) / 100;
  const accountBalanceText = `${new Intl.NumberFormat(language === "tr" ? "tr-TR" : "en-US", {
    maximumFractionDigits: accountBalanceCredits % 1 === 0 ? 0 : 1,
  }).format(accountBalanceCredits)} ${language === "tr" ? "Core kredisi" : "Core credits"}`;
  const apiAccessLabel = accountEntitlements?.apiAccessEnabled
    ? language === "tr"
      ? "Core aktif"
      : "Core on"
    : language === "tr"
      ? "Core kapalı"
      : "Core off";

  const labels = {
    en: {
      workspace: `${accountName}'s Workspace`,
      home: "Home",
      projects: "Projects",
      publishedProjects: "Published Projects",
      security: "Security",
      promotions: "Promotions",
      settings: "Settings",
      workspaceOverview: "Workspace overview",
      workspaceName: "Workspace name",
      exportApps: "Export Apps",
      exportDesc: "Bulk export personal apps. We'll send a download link when ready.",
      startExport: "Start Export",
      workspaceLabel: "Workspace",
      accountLabel: "Account",
      userLabel: "User",
      workspaceCollaborators: "Workspace collaborators",
      integrations: "Integrations",
      workspaceUsage: "Workspace usage",
      billing: "Billing",
      accountSeats: "Account seats",
      accountUsage: "Account usage",
      accountUsageTitle: "Account usage",
      accountUsageSubtitle: "Track your Klawpen Core limits, model activity, and generation flow for this billing cycle.",
      accountUsageLocked: "Account usage unlocks with Core, Pro, or Enterprise.",
      accountUsagePlan: "Active plan",
      accountUsageCycle: "Billing cycle",
      accountUsageAiRequests: "Core credits",
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
      accountSeatsTitle: "Account seats",
      accountSeatsSubtitle: "Manage who can access this workspace and keep team capacity under control.",
      advancedTitle: "Advanced",
      advancedSubtitle: "Fine tune workspace behavior, local cache, and safety controls.",
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
      commandPaletteDesc: "Use the quick launcher for files, actions, and workspace commands.",
      dataControls: "Data controls",
      dataControlsDesc: "Keep assistant activity and local settings scoped to this browser.",
      workspaceCache: "Workspace cache",
      workspaceCacheDesc: "Preload frequently edited files so the code editor opens faster.",
      enabled: "Enabled",
      optimized: "Optimized",
      resetPreferences: "Reset local preferences",
      resetPreferencesDesc: "Clear saved theme, language, notification, and security toggles on this browser.",
      reset: "Reset",
      preferencesReset: "Preferences reset",
      profile: "Profile",
      preferences: "Preferences",
      notifications: "Notifications",
      notificationsDesc: "Receive product updates, workspace alerts, and account activity.",
      themePreference: "Theme",
      themePreferenceDesc: "Choose how Klawpen looks across your workspace.",
      languagePreference: "Language",
      languagePreferenceDesc: "Apply the interface language across projects, settings, and prompts.",
      promotionsAndReferrals: "Promotions & Referrals",
      securityCenter: "Security Center",
      securityDesc: "Protect your account and keep your workspace safe.",
      securityScore: "Security score",
      recommended: "Recommended",
      secured: "Secured",
      twoFactorAuth: "Two-factor authentication",
      twoFactorDesc: "Add an extra verification step when signing in.",
      loginAlerts: "Login alerts",
      loginAlertsDesc: "Get notified when a new device signs in.",
      activeSessions: "Active sessions",
      activeSessionsDesc: "Manage signed-in devices linked to your account.",
      deviceThisBrowser: "This browser - Istanbul",
      lastActiveNow: "Last active: now",
      signOutOthers: "Sign out other sessions",
      otherSessionsSignedOut: "Other sessions signed out",
      promotionsHub: "Promotions Hub",
      promotionsDesc: "Grow your project reach with campaigns and referral perks.",
      featuredOffer: "Featured offer",
      offerDesc: "Get 3 months of Core at 20% off for annual billing.",
      claimOffer: "Claim offer",
      campaignPerformance: "Campaign performance",
      campaignReady: "Your referral campaign is ready",
      viewPreviousInvoices: "View previous invoices here.",
      hideInvoices: "Hide invoices",
      noPreviousInvoices: "No previous invoices yet",
      billingUsageDelay: "Updates take up to 1 hour and may not reflect the latest usage data.",
      freePlan: "Free",
      paymentMethod: "Payment method",
      noPaymentMethod: "No payment method on file",
      changePlan: "Change plan",
      changePlanDesc: "View or change your subscription plan",
      billingUpgrade: "Upgrade",
      referrals: "Referrals",
      referralDesc: "Bring your friends to Klawpen. They get bonus credits when they upgrade, and so do you once you're on a paid plan.",
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
      referralIntro: "Share your referral link with friends. When they subscribe through your code, your reward summary updates automatically.",
      loadingReferralData: "Loading referral data...",
      updatesMayDelay: "Updates take up to 1 hour and may not reflect the latest usage data.",
      viewAllUsage: "View all usage",
      hideUsageDetails: "Hide usage details",
      totalUsage: "Total usage",
      agentUsers: "Agent users",
      agentUsage: "Agent usage",
      noAgentUsage: "No agent usage",
      noAgentUsageDesc: "No agent usage data is available for this billing period.",
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
      learn: "Learn",
      documentation: "Documentation",
      starterPlan: "Your Starter Plan",
      agentCredits: "Agent credits",
      cloudCredits: "Cloud credits",
      usedPercent: "0% used",
      upgrade: "Upgrade to Klawpen Core",
      upgradeBadge: "PRO",
      upgradeDesc: "Upgrade for image uploads, smarter AI, and more Pro Search.",
      learnMore: "Learn More",
      install: "Install Replit on",
      changelog: "Changelog",
      light: "Light",
      dark: "Dark",
      language: "Language",
      createNew: "Create something new",
      importCode: "Import code or design",
      yourWorkspaces: "Your workspaces",
      personal: "Personal",
      team: "Team workspace",
      createWorkspace: "Create workspace",
      core: "Core",
      workspaceCardTitle: "Workspace details",
      workspaceCardText: "Choose a workspace mode. Personal is optimized for solo speed. Team is optimized for collaboration and shared ownership.",
      personalSubtitle: "Best for your own account",
      teamSubtitle: "Best for team collaboration",
      workspaceOwner: "Workspace owner",
      useWorkspace: "Use this workspace",
      manageTeam: "Manage team settings",
      comparePlans: "Compare plans",
      compareSubtitle: "Choose the best plan for you",
      monthly: "Monthly",
      yearly: "Yearly",
      yearlyDiscount: "20% off yearly",
      close: "Close",
      starter: "Starter",
      corePlan: "Core",
      proPlan: "Pro",
      enterprise: "Enterprise",
      currentPlan: "Current plan",
      continueCore: "Continue with Core",
      continuePro: "Continue with Pro",
      contactSales: "Contact sales",
      pricingFootnote: "Yearly billing applies a 20% discount to the monthly plan price.",
    },
    tr: {
      workspace: `${accountName} \u00c7al\u0131\u015fma Alan\u0131`,
      home: "Ana Sayfa",
      projects: "Projeler",
      publishedProjects: "Yay\u0131nlanan Projeler",
      security: "G\u00fcvenlik",
      promotions: "Promosyonlar",
      settings: "Ayarlar",
      workspaceOverview: "\u00c7al\u0131\u015fma alan\u0131 genel bak\u0131\u015f",
      workspaceName: "\u00c7al\u0131\u015fma alan\u0131 ad\u0131",
      exportApps: "Uygulamalar\u0131 d\u0131\u015fa aktar",
      exportDesc: "Ki\u015fisel uygulamalar\u0131 toplu d\u0131\u015fa aktar. Haz\u0131r olunca indirme ba\u011flant\u0131s\u0131 g\u00f6nderece\u011fiz.",
      startExport: "D\u0131\u015fa Aktarmay\u0131 Ba\u015flat",
      workspaceLabel: "\u00c7al\u0131\u015fma Alan\u0131",
      accountLabel: "Hesap",
      userLabel: "Kullan\u0131c\u0131",
      workspaceCollaborators: "\u00c7al\u0131\u015fma alan\u0131 i\u015f birlik\u00e7ileri",
      integrations: "Entegrasyonlar",
      workspaceUsage: "\u00c7al\u0131\u015fma alan\u0131 kullan\u0131m\u0131",
      billing: "Faturaland\u0131rma",
      accountSeats: "Hesap koltuklar\u0131",
      accountUsage: "Hesap kullan\u0131m\u0131",
      accountUsageTitle: "Hesap kullan\u0131m\u0131",
      accountUsageSubtitle: "Bu fatura d\u00f6nemi i\u00e7in Klawpen Core limitlerini, model aktivitesini ve \u00fcretim ak\u0131\u015f\u0131n\u0131 takip et.",
      accountUsageLocked: "Hesap kullan\u0131m\u0131 Core, Pro veya Enterprise ile a\u00e7\u0131l\u0131r.",
      accountUsagePlan: "Aktif plan",
      accountUsageCycle: "Fatura d\u00f6nemi",
      accountUsageAiRequests: "Core kredileri",
      accountUsageImages: "G\u00f6rsel referanslar",
      accountUsageProjects: "Proje \u00fcretimleri",
      accountUsageRemaining: "kald\u0131",
      accountUsageUpdated: "\u015eimdi g\u00fcncellendi",
      accountUsageTrend: "Kullan\u0131m trendi",
      accountUsageModelMix: "Model da\u011f\u0131l\u0131m\u0131",
      accountUsageSoftLimit: "Soft limit",
      accountUsageHardLimit: "Hard limit",
      accountBalance: "Bakiye",
      apiAccessEnabled: "API erisimi acik",
      apiAccessDisabled: "API erisimi kapali",
      managePlan: "Plan\u0131 y\u00f6net",
      advanced: "Geli\u015fmi\u015f",
      accountSeatsTitle: "Hesap koltuklari",
      accountSeatsSubtitle: "Bu calisma alanina kimlerin erisecegini ve ekip kapasitesini yonet.",
      advancedTitle: "Gelismis",
      advancedSubtitle: "Calisma alani davranisini, lokal cache'i ve guvenlik kontrollerini ince ayarla.",
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
      commandPaletteDesc: "Dosyalar, aksiyonlar ve workspace komutlari icin hizli baslaticiyi kullan.",
      dataControls: "Veri kontrolleri",
      dataControlsDesc: "Asistan aktivitesini ve lokal ayarlari bu tarayiciya sinirla.",
      workspaceCache: "Workspace cache",
      workspaceCacheDesc: "Kod editorunun daha hizli acilmasi icin sik duzenlenen dosyalari on yukle.",
      enabled: "Aktif",
      optimized: "Optimize",
      resetPreferences: "Lokal tercihleri sifirla",
      resetPreferencesDesc: "Bu tarayicidaki tema, dil, bildirim ve guvenlik tercihlerini temizle.",
      reset: "Sifirla",
      preferencesReset: "Tercihler sifirlandi",
      profile: "Profil",
      preferences: "Tercihler",
      notifications: "Bildirimler",
      notificationsDesc: "\u00dcr\u00fcn g\u00fcncellemeleri, \u00e7al\u0131\u015fma alan\u0131 uyar\u0131lar\u0131 ve hesap aktivitelerini al.",
      themePreference: "Tema",
      themePreferenceDesc: "Klawpen'\u0131n \u00e7al\u0131\u015fma alan\u0131nda nas\u0131l g\u00f6r\u00fcnece\u011fini se\u00e7.",
      languagePreference: "Dil",
      languagePreferenceDesc: "Aray\u00fcz dilini projeler, ayarlar ve promptlarda uygula.",
      promotionsAndReferrals: "Promosyonlar ve Referanslar",
      securityCenter: "G\u00fcvenlik Merkezi",
      securityDesc: "Hesab\u0131n\u0131 koru ve \u00e7al\u0131\u015fma alan\u0131n\u0131 g\u00fcvende tut.",
      securityScore: "G\u00fcvenlik skoru",
      recommended: "\u00d6nerilen",
      secured: "Guvende",
      twoFactorAuth: "\u0130ki a\u015famal\u0131 do\u011frulama",
      twoFactorDesc: "Giri\u015fte ek bir do\u011frulama ad\u0131m\u0131 ekle.",
      loginAlerts: "Giri\u015f uyar\u0131lar\u0131",
      loginAlertsDesc: "Yeni bir cihaz giri\u015f yapt\u0131\u011f\u0131nda bildirim al.",
      activeSessions: "Aktif oturumlar",
      activeSessionsDesc: "Hesab\u0131na ba\u011fl\u0131 oturumlar\u0131 y\u00f6net.",
      deviceThisBrowser: "Bu tarayici - Istanbul",
      lastActiveNow: "Son aktiflik: \u015fimdi",
      signOutOthers: "Di\u011fer oturumlar\u0131 kapat",
      otherSessionsSignedOut: "Diger oturumlar kapatildi",
      promotionsHub: "Promosyon Merkezi",
      promotionsDesc: "Kampanyalar ve referans avantajlar\u0131yla projeni b\u00fcy\u00fct.",
      featuredOffer: "\u00d6ne \u00e7\u0131kan teklif",
      offerDesc: "Y\u0131ll\u0131k faturalamada 3 ay boyunca Core'da %20 indirim kazan.",
      claimOffer: "Teklifi al",
      campaignPerformance: "Kampanya performans\u0131",
      campaignReady: "Referans kampanyan haz\u0131r",
      viewPreviousInvoices: "\u00d6nceki faturalar\u0131 burada g\u00f6r\u00fcnt\u00fcle.",
      hideInvoices: "Faturalari gizle",
      noPreviousInvoices: "Henuz onceki fatura yok",
      billingUsageDelay: "G\u00fcncellemeler 1 saate kadar s\u00fcrebilir ve en g\u00fcncel kullan\u0131m verisini yans\u0131tmayabilir.",
      freePlan: "\u00dccretsiz",
      paymentMethod: "\u00d6deme y\u00f6ntemi",
      noPaymentMethod: "Kay\u0131tl\u0131 \u00f6deme y\u00f6ntemi yok",
      changePlan: "Plan\u0131 de\u011fi\u015ftir",
      changePlanDesc: "Abonelik plan\u0131n\u0131 g\u00f6r\u00fcnt\u00fcle veya de\u011fi\u015ftir",
      billingUpgrade: "Y\u00fckselt",
      referrals: "Referanslar",
      referralDesc: "Arkadaslarini Klawpen'a davet et. Ucretli plana gectiklerinde bonus kredi kazanirsin.",
      referralCode: "Referans kodu",
      rewardRule: "\u00dccretli y\u00f6nlendirme ba\u015f\u0131 bonus",
      successfulReferrals: "Ba\u015far\u0131l\u0131 referanslar",
      pendingReferrals: "Bekleyen referanslar",
      totalRewards: "Toplam \u00f6d\u00fcl",
      pendingRewards: "Bekleyen \u00f6d\u00fcl",
      copyCode: "Kodu kopyala",
      copyLink: "Linki kopyala",
      bonusCta: "Bonus kredilerini almak icin Core'a yukselt",
      bonusClaimed: "Bonus alindi",
      referralIntro: "Referans linkini arkadaslarinla paylas. Kodunla abone olduklarinda odul ozetin otomatik guncellenir.",
      loadingReferralData: "Referans verileri yukleniyor...",
      updatesMayDelay: "G\u00fcncellemeler 1 saate kadar s\u00fcrebilir ve en yeni kullan\u0131m verisini yans\u0131tmayabilir.",
      viewAllUsage: "T\u00fcm kullan\u0131m\u0131 g\u00f6r",
      hideUsageDetails: "Kullanim detaylarini gizle",
      totalUsage: "Toplam kullan\u0131m",
      agentUsers: "Agent kullan\u0131c\u0131lar\u0131",
      agentUsage: "Agent kullan\u0131m\u0131",
      noAgentUsage: "Agent kullan\u0131m\u0131 yok",
      noAgentUsageDesc: "Bu fatura d\u00f6nemi i\u00e7in agent kullan\u0131m verisi bulunmuyor.",
      username: "Kullan\u0131c\u0131 ad\u0131",
      firstName: "Ad",
      lastName: "Soyad",
      bio: "Biyografi",
      addBio: "Bir biyografi ekle",
      saveChanges: "De\u011fi\u015fiklikleri kaydet",
      viewPublicProfile: "Public profilimi g\u00f6r\u00fcnt\u00fcle",
      yourEmail: "E-posta adresin",
      yourPassword: "\u015eifren",
      edit: "D\u00fczenle",
      locked: "Kilitli",
      publicProfilePreview: "Public profil onizlemesi",
      publicProfileOpened: "Public profili gizle",
      emailEdit: "E-postayi duzenle",
      emailSaved: "E-posta kaydedildi",
      passwordUpdated: "Sifre guncellendi",
      passwordUpdatedDesc: "Son degisiklik bu tarayicida kayitli.",
      learn: "\u00d6\u011fren",
      documentation: "Dok\u00fcmantasyon",
      starterPlan: "Ba\u015flang\u0131\u00e7 Plan\u0131n",
      agentCredits: "Ajan kredileri",
      cloudCredits: "Bulut kredileri",
      usedPercent: "%0 kullan\u0131ld\u0131",
      upgrade: "Klawpen Core'a Y\u00fckselt",
      upgradeBadge: "PRO",
      upgradeDesc: "G\u00f6rsel y\u00fckleme, daha ak\u0131ll\u0131 AI ve daha fazla Pro Search i\u00e7in y\u00fckselt.",
      learnMore: "Daha Fazla",
      install: "Replit'i y\u00fckle",
      changelog: "De\u011fi\u015fiklikler",
      light: "Ayd\u0131nl\u0131k",
      dark: "Karanl\u0131k",
      language: "Dil",
      createNew: "Create something new",
      importCode: "Import code or design",
      yourWorkspaces: "\u00c7al\u0131\u015fma alanlar\u0131n",
      personal: "Personal",
      team: "Team workspace",
      createWorkspace: "Create workspace",
      core: "Core",
      workspaceCardTitle: "\u00c7al\u0131\u015fma alan\u0131 detaylar\u0131",
      workspaceCardText: "Bir \u00e7al\u0131\u015fma alan\u0131 tipi se\u00e7. Personal tek ki\u015fi i\u00e7in, Team ise ekip i\u015fbirli\u011fi i\u00e7in optimize edilir.",
      personalSubtitle: "Kendi hesab\u0131n i\u00e7in en iyi se\u00e7im",
      teamSubtitle: "Ekip i\u015fbirli\u011fi i\u00e7in en iyi se\u00e7im",
      workspaceOwner: "Alan sahibi",
      useWorkspace: "Bu alan\u0131 kullan",
      manageTeam: "Tak\u0131m ayarlar\u0131n\u0131 y\u00f6net",
      comparePlans: "Planlar\u0131 kar\u015f\u0131la\u015ft\u0131r",
      compareSubtitle: "Senin i\u00e7in en uygun plan\u0131 se\u00e7",
      monthly: "Ayl\u0131k",
      yearly: "Y\u0131ll\u0131k",
      yearlyDiscount: "Y\u0131ll\u0131kta %20 indirim",
      close: "Kapat",
      starter: "Starter",
      corePlan: "Core",
      proPlan: "Pro",
      enterprise: "Enterprise",
      currentPlan: "Mevcut plan",
      continueCore: "Core ile devam et",
      continuePro: "Pro ile devam et",
      contactSales: "Sat\u0131\u015f ekibi",
      pricingFootnote: "Y\u0131ll\u0131k faturalamada ayl\u0131k plan fiyat\u0131na %20 indirim uygulan\u0131r.",
    },
  }[language];

  const pricingPlans = useMemo(
    () => [
      {
        key: "core",
        name: labels.corePlan,
        desc: language === "tr" ? "Ki\u015fisel projeler ve h\u0131zl\u0131 prototipler i\u00e7in" : "For personal projects and quick prototypes",
        monthly: "$15", yearly: "$12",
        noteMonthly: language === "tr" ? "ayl\u0131k faturaland\u0131rma" : "per month billed monthly",
        noteYearly: language === "tr" ? "ayl\u0131k, y\u0131ll\u0131k fatural\u0131 (%20 indirim)" : "per month billed annually (20% off)",
        cta: labels.continueCore,
        features: language === "tr"
          ? ["Ayl\u0131k 200 Klawpen Core kredisi", "G\u00f6rsel referans ekleme", "Ki\u015fisel proje ak\u0131\u015flar\u0131"]
          : ["200 Klawpen Core credits monthly", "Image reference uploads", "Personal project workflows"],
        featured: true,
      },
      {
        key: "pro",
        name: labels.proPlan,
        desc: language === "tr" ? "Profesyonel kullan\u0131m i\u00e7in" : "For commercial and professional builds",
        monthly: "$25", yearly: "$20",
        noteMonthly: language === "tr" ? "ayl\u0131k faturaland\u0131rma" : "per month billed monthly",
        noteYearly: language === "tr" ? "ayl\u0131k, y\u0131ll\u0131k fatural\u0131 (%20 indirim)" : "per month billed annually (20% off)",
        cta: labels.continuePro,
        features: language === "tr"
          ? ["Ayl\u0131k 600 Klawpen Core kredisi", "Klawpen Core otomatik model y\u00f6nlendirme", "\u00d6ncelikli \u00fcretim ak\u0131\u015f\u0131"]
          : ["600 Klawpen Core credits monthly", "Klawpen Core automatic model routing", "Priority generation flow"],
      },
      {
        key: "enterprise",
        name: labels.enterprise,
        desc: language === "tr" ? "Kurumsal seviye kontrol" : "For enterprise-grade security & controls",
        monthly: "$115", yearly: "$92",
        noteMonthly: language === "tr" ? "ayl\u0131k faturaland\u0131rma" : "per month billed monthly",
        noteYearly: language === "tr" ? "ayl\u0131k, y\u0131ll\u0131k fatural\u0131 (%20 indirim)" : "per month billed annually (20% off)",
        cta: labels.contactSales,
        features: language === "tr"
          ? ["Ayl\u0131k 3.000 Klawpen Core kredisi", "En y\u00fcksek Core limitleri", "\u00d6zel destek ve onboarding"]
          : ["3,000 Klawpen Core credits monthly", "Highest Core limits", "Dedicated support and onboarding"],
      },
    ],
    [labels, language]
  );

  const activePlanLabel =
    activePlan === "core"
      ? labels.corePlan
      : activePlan === "pro"
        ? labels.proPlan
        : activePlan === "enterprise"
          ? labels.enterprise
          : labels.starter;
  const hasPaidPlan = activePlan !== "starter";

  useEffect(() => {
    const closePanel = () => {
      setSettingsPanelVisible(false);
      if (settingsPanelCloseTimeoutRef.current) clearTimeout(settingsPanelCloseTimeoutRef.current);
      settingsPanelCloseTimeoutRef.current = setTimeout(() => setSettingsPanelOpen(false), 180);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (settingsPanelOpen) closePanel();
        setPricingModalOpen(false);
      }
    };
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("keydown", onEscape);
      if (settingsPanelCloseTimeoutRef.current) clearTimeout(settingsPanelCloseTimeoutRef.current);
      if (settingsContentSwapTimeoutRef.current) clearTimeout(settingsContentSwapTimeoutRef.current);
      if (sidebarOpenTimeoutRef.current) clearTimeout(sidebarOpenTimeoutRef.current);
      if (sidebarCloseTimeoutRef.current) clearTimeout(sidebarCloseTimeoutRef.current);
      if (sidebarIntentTimeoutRef.current) clearTimeout(sidebarIntentTimeoutRef.current);
    };
  }, [settingsPanelOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedPlan = window.localStorage.getItem(ACCOUNT_PLAN_STORAGE_KEY);
    if (isAccountPlan(storedPlan)) {
      setActivePlan(storedPlan);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const migrate = (key: string) => {
      const legacyVal = window.localStorage.getItem(`${legacyProfileStoragePrefix}:${key}`);
      if (legacyVal && !window.localStorage.getItem(`${profileStoragePrefix}:${key}`)) {
        window.localStorage.setItem(`${profileStoragePrefix}:${key}`, legacyVal);
      }
      window.localStorage.removeItem(`${legacyProfileStoragePrefix}:${key}`);
    };
    ["avatar", "firstName", "lastName", "bio"].forEach(migrate);
    setProfileAvatarDataUrl(window.localStorage.getItem(`${profileStoragePrefix}:avatar`) || null);
    setProfileFirstName(window.localStorage.getItem(`${profileStoragePrefix}:firstName`) || "kaichen");
    setProfileLastName(window.localStorage.getItem(`${profileStoragePrefix}:lastName`) || "Yilmaz");
    setProfileBio(window.localStorage.getItem(`${profileStoragePrefix}:bio`) || "");
  }, [legacyProfileStoragePrefix, profileStoragePrefix]);

  useEffect(() => {
    if (!accountSnapshot?.profile.isAuthenticated) return;

    setActivePlan(accountSnapshot.entitlements.plan);
    if (accountSnapshot.profile.avatarUrl) {
      setProfileAvatarDataUrl(accountSnapshot.profile.avatarUrl);
    }
    if (typeof window !== "undefined" && accountSnapshot.profile.email) {
      window.localStorage.setItem(SETTINGS_PROFILE_EMAIL_STORAGE_KEY, accountSnapshot.profile.email);
    }

    const parts = accountSnapshot.profile.displayName.split(/\s+/).filter(Boolean);
    if (parts.length > 0) {
      setProfileFirstName(parts[0]);
      setProfileLastName(parts.slice(1).join(" "));
    }
  }, [accountSnapshot]);

  useEffect(() => {
    const fetchReferralSummary = async () => {
      setIsLoadingReferralSummary(true);
      setReferralSummaryError(null);
      const fallbackCode = buildFallbackReferralCode(accountName);

      try {
        const response = await fetch(
          `/api/referrals/summary?accountName=${encodeURIComponent(accountName)}`,
          { cache: "no-store" }
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = (await response.json()) as {
          summary?: ReferralSummary;
          setupRequired?: boolean;
        };

        if (payload.summary) {
          setReferralSummary(payload.summary);
          if (payload.setupRequired) {
            setReferralSummaryError(
              language === "tr"
                ? "Supabase referral tablolar\u0131 hen\u00fcz kurulmam\u0131\u015f. \u015eimdilik varsay\u0131lan referans kodu g\u00f6steriliyor."
                : "Supabase referral tables are not set up yet. Showing fallback referral code for now."
            );
          }
          return;
        }
      } catch {
        setReferralSummaryError(
          language === "tr"
            ? "Referans verileri y\u00fcklenemedi. \u015eimdilik varsay\u0131lan kod kullan\u0131l\u0131yor."
            : "Could not load referral data. Using fallback code for now."
        );
      } finally {
        setIsLoadingReferralSummary(false);
      }

      const origin =
        typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
      setReferralSummary({
        referralCode: fallbackCode,
        referralLink: `${origin}/auth/bridge?ref=${fallbackCode}`,
        successfulReferrals: 0,
        pendingReferrals: 0,
        totalRewardsUsd: 0,
        pendingRewardsUsd: 0,
        rewardPerConversionUsd: 10,
      });
    };

    fetchReferralSummary();
  }, [accountName, language]);

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // noop
    }
  };

  const openSettingsPanel = (section: SettingsPanelSection = "profile") => {
    const safeSection = section === "accountUsage" && !hasPaidPlan ? "billing" : section;
    if (settingsPanelCloseTimeoutRef.current) clearTimeout(settingsPanelCloseTimeoutRef.current);
    if (settingsContentSwapTimeoutRef.current) clearTimeout(settingsContentSwapTimeoutRef.current);
    setSettingsPanelSection(safeSection);
    setDisplayedSettingsPanelSection(safeSection);
    setSettingsContentVisible(true);
    setSettingsPanelOpen(true);
    setTimeout(() => setSettingsPanelVisible(true), 10);
  };

  const closeSettingsPanel = () => {
    setSettingsPanelVisible(false);
    if (settingsPanelCloseTimeoutRef.current) clearTimeout(settingsPanelCloseTimeoutRef.current);
    settingsPanelCloseTimeoutRef.current = setTimeout(() => setSettingsPanelOpen(false), 180);
  };

  const switchSettingsPanelSection = (section: SettingsPanelSection) => {
    if (section === "accountUsage" && !hasPaidPlan) return;
    if (section === settingsPanelSection) return;
    setSettingsPanelSection(section);
    setSettingsContentVisible(false);
    if (settingsContentSwapTimeoutRef.current) clearTimeout(settingsContentSwapTimeoutRef.current);
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
    window.localStorage.setItem(`${profileStoragePrefix}:firstName`, profileFirstName);
    window.localStorage.setItem(`${profileStoragePrefix}:lastName`, profileLastName);
    window.localStorage.setItem(`${profileStoragePrefix}:bio`, profileBio);
  };

  const handleNotificationsChange = (enabled: boolean) => {
    setNotificationsEnabled(enabled);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PROJECTS_NOTIFICATIONS_STORAGE_KEY, String(enabled));
    }
  };

  const handleTwoFactorChange = (enabled: boolean) => {
    setTwoFactorEnabled(enabled);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PROJECTS_TWO_FACTOR_STORAGE_KEY, String(enabled));
    }
  };

  const handleLoginAlertsChange = (enabled: boolean) => {
    setLoginAlertsEnabled(enabled);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PROJECTS_LOGIN_ALERTS_STORAGE_KEY, String(enabled));
    }
  };

  const handleResetPreferences = () => {
    const nextTheme = detectBrowserTheme();
    const nextLanguage = detectBrowserLanguage();

    setTheme(nextTheme);
    setLanguage(nextLanguage);
    setNotificationsEnabled(true);
    setTwoFactorEnabled(false);
    setLoginAlertsEnabled(true);

    if (typeof window !== "undefined") {
      [
        UI_THEME_STORAGE_KEY,
        UI_LANGUAGE_STORAGE_KEY,
        PROJECTS_NOTIFICATIONS_STORAGE_KEY,
        PROJECTS_TWO_FACTOR_STORAGE_KEY,
        PROJECTS_LOGIN_ALERTS_STORAGE_KEY,
        ...SETTINGS_LOCAL_STORAGE_KEYS,
      ].forEach((key) => window.localStorage.removeItem(key));
    }

    toast.success(labels.preferencesReset);
  };

  const handleAvatarUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      setProfileAvatarDataUrl(result);
      if (result && typeof window !== "undefined") {
        window.localStorage.setItem(`${profileStoragePrefix}:avatar`, result);
      }
    };
    reader.readAsDataURL(file);
  };

  const scheduleSidebarOpen = () => {
    if (sidebarCloseTimeoutRef.current) {
      clearTimeout(sidebarCloseTimeoutRef.current);
      sidebarCloseTimeoutRef.current = null;
    }
    if (isSidebarHoverOpen || sidebarOpenTimeoutRef.current) return;
    sidebarOpenTimeoutRef.current = setTimeout(() => {
      setIsSidebarHoverOpen(true);
      sidebarOpenTimeoutRef.current = null;
    }, 120);
  };

  const scheduleSidebarClose = () => {
    if (sidebarOpenTimeoutRef.current) {
      clearTimeout(sidebarOpenTimeoutRef.current);
      sidebarOpenTimeoutRef.current = null;
    }
    if (!isSidebarHoverOpen || sidebarCloseTimeoutRef.current) return;
    sidebarCloseTimeoutRef.current = setTimeout(() => {
      setIsSidebarHoverOpen(false);
      sidebarCloseTimeoutRef.current = null;
    }, 220);
  };

  const clearSidebarIntentTimer = () => {
    if (sidebarIntentTimeoutRef.current) {
      clearTimeout(sidebarIntentTimeoutRef.current);
      sidebarIntentTimeoutRef.current = null;
    }
  };

  const armSidebarIntentTimer = () => {
    clearSidebarIntentTimer();
    sidebarIntentTimeoutRef.current = setTimeout(() => {
      scheduleSidebarOpen();
      sidebarIntentTimeoutRef.current = null;
    }, 180);
  };

  const handleSidebarHotzoneMouseEnter = (event: React.MouseEvent<HTMLDivElement>) => {
    sidebarPointerRef.current = { x: event.clientX, y: event.clientY };
    armSidebarIntentTimer();
  };

  const handleSidebarHotzoneMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const previous = sidebarPointerRef.current;
    sidebarPointerRef.current = { x: event.clientX, y: event.clientY };
    if (!previous || isSidebarHoverOpen) return;

    const deltaX = Math.abs(event.clientX - previous.x);
    const deltaY = Math.abs(event.clientY - previous.y);
    const movedEnough = deltaX + deltaY > 12;
    if (movedEnough) armSidebarIntentTimer();
  };

  const handleSidebarHotzoneMouseLeave = () => {
    clearSidebarIntentTimer();
    sidebarPointerRef.current = null;
    scheduleSidebarClose();
  };

  const sidebarSurface = isDark ? "bg-[#1e1e1f] border-[#2d3038]" : "bg-white border-[#e5e7eb]";
  const navIdle = isDark ? "text-slate-300 hover:bg-[#262930] hover:text-slate-100" : "text-slate-700 hover:bg-[#f8fafc]";
  const navActive = isDark ? "bg-[#1e1e1f] text-slate-100" : "bg-[#eaf2fb] text-[#1f3e5f]";
  const menuText = "text-[14px] font-medium leading-tight tracking-[0.008em]";
  const topCardText = "text-[11px] font-medium leading-[1.15] tracking-[0.003em]";
  const actionCardLabelText = "text-[13px] font-medium leading-none";

  return (
    <div
      data-ui-theme={theme}
      className={`theme-transition project-theme-shell min-h-screen ${isDark ? "bg-[#222223] text-slate-100" : "bg-white text-slate-800"}`}
    >
      <div
        className={`fixed inset-y-0 left-0 z-30 hidden w-[320px] lg:block ${
          isSidebarHoverOpen ? "pointer-events-none" : "pointer-events-auto"
        }`}
        onMouseEnter={handleSidebarHotzoneMouseEnter}
        onMouseMove={handleSidebarHotzoneMouseMove}
        onMouseLeave={handleSidebarHotzoneMouseLeave}
        aria-hidden="true"
      />

      <aside
        className={`hover-sidebar ${isSidebarHoverOpen ? "hover-sidebar--open" : "hover-sidebar--closed"} fixed inset-y-0 left-0 z-40 hidden h-screen w-[248px] origin-left overflow-hidden border-r lg:block ${sidebarSurface}`}
        onMouseEnter={() => {
          clearSidebarIntentTimer();
          scheduleSidebarOpen();
        }}
        onMouseLeave={handleSidebarHotzoneMouseLeave}
      >
        <div
          className={`hover-sidebar__content ${isSidebarHoverOpen ? "hover-sidebar__content--open" : "hover-sidebar__content--closed"} flex h-full flex-col px-2.5 pb-2.5 pt-2.5`}
        >
          <div className="mb-3 px-1">
            <button
              type="button"
              onClick={() => openSettingsPanel("profile")}
              className={`motion-interactive flex w-full items-center gap-3 rounded-[18px] border px-3 py-2.5 text-left shadow-sm transition-colors ${
                isDark
                  ? "border-[#3b4049] bg-[#1e1e1f] hover:bg-[#262930]"
                  : "border-[#d7d9de] bg-[#f4f4f5] hover:bg-[#ececee]"
              }`}
              aria-label={labels.profile}
            >
              <span className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#31577d] to-[#12b5cb] text-[12px] font-semibold text-white shadow-sm">
                {displayedProfileAvatarUrl ? (
                  <img
                    src={displayedProfileAvatarUrl}
                    alt="Profile avatar"
                    className="h-full w-full rounded-full object-cover"
                  />
                ) : (
                  workspaceInitials
                )}
                <span className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 bg-[#22c55e] ${isDark ? "border-[#1e1e1f]" : "border-[#f4f4f5]"}`} />
              </span>
              <span className="min-w-0">
                <span className={`block truncate text-[13px] font-semibold leading-none ${isDark ? "text-slate-100" : "text-slate-800"}`}>
                  {profileDisplayName || accountName}
                </span>
                <span className={`mt-1 block truncate text-[10px] leading-none ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                  {profileEmail}
                </span>
              </span>
            </button>

          </div>

          <div className={`mb-3 space-y-1.5 rounded-2xl border p-1.5 ${isDark ? "border-[#30343d] bg-[#17191e]" : "border-[#e9edf3] bg-[#f8fafc]"}`}>
            <button
              type="button"
              onClick={() => {
                setActiveSection("home");
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className={`motion-interactive inline-flex h-7 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 py-1 ${topCardText} ${isDark ? "bg-[#22262d] text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:bg-[#272c34]" : "bg-white text-slate-700 shadow-[0_1px_6px_rgba(15,23,42,0.05)] hover:bg-[#fbfdff]"}`}
            >
              <Plus className="h-3 w-3" /><span className={actionCardLabelText}>{labels.createNew}</span>
            </button>
            <button type="button" className={`motion-interactive inline-flex h-7 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 py-1 ${topCardText} ${isDark ? "text-slate-300 hover:bg-[#22262d] hover:text-slate-100" : "text-slate-600 hover:bg-white hover:text-slate-800 hover:shadow-[0_1px_6px_rgba(15,23,42,0.04)]"}`}>
              <Upload className="h-3 w-3" /><span className={actionCardLabelText}>{labels.importCode}</span>
            </button>
          </div>

          <div className={`mb-2 flex items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-[0.16em] ${isDark ? "text-slate-500" : "text-slate-400"}`}>
            <span>{language === "tr" ? "\u00c7al\u0131\u015fma" : "Workspace"}</span>
            <span className={`h-1 w-1 rounded-full ${isDark ? "bg-cyan-300/70" : "bg-[#31577d]/60"}`} />
          </div>

          <nav className="space-y-1">
            <button type="button" onClick={() => setActiveSection("home")} className={`motion-list-item relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 transition-all duration-150 ${menuText} ${activeSection === "home" ? navActive : navIdle}`}>{activeSection === "home" && <span className="absolute left-0 h-4 w-0.5 rounded-full bg-[#31577d]" />}<Home className="h-3 w-3 shrink-0" /><span className={menuText}>{labels.home}</span></button>
            <button type="button" onClick={() => setActiveSection("projects")} className={`motion-list-item relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 transition-all duration-150 ${menuText} ${activeSection === "projects" ? navActive : navIdle}`}>{activeSection === "projects" && <span className="absolute left-0 h-4 w-0.5 rounded-full bg-[#31577d]" />}<Boxes className="h-3 w-3 shrink-0" /><span className={menuText}>{labels.projects}</span></button>
            <button
              type="button"
              onClick={() => setActiveSection("published")}
              className={`motion-list-item relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 transition-all duration-150 ${menuText} ${activeSection === "published" ? navActive : navIdle}`}
            >
              {activeSection === "published" && <span className="absolute left-0 h-4 w-0.5 rounded-full bg-[#31577d]" />}
              <Upload className="h-3 w-3 shrink-0" />
              <span className={menuText}>{labels.publishedProjects}</span>
            </button>
            <button type="button" onClick={() => openSettingsPanel("security")} className={`motion-list-item flex w-full items-center gap-2 rounded-lg px-2 py-1.5 transition-all duration-150 ${menuText} ${navIdle}`}><Shield className="h-3 w-3 shrink-0" /><span className={menuText}>{labels.security}</span></button>
            <button type="button" onClick={() => openSettingsPanel("promotions")} className={`motion-list-item flex w-full items-center gap-2 rounded-lg px-2 py-1.5 transition-all duration-150 ${menuText} ${navIdle}`}><Gift className="h-3 w-3 shrink-0" /><span className={menuText}>{labels.promotions}</span></button>
            <button type="button" onClick={() => openSettingsPanel()} className={`motion-list-item flex w-full items-center gap-2 rounded-lg px-2 py-1.5 transition-all duration-150 ${menuText} ${settingsPanelOpen ? navActive : navIdle}`}><Settings className="h-3 w-3 shrink-0" /><span className={menuText}>{labels.settings}</span></button>
          </nav>

          <div className={`mt-3 overflow-hidden rounded-2xl border px-3 py-2.5 ${isDark ? "border-[#30343d] bg-[#191c21]" : "border-[#e7ebf1] bg-[#fbfcfe]"}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
              <span className={`inline-flex h-7 w-7 items-center justify-center rounded-xl ${isDark ? "bg-[#232832] text-cyan-200" : "bg-[#eef6ff] text-[#31577d]"}`}>
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0">
                <p className={`truncate text-[11px] font-semibold leading-tight ${isDark ? "text-slate-100" : "text-slate-800"}`}>
                  {language === "tr" ? "Core kullan\u0131m\u0131" : "Core usage"}
                </p>
                <p className={`mt-0.5 truncate text-[9px] leading-tight ${isDark ? "text-slate-500" : "text-slate-500"}`}>
                  {accountBalanceText} · {apiAccessLabel}
                </p>
              </div>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold leading-none ${isDark ? "bg-[#223343] text-cyan-100" : "bg-[#edf7ff] text-[#31577d]"}`}>
                {accountUsagePercent}%
              </span>
            </div>
            <div className={`mt-3 h-1.5 overflow-hidden rounded-full ${isDark ? "bg-[#252a33]" : "bg-[#eef2f7]"}`}>
              <div className="h-full rounded-full bg-gradient-to-r from-[#31577d] via-[#12b5cb] to-[#8bd6e6] shadow-[0_0_14px_rgba(18,181,203,0.28)]" style={{ width: `${accountUsagePercent}%` }} />
            </div>
            <div className={`mt-2 flex items-center justify-between text-[9px] leading-none ${isDark ? "text-slate-500" : "text-slate-500"}`}>
              <span>{language === "tr" ? "Aylik kullanim" : "Monthly usage"}</span>
              <span>{Math.max(0, monthlyAiLimit - monthlyAiUsed)} {language === "tr" ? "kredi kald\u0131" : "credits left"}</span>
            </div>
          </div>

          <div className={`mt-auto border-t pt-3 ${isDark ? "border-[#32343b]" : "border-[#d8d8d5]"}`}>
            <div
              className={`relative overflow-hidden rounded-xl border p-3 ${
                isDark
                  ? "border-[#2f4f73] bg-gradient-to-br from-[#17365c] via-[#1f4f78] to-[#1b2638]"
                  : "border-[#b9cfe8] bg-gradient-to-br from-[#d7e9ff] via-[#eef7ff] to-[#ffffff]"
              }`}
            >
              <div className="relative z-10">
                <div className="flex items-center gap-1.5">
                  <p className={`text-[12px] font-semibold leading-none ${isDark ? "text-slate-100" : "text-slate-900"}`}>{labels.upgrade}</p>
                  <span className="rounded-[4px] bg-black px-1 py-0.5 text-[8px] font-semibold leading-none text-white">{labels.upgradeBadge}</span>
                </div>
                <p className={`mt-2 max-w-[160px] text-[9px] leading-snug ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.upgradeDesc}</p>
                <button
                  type="button"
                  onClick={() => setPricingModalOpen(true)}
                  className={`motion-interactive mt-3 flex h-8 w-full items-center justify-between rounded-lg px-2 text-[10px] font-medium ${
                    isDark ? "bg-white text-slate-900 hover:bg-slate-100" : "bg-white text-slate-800 shadow-sm hover:bg-[#fbfbff]"
                  }`}
                >
                  <span>{labels.learnMore}</span>
                  <span className="text-[13px] leading-none">↗</span>
                </button>
              </div>
              <div className="pointer-events-none absolute -right-8 -top-8 h-20 w-20 rounded-full bg-white/35 blur-2xl" />
              <div className="pointer-events-none absolute -bottom-10 left-5 h-16 w-24 rounded-full bg-[#4aa3ff]/30 blur-2xl" />
            </div>
          </div>
        </div>
      </aside>

      <main
        className={`project-theme-main min-h-screen pb-16 ${isDark ? "bg-[#222223]" : "bg-white"}`}
      >
        <div className="fixed right-3 top-3 z-50 sm:right-4 lg:right-7">
          <button
            type="button"
            onClick={() => openSettingsPanel("profile")}
            className={`motion-interactive flex min-w-0 items-center justify-between rounded-full border px-2 py-2 text-left shadow-sm transition-colors sm:min-w-[240px] sm:rounded-[18px] sm:px-4 ${
              isDark
                ? "border-[#3b4049] bg-[#1e1e1f] hover:bg-[#262930]"
                : "border-[#d7d9de] bg-[#f4f4f5] hover:bg-[#ececee]"
            }`}
          >
            <div className="hidden min-w-0 sm:block">
              <p className={`truncate text-[14px] font-semibold leading-tight ${isDark ? "text-slate-100" : "text-[#1f2937]"}`}>
                {profileDisplayName || accountName}
              </p>
              <p className={`truncate text-[11px] leading-tight ${isDark ? "text-slate-400" : "text-[#6b7280]"}`}>
                {profileEmail}
              </p>
            </div>

            <div className="sm:ml-3">
              {displayedProfileAvatarUrl ? (
                <img
                  src={displayedProfileAvatarUrl}
                  alt="Profile avatar"
                  className="h-8 w-8 rounded-full border border-white/70 object-cover"
                />
              ) : (
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#ef4444] to-[#111827] text-xs font-semibold text-white">
                  {workspaceInitials}
                </span>
              )}
            </div>
          </button>
        </div>
        <div
          className={`hover-sidebar-page ${isSidebarHoverOpen ? "hover-sidebar-page--open" : "hover-sidebar-page--closed"} mx-auto w-full max-w-6xl px-4 sm:px-6`}
        >
          {children}
        </div>
      </main>

      {settingsPanelOpen && (
        <div
          className={`motion-overlay fixed inset-0 z-[75] px-2 py-3 backdrop-blur-[2px] sm:px-4 sm:py-10 ${settingsPanelVisible ? "bg-black/45 opacity-100" : "bg-black/0 opacity-0"}`}
          onClick={closeSettingsPanel}
        >
          <div
            className={`motion-modal-panel mx-auto flex h-[calc(100dvh-24px)] w-full max-w-[1600px] flex-col overflow-hidden rounded-xl border shadow-2xl sm:h-[calc(100vh-96px)] sm:rounded-2xl ${settingsPanelVisible ? "translate-y-0 scale-100 opacity-100" : "translate-y-3 scale-[0.985] opacity-0"} ${isDark ? "border-[#31343b] bg-[#1e1e1f]" : "border-[#d8dbe2] bg-white"}`}
            onClick={(e) => e.stopPropagation()}
          >
            <header className={`flex items-center justify-between border-b px-3 py-2 sm:px-5 sm:py-3 ${isDark ? "border-[#2f3238]" : "border-[#e1e5ec]"}`}>
              <h2 className={`inline-flex items-center gap-2 text-[22px] font-semibold sm:text-[36px] ${isDark ? "text-slate-100" : "text-slate-800"}`}><Settings className="h-5 w-5 sm:h-7 sm:w-7" />{labels.settings}</h2>
              <button type="button" onClick={closeSettingsPanel} className={`motion-icon-interactive rounded-md p-2 transition-colors ${isDark ? "text-slate-300 hover:bg-[#262930]" : "text-slate-600 hover:bg-[#f4f6fa]"}`} aria-label={labels.close}><X className="h-5 w-5 sm:h-6 sm:w-6" /></button>
            </header>

            <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr] md:grid-cols-[320px_1fr] md:grid-rows-none">
              <SettingsSidebar
                isDark={isDark}
                settingsPanelSection={settingsPanelSection}
                switchSettingsPanelSection={switchSettingsPanelSection}
                workspaceInitials={workspaceInitials}
                profileAvatarDataUrl={displayedProfileAvatarUrl}
                labels={labels}
                closeSettingsPanel={closeSettingsPanel}
                hasPaidPlan={hasPaidPlan}
              />

              <main className="overflow-y-auto p-4 sm:p-6 md:p-8">
                <div className={`motion-tab-panel ${settingsContentVisible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"}`}>
                  {displayedSettingsPanelSection === "usage" && (
                    <WorkspaceUsageSection isDark={isDark} labels={labels} />
                  )}
                  {displayedSettingsPanelSection === "security" && (
                    <SecuritySection
                      isDark={isDark}
                      labels={labels}
                      twoFactorEnabled={twoFactorEnabled}
                      setTwoFactorEnabled={handleTwoFactorChange}
                      loginAlertsEnabled={loginAlertsEnabled}
                      setLoginAlertsEnabled={handleLoginAlertsChange}
                    />
                  )}
                  {displayedSettingsPanelSection === "billing" && (
                    <BillingSection
                      isDark={isDark}
                      labels={labels}
                      activePlanLabel={activePlanLabel}
                      onOpenPricing={() => setPricingModalOpen(true)}
                    />
                  )}
                  {displayedSettingsPanelSection === "accountSeats" && (
                    <AccountSeatsSection
                      isDark={isDark}
                      labels={labels}
                      activePlanLabel={activePlanLabel}
                      onManagePlan={() => setPricingModalOpen(true)}
                    />
                  )}
                  {displayedSettingsPanelSection === "accountUsage" && hasPaidPlan && (
                    <AccountUsageSection
                      isDark={isDark}
                      labels={labels}
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
                      labels={labels}
                      theme={theme}
                      setTheme={setTheme}
                      language={language}
                      setLanguage={setLanguage}
                      notificationsEnabled={notificationsEnabled}
                      setNotificationsEnabled={handleNotificationsChange}
                    />
                  )}
                  {displayedSettingsPanelSection === "advanced" && (
                    <AdvancedSection
                      isDark={isDark}
                      labels={labels}
                      onResetPreferences={handleResetPreferences}
                    />
                  )}
                  {displayedSettingsPanelSection === "promotions" && (
                    <PromotionsSection
                      isDark={isDark}
                      labels={labels}
                      referralSummary={referralSummary}
                      isLoadingReferralSummary={isLoadingReferralSummary}
                      referralSummaryError={referralSummaryError}
                      onCopyReferralCode={copyToClipboard}
                      onCopyReferralLink={copyToClipboard}
                    />
                  )}
                  {displayedSettingsPanelSection === "profile" && (
                    <ProfileSection
                      isDark={isDark}
                      labels={labels}
                      workspaceInitials={workspaceInitials}
                      profileAvatarDataUrl={displayedProfileAvatarUrl}
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
          labels={labels}
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
