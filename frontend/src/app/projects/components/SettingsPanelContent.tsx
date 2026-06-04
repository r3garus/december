"use client";

import {
  Activity,
  Bell,
  Check,
  Copy,
  CreditCard,
  Crown,
  Database,
  Gauge,
  Gift,
  Languages,
  Mail,
  Pencil,
  RotateCcw,
  Settings,
  Shield,
  Sparkles,
  User,
  Users,
  X,
} from "lucide-react";
import { ChangeEvent, useEffect, useState } from "react";
import type { AccountEntitlementsSnapshot } from "@/lib/account/types";
import type { UiLanguage, UiTheme } from "./ProjectsPage";

export const SETTINGS_INVITE_STORAGE_KEY = "december:settings:pending-invite";
export const SETTINGS_SIGNED_OUT_STORAGE_KEY = "december:settings:sessions-cleared";
export const SETTINGS_PROFILE_EMAIL_STORAGE_KEY = "december:settings:profile-email";
export const SETTINGS_PASSWORD_UPDATED_STORAGE_KEY =
  "december:settings:password-updated-at";
export const SETTINGS_BONUS_CLAIMED_STORAGE_KEY =
  "december:settings:bonus-claimed";

export const SETTINGS_LOCAL_STORAGE_KEYS = [
  SETTINGS_INVITE_STORAGE_KEY,
  SETTINGS_SIGNED_OUT_STORAGE_KEY,
  SETTINGS_PROFILE_EMAIL_STORAGE_KEY,
  SETTINGS_PASSWORD_UPDATED_STORAGE_KEY,
  SETTINGS_BONUS_CLAIMED_STORAGE_KEY,
] as const;

const readStoredSetting = (key: string, fallback = "") => {
  if (typeof window === "undefined") return fallback;
  return window.localStorage.getItem(key) || fallback;
};

const writeStoredSetting = (key: string, value: string) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, value);
};

const removeStoredSetting = (key: string) => {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(key);
};

const readStoredBoolean = (key: string, fallback = false) => {
  const storedValue = readStoredSetting(key);
  if (storedValue === "true") return true;
  if (storedValue === "false") return false;
  return fallback;
};

export interface ReferralSummary {
  referralCode: string;
  referralLink: string;
  successfulReferrals: number;
  pendingReferrals: number;
  totalRewardsUsd: number;
  pendingRewardsUsd: number;
  rewardPerConversionUsd: number;
}

interface Labels {
  workspaceLabel: string;
  workspaceCollaborators: string;
  integrations: string;
  workspaceUsage: string;
  security: string;
  accountLabel: string;
  billing: string;
  accountSeats: string;
  accountUsage: string;
  advanced: string;
  userLabel: string;
  profile: string;
  preferences: string;
  notifications: string;
  notificationsDesc: string;
  themePreference: string;
  themePreferenceDesc: string;
  languagePreference: string;
  languagePreferenceDesc: string;
  light: string;
  dark: string;
  language: string;
  promotionsAndReferrals: string;
  workspace: string;
  settings: string;
  close: string;
  securityCenter: string;
  securityDesc: string;
  securityScore: string;
  recommended: string;
  activeSessions: string;
  activeSessionsDesc: string;
  deviceThisBrowser: string;
  lastActiveNow: string;
  twoFactorAuth: string;
  twoFactorDesc: string;
  loginAlerts: string;
  loginAlertsDesc: string;
  signOutOthers: string;
  billing_: string;
  viewPreviousInvoices: string;
  billingUsageDelay: string;
  currentPlan: string;
  freePlan: string;
  paymentMethod: string;
  noPaymentMethod: string;
  changePlan: string;
  changePlanDesc: string;
  billingUpgrade: string;
  promotionsHub: string;
  promotionsDesc: string;
  featuredOffer: string;
  offerDesc: string;
  claimOffer: string;
  campaignPerformance: string;
  campaignReady: string;
  referrals: string;
  referralDesc: string;
  referralCode: string;
  rewardRule: string;
  successfulReferrals: string;
  pendingReferrals: string;
  totalRewards: string;
  pendingRewards: string;
  copyCode: string;
  copyLink: string;
  bonusCta: string;
  updatesMayDelay: string;
  viewAllUsage: string;
  totalUsage: string;
  agentUsers: string;
  agentUsage: string;
  noAgentUsage: string;
  noAgentUsageDesc: string;
  username: string;
  firstName: string;
  lastName: string;
  bio: string;
  addBio: string;
  saveChanges: string;
  viewPublicProfile: string;
  yourEmail: string;
  yourPassword: string;
  edit: string;
  comparePlans: string;
  compareSubtitle: string;
  monthly: string;
  yearly: string;
  yearlyDiscount: string;
  starter: string;
  corePlan: string;
  proPlan: string;
  enterprise: string;
  continueCore: string;
  continuePro: string;
  contactSales: string;
  pricingFootnote: string;
  personal: string;
  team: string;
  createWorkspace: string;
  core: string;
  workspaceCardTitle: string;
  workspaceCardText: string;
  personalSubtitle: string;
  teamSubtitle: string;
  workspaceOwner: string;
  useWorkspace: string;
  manageTeam: string;
}

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

interface SettingsSidebarProps {
  isDark: boolean;
  settingsPanelSection: SettingsPanelSection;
  switchSettingsPanelSection: (s: SettingsPanelSection) => void;
  workspaceInitials: string;
  profileAvatarDataUrl: string | null;
  labels: any;
  closeSettingsPanel: () => void;
  hasPaidPlan: boolean;
}

export const SettingsSidebar = ({
  isDark,
  settingsPanelSection,
  switchSettingsPanelSection,
  workspaceInitials,
  profileAvatarDataUrl,
  labels,
  hasPaidPlan,
}: SettingsSidebarProps) => {
  const sectionClass = (section: SettingsPanelSection) =>
    `motion-list-item flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left ${
      settingsPanelSection === section
        ? isDark
          ? "bg-[#262930] text-slate-100"
          : "bg-[#f8fafc] text-slate-800 shadow-sm"
        : isDark
          ? "text-slate-200 hover:bg-[#262930]"
          : "text-slate-700 hover:bg-[#f8fafc]"
    }`;

  const groups = [
    {
      label: labels.workspaceLabel,
      items: [
        { section: "usage" as const, icon: Gauge, label: labels.workspaceUsage },
        { section: "security" as const, icon: Shield, label: labels.security },
      ],
    },
    {
      label: labels.accountLabel,
      items: [
        { section: "billing" as const, icon: CreditCard, label: labels.billing },
        { section: "accountSeats" as const, icon: Users, label: labels.accountSeats },
        ...(hasPaidPlan
          ? [{ section: "accountUsage" as const, icon: Gauge, label: labels.accountUsage }]
          : []),
        { section: "advanced" as const, icon: Settings, label: labels.advanced },
      ],
    },
    {
      label: labels.userLabel,
      items: [
        { section: "profile" as const, icon: User, label: labels.profile },
        { section: "preferences" as const, icon: Settings, label: labels.preferences },
        { section: "promotions" as const, icon: Gift, label: labels.promotionsAndReferrals },
      ],
    },
  ];

  return (
    <aside className={`max-h-[34dvh] overflow-y-auto border-b px-3 py-3 md:max-h-none md:border-b-0 md:border-r md:py-4 ${isDark ? "border-[#2f3238] bg-[#222223]" : "border-[#e1e5ec] bg-white"}`}>
      <button type="button" onClick={() => switchSettingsPanelSection("profile")} className={`motion-interactive mb-3 flex w-full items-center justify-between rounded-full px-2.5 py-1.5 text-left text-[12px] md:mb-4 ${isDark ? "bg-[#262930] text-slate-100" : "bg-[#f8fafc] text-slate-700"}`}>
        <span className="inline-flex min-w-0 items-center gap-2">
          {profileAvatarDataUrl ? (
            <img src={profileAvatarDataUrl} alt="Profile avatar" className="h-5 w-5 rounded-full object-cover" />
          ) : (
            <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${isDark ? "bg-[#3f526f]" : "bg-[#d0d0cd]"}`}>{workspaceInitials}</span>
          )}
          <span className="truncate">{labels.workspace}</span>
        </span>
      </button>

      <div className="grid gap-3 text-[12px] sm:grid-cols-3 md:block md:space-y-4">
        {groups.map((group) => (
          <div key={group.label}>
            <p className={`mb-2 px-1 ${isDark ? "text-slate-400" : "text-slate-500"}`}>{group.label}</p>
            <div className="flex gap-1 overflow-x-auto pb-1 md:block md:space-y-1 md:overflow-visible md:pb-0">
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.section}
                    type="button"
                    onClick={() => switchSettingsPanelSection(item.section)}
                    className={`${sectionClass(item.section)} w-auto shrink-0 whitespace-nowrap md:w-full md:shrink`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
};
interface SecuritySectionProps { isDark: boolean; labels: any; twoFactorEnabled: boolean; setTwoFactorEnabled: (v: boolean) => void; loginAlertsEnabled: boolean; setLoginAlertsEnabled: (v: boolean) => void; }
export const SecuritySection = ({ isDark, labels, twoFactorEnabled, setTwoFactorEnabled, loginAlertsEnabled, setLoginAlertsEnabled }: SecuritySectionProps) => {
  const [signedOutOthers, setSignedOutOthers] = useState(() =>
    readStoredBoolean(SETTINGS_SIGNED_OUT_STORAGE_KEY)
  );

  const handleSignOutOthers = () => {
    setSignedOutOthers(true);
    writeStoredSetting(SETTINGS_SIGNED_OUT_STORAGE_KEY, "true");
  };

  return (
    <>
      <h3 className={`mb-2 inline-flex items-center gap-2 text-[24px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}><Shield className="h-5 w-5" />{labels.securityCenter}</h3>
      <p className={`mb-6 text-[14px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.securityDesc}</p>
      <div className="mb-4 grid max-w-3xl gap-3 sm:grid-cols-2">
        <article className={`motion-card rounded-xl border p-4 ${isDark ? "border-[#3a3d46] bg-gradient-to-b from-[#222223] to-[#222223]" : "border-[#d5d7dc] bg-gradient-to-b from-white to-[#f9fbff]"}`}>
          <p className={`text-[13px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{labels.securityScore}</p>
          <p className={`mt-1 text-[22px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>{twoFactorEnabled && loginAlertsEnabled ? "96/100" : twoFactorEnabled || loginAlertsEnabled ? "86/100" : "72/100"}</p>
          <span className={`mt-3 inline-flex rounded-full px-2 py-1 text-[11px] ${isDark ? "bg-[#233247] text-[#9cc4ee]" : "bg-[#eaf2fb] text-[#31577d]"}`}>{labels.recommended}</span>
        </article>
        <article className={`motion-card rounded-xl border p-4 ${isDark ? "border-[#3a3d46] bg-gradient-to-b from-[#222223] to-[#222223]" : "border-[#d5d7dc] bg-gradient-to-b from-white to-[#f9fbff]"}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className={`text-[15px] font-medium ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.activeSessions}</p>
              <p className={`mt-1 text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.activeSessionsDesc}</p>
            </div>
            <span className={`rounded-full px-2 py-1 text-[10px] ${signedOutOthers ? isDark ? "bg-emerald-400/10 text-emerald-200" : "bg-emerald-50 text-emerald-700" : isDark ? "bg-[#222223] text-slate-400" : "bg-slate-100 text-slate-500"}`}>
              {signedOutOthers ? labels.secured || "Secured" : "2"}
            </span>
          </div>
          <div className={`mt-3 rounded-md border px-3 py-2 text-[12px] ${isDark ? "border-[#2f3238] bg-[#222223] text-slate-300" : "border-[#e7ecf3] bg-[#f5f7fa] text-slate-600"}`}>
            <p className="font-medium">{labels.deviceThisBrowser}</p>
            <p className="mt-0.5">{labels.lastActiveNow}</p>
          </div>
          <button
            type="button"
            onClick={handleSignOutOthers}
            disabled={signedOutOthers}
            className={`motion-interactive mt-3 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] disabled:cursor-default disabled:opacity-70 ${isDark ? "border-[#3a3d46] bg-[#222223] text-slate-200 hover:bg-[#2d3340]" : "border-[#d7dce5] bg-white text-slate-700 hover:bg-[#f8fbff]"}`}
          >
            <Check className="h-3.5 w-3.5" />
            {signedOutOthers ? labels.otherSessionsSignedOut || "Other sessions signed out" : labels.signOutOthers}
          </button>
        </article>
      </div>
      <div className="max-w-3xl space-y-3">
        <div className={`motion-card flex items-center justify-between rounded-xl border p-4 ${isDark ? "border-[#3a3d46] bg-[#222223]" : "border-[#d5d7dc] bg-white"}`}>
          <div>
            <p className={`text-[15px] font-medium ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.twoFactorAuth}</p>
            <p className={`mt-1 text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.twoFactorDesc}</p>
          </div>
          <button type="button" aria-pressed={twoFactorEnabled} onClick={() => setTwoFactorEnabled(!twoFactorEnabled)} className={`motion-interactive relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-150 ease-out ${twoFactorEnabled ? "bg-[#31577d]" : isDark ? "bg-[#2b2f38]" : "bg-[#d1d5db]"}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-150 ease-out ${twoFactorEnabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>
        <div className={`motion-card flex items-center justify-between rounded-xl border p-4 ${isDark ? "border-[#3a3d46] bg-[#222223]" : "border-[#d5d7dc] bg-white"}`}>
          <div>
            <p className={`text-[15px] font-medium ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.loginAlerts}</p>
            <p className={`mt-1 text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.loginAlertsDesc}</p>
          </div>
          <button type="button" aria-pressed={loginAlertsEnabled} onClick={() => setLoginAlertsEnabled(!loginAlertsEnabled)} className={`motion-interactive relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-150 ease-out ${loginAlertsEnabled ? "bg-[#31577d]" : isDark ? "bg-[#2b2f38]" : "bg-[#d1d5db]"}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-150 ease-out ${loginAlertsEnabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>
      </div>
    </>
  );
};

interface PreferencesSectionProps {
  isDark: boolean;
  labels: any;
  theme: UiTheme;
  setTheme: (theme: UiTheme) => void;
  language: UiLanguage;
  setLanguage: (language: UiLanguage) => void;
  notificationsEnabled: boolean;
  setNotificationsEnabled: (enabled: boolean) => void;
}

export const PreferencesSection = ({
  isDark,
  labels,
  theme,
  setTheme,
  language,
  setLanguage,
  notificationsEnabled,
  setNotificationsEnabled,
}: PreferencesSectionProps) => (
  <>
    <h3 className={`mb-5 inline-flex items-center gap-2 text-[13px] font-semibold ${isDark ? "text-slate-100" : "text-slate-700"}`}>
      <Settings className="h-4 w-4" />
      {labels.preferences}
    </h3>
    <div className="max-w-3xl space-y-3">
      <div className={`flex items-center justify-between rounded-xl border p-4 ${isDark ? "border-[#3a3d46] bg-[#222223]" : "border-[#d5d7dc] bg-white"}`}>
        <div className="flex items-start gap-3">
          <Bell className={`mt-0.5 h-4 w-4 ${isDark ? "text-slate-300" : "text-slate-600"}`} />
          <div>
            <p className={`text-[15px] font-medium ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.notifications}</p>
            <p className={`mt-1 text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.notificationsDesc}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setNotificationsEnabled(!notificationsEnabled)}
          className={`motion-interactive relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-150 ease-out ${notificationsEnabled ? "bg-[#31577d]" : isDark ? "bg-[#2b2f38]" : "bg-[#d1d5db]"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-150 ease-out ${notificationsEnabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </div>

      <div className={`rounded-xl border p-4 ${isDark ? "border-[#3a3d46] bg-[#222223]" : "border-[#d5d7dc] bg-white"}`}>
        <div className="mb-3 flex items-start gap-3">
          <Settings className={`mt-0.5 h-4 w-4 ${isDark ? "text-slate-300" : "text-slate-600"}`} />
          <div>
            <p className={`text-[15px] font-medium ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.themePreference}</p>
            <p className={`mt-1 text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.themePreferenceDesc}</p>
          </div>
        </div>
        <div className={`inline-flex rounded-[10px] border p-0.5 ${isDark ? "border-[#343943] bg-[#222223]" : "border-[#dce2eb] bg-[#f8fafc]"}`}>
          {(["light", "dark"] as UiTheme[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setTheme(mode)}
              className={`h-7 rounded-[8px] px-3 text-[11px] font-medium leading-none transition-colors ${
                theme === mode
                  ? isDark
                    ? "bg-[#31577d] text-white"
                    : "bg-white text-slate-900 shadow-sm"
                  : isDark
                    ? "text-slate-300 hover:text-white"
                    : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {mode === "light" ? labels.light : labels.dark}
            </button>
          ))}
        </div>
      </div>

      <div className={`rounded-xl border p-4 ${isDark ? "border-[#3a3d46] bg-[#222223]" : "border-[#d5d7dc] bg-white"}`}>
        <div className="mb-3 flex items-start gap-3">
          <Languages className={`mt-0.5 h-4 w-4 ${isDark ? "text-slate-300" : "text-slate-600"}`} />
          <div>
            <p className={`text-[15px] font-medium ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.languagePreference}</p>
            <p className={`mt-1 text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.languagePreferenceDesc}</p>
          </div>
        </div>
        <div className={`inline-flex rounded-[10px] border p-0.5 ${isDark ? "border-[#343943] bg-[#222223]" : "border-[#dce2eb] bg-[#f8fafc]"}`}>
          {(["en", "tr"] as UiLanguage[]).map((lang) => (
            <button
              key={lang}
              type="button"
              onClick={() => setLanguage(lang)}
              className={`h-7 rounded-[8px] px-3 text-[11px] font-medium leading-none transition-colors ${
                language === lang
                  ? isDark
                    ? "bg-[#31577d] text-white"
                    : "bg-white text-slate-900 shadow-sm"
                  : isDark
                    ? "text-slate-300 hover:text-white"
                    : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {lang.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </div>
  </>
);

interface WorkspaceUsageSectionProps { isDark: boolean; labels: any; }
export const WorkspaceUsageSection = ({ isDark, labels }: WorkspaceUsageSectionProps) => {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <>
      <h3 className={`mb-2 inline-flex items-center gap-2 text-[24px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>
        <Gauge className="h-5 w-5" />
        {labels.workspaceUsage}
      </h3>
      <p className={`mb-6 text-[14px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>
        {labels.updatesMayDelay}{" "}
        <button type="button" onClick={() => setShowDetails((current) => !current)} className={`motion-interactive ${isDark ? "text-[#7eb6ff]" : "text-[#2563eb]"}`}>
          {showDetails ? labels.hideUsageDetails || "Hide usage details" : labels.viewAllUsage}
        </button>
      </p>
      <div className="mb-7 grid max-w-2xl gap-3 sm:grid-cols-2">
        <article className={`motion-card rounded-xl border px-4 py-3 ${isDark ? "border-[#3a3d46] bg-[#222223]" : "border-[#d5d7dc] bg-white"}`}>
          <div className="flex items-center justify-between">
            <p className={`text-[26px] font-semibold leading-none ${isDark ? "text-slate-100" : "text-slate-800"}`}>$0</p>
            <p className={`text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>May 27 - May 27</p>
          </div>
          <p className={`mt-2 text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.totalUsage}</p>
        </article>
        <article className={`motion-card rounded-xl border px-4 py-3 ${isDark ? "border-[#3a3d46] bg-[#222223]" : "border-[#d5d7dc] bg-white"}`}>
          <p className={`text-[26px] font-semibold leading-none ${isDark ? "text-slate-100" : "text-slate-800"}`}>0</p>
          <p className={`mt-2 text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.agentUsers}</p>
        </article>
      </div>
      {showDetails && (
        <div className={`motion-tab-panel mb-7 max-w-3xl rounded-2xl border p-4 ${isDark ? "border-[#343944] bg-[#222223]" : "border-[#dde5ef] bg-white"}`}>
          {[
            { label: labels.accountUsageAiRequests || "Core credits", value: "0 / 100" },
            { label: labels.accountUsageImages || "Image references", value: "0 / 20" },
            { label: labels.accountUsageProjects || "Project builds", value: "0 / 12" },
          ].map((row) => (
            <div key={row.label} className={`flex items-center justify-between border-b py-2 last:border-0 ${isDark ? "border-white/10" : "border-slate-100"}`}>
              <span className={`text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{row.label}</span>
              <span className={`rounded-full px-2.5 py-1 text-[11px] ${isDark ? "bg-[#222223] text-slate-300" : "bg-slate-100 text-slate-600"}`}>{row.value}</span>
            </div>
          ))}
        </div>
      )}
      <div>
        <h4 className={`mb-3 text-[22px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.agentUsage}</h4>
        <article className={`rounded-xl border p-7 text-center ${isDark ? "border-[#3a3d46] bg-[#222223]" : "border-[#d5d7dc] bg-white"}`}>
          <div className={`mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full border ${isDark ? "border-[#4a4e59] text-slate-300" : "border-[#d0d5de] text-slate-500"}`}>
            <Gauge className="h-4 w-4" />
          </div>
          <p className={`text-[32px] font-semibold leading-none ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.noAgentUsage}</p>
          <p className={`mx-auto mt-3 max-w-xl text-[14px] ${isDark ? "text-slate-400" : "text-slate-600"}`}>{labels.noAgentUsageDesc}</p>
        </article>
      </div>
    </>
  );
};

interface AccountUsageSectionProps { isDark: boolean; labels: any; activePlan: string; activePlanLabel: string; billingCycle: BillingCycle; onManagePlan: () => void; accountEntitlements?: AccountEntitlementsSnapshot | null; }
export const AccountUsageSection = ({ isDark, labels, activePlan, activePlanLabel, billingCycle, onManagePlan, accountEntitlements }: AccountUsageSectionProps) => {
  const staticPlanUsage = {
    core: { requests: 62, requestsLimit: 100, images: 8, imagesLimit: 20, projects: 5, projectsLimit: 12, soft: 72, hard: 88 },
    pro: { requests: 148, requestsLimit: 250, images: 21, imagesLimit: 60, projects: 14, projectsLimit: 35, soft: 64, hard: 79 },
    enterprise: { requests: 640, requestsLimit: 1000, images: 92, imagesLimit: 220, projects: 48, projectsLimit: 120, soft: 58, hard: 71 },
  }[activePlan] || { requests: 0, requestsLimit: 1, images: 0, imagesLimit: 1, projects: 0, projectsLimit: 1, soft: 0, hard: 0 };
  const entitlementPercent =
    accountEntitlements && accountEntitlements.monthlyAiLimit > 0
      ? Math.min(100, Math.round((accountEntitlements.monthlyAiUsed / accountEntitlements.monthlyAiLimit) * 100))
      : null;
  const planUsage = accountEntitlements
    ? {
        ...staticPlanUsage,
        requests: accountEntitlements.monthlyAiUsed,
        requestsLimit: Math.max(1, accountEntitlements.monthlyAiLimit),
        soft: entitlementPercent ?? staticPlanUsage.soft,
        hard: entitlementPercent === null ? staticPlanUsage.hard : Math.min(100, entitlementPercent + 12),
      }
    : staticPlanUsage;
  const balanceCredits = (accountEntitlements?.balanceCents || 0) / 100;
  const balanceText = `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: balanceCredits % 1 === 0 ? 0 : 1,
  }).format(balanceCredits)} Klawpen Core credits`;
  const apiAccessText = accountEntitlements?.apiAccessEnabled
    ? labels.apiAccessEnabled || "Klawpen Core enabled"
    : labels.apiAccessDisabled || "Klawpen Core disabled";

  const usageRows = [
    { label: labels.accountUsageAiRequests, value: planUsage.requests, limit: planUsage.requestsLimit },
    { label: labels.accountUsageImages, value: planUsage.images, limit: planUsage.imagesLimit },
    { label: labels.accountUsageProjects, value: planUsage.projects, limit: planUsage.projectsLimit },
  ];

  const trendBars = activePlan === "enterprise" ? [42, 56, 38, 68, 74, 59, 82] : activePlan === "pro" ? [28, 46, 35, 58, 64, 51, 68] : [18, 34, 29, 45, 52, 39, 62];
  const modelMix = activePlan === "enterprise" ? ["42%", "35%", "23%"] : activePlan === "pro" ? ["51%", "31%", "18%"] : ["64%", "24%", "12%"];

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className={`inline-flex items-center gap-2 text-[28px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>
            <Gauge className="h-6 w-6" />
            {labels.accountUsageTitle}
          </h3>
          <p className={`mt-2 max-w-3xl text-[14px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.accountUsageSubtitle}</p>
        </div>
        <button
          type="button"
          onClick={onManagePlan}
          className={`motion-interactive rounded-xl border px-3 py-2 text-[12px] font-medium ${isDark ? "border-[#3a3d46] bg-[#222223] text-slate-100 hover:bg-[#2d3340]" : "border-[#d7dce5] bg-white text-slate-700 shadow-sm hover:bg-[#f8fbff]"}`}
        >
          {labels.managePlan}
        </button>
      </div>

      <section className={`motion-card relative mb-4 overflow-hidden rounded-3xl border p-5 ${isDark ? "border-[#334156] bg-gradient-to-br from-[#222223] via-[#222223] to-[#222223]" : "border-[#d8e5f5] bg-gradient-to-br from-white via-[#f7fbff] to-[#eef6ff]"}`}>
        <div className="relative z-10 grid gap-4 md:grid-cols-[1.25fr_0.75fr]">
          <div>
            <p className={`text-[11px] uppercase tracking-[0.16em] ${isDark ? "text-cyan-100/70" : "text-[#31577d]/70"}`}>{labels.accountUsagePlan}</p>
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <h4 className={`text-[42px] font-semibold leading-none ${isDark ? "text-white" : "text-slate-900"}`}>{activePlanLabel}</h4>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${isDark ? "bg-cyan-300/10 text-cyan-100" : "bg-[#eaf4ff] text-[#31577d]"}`}>
                {billingCycle === "yearly" ? labels.yearly : labels.monthly}
              </span>
            </div>
            <p className={`mt-3 text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{labels.accountUsageUpdated}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${isDark ? "bg-white/[0.045] text-slate-300" : "bg-white/80 text-slate-600"}`}>
                {labels.accountBalance || "Balance"}: {balanceText}
              </span>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${accountEntitlements?.apiAccessEnabled ? isDark ? "bg-emerald-400/10 text-emerald-200" : "bg-emerald-50 text-emerald-700" : isDark ? "bg-white/[0.045] text-slate-400" : "bg-slate-100 text-slate-500"}`}>
                {apiAccessText}
              </span>
            </div>
          </div>

          <div className={`rounded-2xl border p-3 ${isDark ? "border-white/10 bg-white/[0.035]" : "border-[#d9e7f6] bg-white/75"}`}>
            <div className="flex items-center justify-between">
              <span className={`text-[12px] font-medium ${isDark ? "text-slate-200" : "text-slate-700"}`}>{labels.accountUsageSoftLimit}</span>
              <span className={`text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{planUsage.soft}%</span>
            </div>
            <div className={`mt-2 h-2 overflow-hidden rounded-full ${isDark ? "bg-[#222223]" : "bg-[#e8eef6]"}`}>
              <div className="account-usage-fill h-full rounded-full bg-gradient-to-r from-[#31577d] via-[#12b5cb] to-[#8bd6e6]" style={{ width: `${planUsage.soft}%` }} />
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className={`text-[12px] font-medium ${isDark ? "text-slate-200" : "text-slate-700"}`}>{labels.accountUsageHardLimit}</span>
              <span className={`text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{planUsage.hard}%</span>
            </div>
            <div className={`mt-2 h-2 overflow-hidden rounded-full ${isDark ? "bg-[#222223]" : "bg-[#e8eef6]"}`}>
              <div className="account-usage-fill h-full rounded-full bg-gradient-to-r from-[#31577d] to-[#2563eb]" style={{ width: `${planUsage.hard}%` }} />
            </div>
          </div>
        </div>
        <div className="pointer-events-none absolute -right-12 -top-16 h-40 w-40 rounded-full bg-[#12b5cb]/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-16 left-8 h-32 w-48 rounded-full bg-[#31577d]/15 blur-3xl" />
      </section>

      <div className="mb-4 grid gap-3 lg:grid-cols-3">
        {usageRows.map((row) => {
          const percent = Math.min(100, Math.round((row.value / row.limit) * 100));
          return (
            <article key={row.label} className={`motion-card rounded-2xl border p-4 ${isDark ? "border-[#343944] bg-[#222223]" : "border-[#dde5ef] bg-white"}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className={`text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{row.label}</p>
                  <p className={`mt-2 text-[26px] font-semibold leading-none ${isDark ? "text-slate-100" : "text-slate-800"}`}>{row.value}<span className={`text-[13px] font-medium ${isDark ? "text-slate-500" : "text-slate-400"}`}>/{row.limit}</span></p>
                </div>
                <span className={`rounded-full px-2 py-1 text-[10px] font-medium ${isDark ? "bg-[#243143] text-cyan-100" : "bg-[#eef6ff] text-[#31577d]"}`}>{100 - percent}% {labels.accountUsageRemaining}</span>
              </div>
              <div className={`mt-4 h-2 overflow-hidden rounded-full ${isDark ? "bg-[#222223]" : "bg-[#eef3f8]"}`}>
                <div className="account-usage-fill h-full rounded-full bg-gradient-to-r from-[#31577d] to-[#12b5cb]" style={{ width: `${percent}%` }} />
              </div>
            </article>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <article className={`motion-card rounded-2xl border p-4 ${isDark ? "border-[#343944] bg-[#222223]" : "border-[#dde5ef] bg-white"}`}>
          <div className="mb-4 flex items-center justify-between">
            <p className={`text-[15px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.accountUsageTrend}</p>
            <span className={`text-[11px] ${isDark ? "text-slate-500" : "text-slate-500"}`}>7d</span>
          </div>
          <div className="flex h-36 items-end gap-2">
            {trendBars.map((height, index) => (
              <div key={`${height}-${index}`} className={`flex-1 overflow-hidden rounded-t-xl ${isDark ? "bg-[#222223]" : "bg-[#eef3f8]"}`}>
                <div className="account-usage-bar rounded-t-xl bg-gradient-to-t from-[#31577d] to-[#12b5cb]" style={{ height: `${height}%`, animationDelay: `${index * 70}ms` }} />
              </div>
            ))}
          </div>
        </article>

        <article className={`motion-card rounded-2xl border p-4 ${isDark ? "border-[#343944] bg-[#222223]" : "border-[#dde5ef] bg-white"}`}>
          <p className={`text-[15px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.accountUsageModelMix}</p>
          <div className="mt-4 space-y-3">
            {["Klawpen Fast", "Klawpen Core", "Klawpen Deep"].map((name, index) => (
              <div key={name}>
                <div className="flex items-center justify-between text-[12px]">
                  <span className={isDark ? "text-slate-300" : "text-slate-600"}>{name}</span>
                  <span className={isDark ? "text-slate-500" : "text-slate-500"}>{modelMix[index]}</span>
                </div>
                <div className={`mt-1.5 h-1.5 overflow-hidden rounded-full ${isDark ? "bg-[#222223]" : "bg-[#eef3f8]"}`}>
                  <div className="account-usage-fill h-full rounded-full bg-gradient-to-r from-[#31577d] to-[#12b5cb]" style={{ width: modelMix[index] }} />
                </div>
              </div>
            ))}
          </div>
        </article>
      </div>
    </>
  );
};

interface AccountSeatsSectionProps { isDark: boolean; labels: any; activePlanLabel: string; onManagePlan: () => void; }
export const AccountSeatsSection = ({ isDark, labels, activePlanLabel, onManagePlan }: AccountSeatsSectionProps) => {
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [pendingInviteEmail, setPendingInviteEmail] = useState(() =>
    readStoredSetting(SETTINGS_INVITE_STORAGE_KEY)
  );
  const seats = [
    { name: "Kaichen Yilmaz", email: "kaichen@icloud.com", role: labels.owner, status: labels.active },
    pendingInviteEmail
      ? { name: labels.pendingInvite || "Pending invite", email: pendingInviteEmail, role: labels.collaborator, status: labels.inviteSent || "Invite sent" }
      : { name: labels.emptySeat, email: labels.invitePending, role: labels.collaborator, status: labels.available },
  ];

  const handleSendInvite = () => {
    const normalizedEmail = inviteEmail.trim();
    if (!normalizedEmail) return;
    setPendingInviteEmail(normalizedEmail);
    writeStoredSetting(SETTINGS_INVITE_STORAGE_KEY, normalizedEmail);
    setInviteEmail("");
    setIsInviteOpen(false);
  };

  const handleCancelInvite = () => {
    setPendingInviteEmail("");
    removeStoredSetting(SETTINGS_INVITE_STORAGE_KEY);
  };

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className={`inline-flex items-center gap-2 text-[26px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>
            <Users className="h-5 w-5" />
            {labels.accountSeatsTitle}
          </h3>
          <p className={`mt-2 max-w-3xl text-[14px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.accountSeatsSubtitle}</p>
        </div>
        <button type="button" onClick={onManagePlan} className={`motion-interactive rounded-xl border px-3 py-2 text-[12px] font-medium ${isDark ? "border-[#3a3d46] bg-[#222223] text-slate-100 hover:bg-[#2d3340]" : "border-[#d7dce5] bg-white text-slate-700 shadow-sm hover:bg-[#f8fbff]"}`}>
          {labels.managePlan}
        </button>
      </div>

      <section className={`motion-card mb-4 overflow-hidden rounded-3xl border ${isDark ? "border-[#343944] bg-[#222223]" : "border-[#dde5ef] bg-white"}`}>
        <div className={`flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4 ${isDark ? "border-[#2f3238]" : "border-slate-200/80"}`}>
          <div>
            <p className={`text-[15px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.teamSeats}</p>
            <p className={`mt-1 text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{labels.currentPlan}: {activePlanLabel}</p>
          </div>
          <button type="button" onClick={() => setIsInviteOpen((current) => !current)} className={`motion-interactive inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-[12px] ${isInviteOpen ? "border-[#31577d] bg-[#31577d] text-white" : isDark ? "border-[#3a3d46] bg-[#222223] text-slate-100 hover:bg-[#2d3340]" : "border-[#d7dce5] bg-[#f8fbff] text-slate-700 hover:bg-white"}`}>
            <Mail className="h-3.5 w-3.5" />
            {labels.inviteMember}
          </button>
        </div>
        {isInviteOpen && (
          <div className={`motion-tab-panel flex flex-wrap items-center gap-2 border-b px-5 py-3 ${isDark ? "border-[#2f3238] bg-[#222223]" : "border-slate-200/80 bg-[#f8fbff]"}`}>
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleSendInvite();
              }}
              placeholder={labels.inviteEmailPlaceholder || "teammate@company.com"}
              className={`motion-input min-w-0 flex-1 rounded-lg border px-3 py-2 text-[12px] outline-none sm:min-w-[220px] ${isDark ? "border-[#343944] bg-[#222223] text-slate-100 placeholder:text-slate-500" : "border-[#d7dce5] bg-white text-slate-800 placeholder:text-slate-400"}`}
            />
            <button type="button" onClick={handleSendInvite} disabled={!inviteEmail.trim()} className="motion-interactive rounded-lg bg-[#31577d] px-3 py-2 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">
              {labels.sendInvite || "Send invite"}
            </button>
            <button type="button" onClick={() => { setInviteEmail(""); setIsInviteOpen(false); }} className={`motion-interactive rounded-lg px-3 py-2 text-[12px] ${isDark ? "text-slate-400 hover:bg-[#2a2a2b] hover:text-slate-100" : "text-slate-500 hover:bg-white hover:text-slate-800"}`}>
              {labels.cancel || "Cancel"}
            </button>
          </div>
        )}
        <div className="divide-y divide-slate-200/70 dark:divide-white/10">
          {seats.map((seat, index) => (
            <div key={`${seat.email}-${index}`} className={`flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${isDark ? "border-white/5" : "border-slate-100"}`}>
              <div className="flex min-w-0 items-center gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-[13px] font-semibold ${index === 0 ? "bg-[#31577d] text-white" : isDark ? "bg-[#222223] text-slate-400" : "bg-slate-100 text-slate-500"}`}>
                  {index === 0 ? "KY" : "+"}
                </span>
                <div className="min-w-0">
                  <p className={`truncate text-[14px] font-medium ${isDark ? "text-slate-100" : "text-slate-800"}`}>{seat.name}</p>
                  <p className={`truncate text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{seat.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2.5 py-1 text-[11px] ${isDark ? "bg-[#222223] text-slate-300" : "bg-slate-100 text-slate-600"}`}>{seat.role}</span>
                <span className={`rounded-full px-2.5 py-1 text-[11px] ${index === 0 ? isDark ? "bg-emerald-400/10 text-emerald-200" : "bg-emerald-50 text-emerald-700" : isDark ? "bg-[#31577d]/16 text-[#c8e2ff]" : "bg-sky-50 text-sky-700"}`}>{seat.status}</span>
                {index !== 0 && pendingInviteEmail && (
                  <button
                    type="button"
                    onClick={handleCancelInvite}
                    className={`motion-interactive rounded-full px-2.5 py-1 text-[11px] ${isDark ? "text-slate-400 hover:bg-[#2a2a2b] hover:text-slate-100" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"}`}
                  >
                    {labels.cancel}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid max-w-4xl gap-3 md:grid-cols-3">
        {[
          { label: labels.seatsUsed, value: "1 / 2", icon: Users },
          { label: labels.pendingInvites, value: pendingInviteEmail ? "1" : "0", icon: Mail },
          { label: labels.seatLimit, value: "2", icon: Gauge },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <article key={item.label} className={`motion-card rounded-2xl border p-4 ${isDark ? "border-[#343944] bg-[#222223]" : "border-[#dde5ef] bg-white"}`}>
              <Icon className={`h-4 w-4 ${isDark ? "text-[#9cc4ee]" : "text-[#31577d]"}`} />
              <p className={`mt-4 text-[24px] font-semibold leading-none ${isDark ? "text-slate-100" : "text-slate-800"}`}>{item.value}</p>
              <p className={`mt-2 text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{item.label}</p>
            </article>
          );
        })}
      </div>
    </>
  );
};

interface AdvancedSectionProps { isDark: boolean; labels: any; onResetPreferences: () => void; }
export const AdvancedSection = ({ isDark, labels, onResetPreferences }: AdvancedSectionProps) => {
  const rows = [
    { title: labels.commandPalette, desc: labels.commandPaletteDesc, value: "Ctrl K", icon: Activity },
    { title: labels.dataControls, desc: labels.dataControlsDesc, value: labels.enabled, icon: Database },
    { title: labels.workspaceCache, desc: labels.workspaceCacheDesc, value: labels.optimized, icon: RotateCcw },
  ];

  return (
    <>
      <h3 className={`mb-2 inline-flex items-center gap-2 text-[26px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>
        <Settings className="h-5 w-5" />
        {labels.advancedTitle}
      </h3>
      <p className={`mb-6 max-w-3xl text-[14px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.advancedSubtitle}</p>

      <section className="max-w-4xl space-y-3">
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <article key={row.title} className={`motion-card flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-4 ${isDark ? "border-[#343944] bg-[#222223]" : "border-[#dde5ef] bg-white"}`}>
              <div className="flex min-w-0 items-start gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${isDark ? "bg-[#222223] text-[#9cc4ee]" : "bg-sky-50 text-[#31577d]"}`}>
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className={`text-[15px] font-medium ${isDark ? "text-slate-100" : "text-slate-800"}`}>{row.title}</p>
                  <p className={`mt-1 text-[13px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{row.desc}</p>
                </div>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-[11px] ${isDark ? "bg-[#222223] text-slate-300" : "bg-slate-100 text-slate-600"}`}>{row.value}</span>
            </article>
          );
        })}

        <article className={`motion-card rounded-2xl border p-4 ${isDark ? "border-amber-300/18 bg-amber-300/[0.04]" : "border-amber-200 bg-amber-50/70"}`}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className={`text-[15px] font-medium ${isDark ? "text-amber-100" : "text-amber-900"}`}>{labels.resetPreferences}</p>
              <p className={`mt-1 max-w-2xl text-[13px] ${isDark ? "text-amber-100/60" : "text-amber-800/70"}`}>{labels.resetPreferencesDesc}</p>
            </div>
            <button type="button" onClick={onResetPreferences} className={`motion-interactive inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-medium ${isDark ? "border-amber-200/20 bg-amber-200/10 text-amber-100 hover:bg-amber-200/14" : "border-amber-200 bg-white text-amber-800 hover:bg-amber-100/70"}`}>
              <RotateCcw className="h-3.5 w-3.5" />
              {labels.reset}
            </button>
          </div>
        </article>
      </section>
    </>
  );
};
interface BillingSectionProps { isDark: boolean; labels: any; activePlanLabel: string; onOpenPricing: () => void; }
export const BillingSection = ({ isDark, labels, activePlanLabel, onOpenPricing }: BillingSectionProps) => {
  const [showInvoices, setShowInvoices] = useState(false);

  return (
    <>
      <h3 className={`mb-2 inline-flex items-center gap-2 text-[24px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}><CreditCard className="h-6 w-6" />{labels.billing}</h3>
      <p className={`mb-6 text-[14px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>
        <button type="button" onClick={() => setShowInvoices((current) => !current)} className="motion-interactive underline decoration-[1px] underline-offset-2 hover:opacity-85">
          {showInvoices ? labels.hideInvoices || "Hide invoices" : labels.viewPreviousInvoices}
        </button>{" "}{labels.billingUsageDelay}
      </p>
      {showInvoices && (
        <div className={`motion-tab-panel mb-5 max-w-2xl rounded-xl border p-4 ${isDark ? "border-[#343944] bg-[#222223]" : "border-[#d5d7dc] bg-white"}`}>
          <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${isDark ? "border-[#2f3238] bg-[#222223]" : "border-[#e7ecf3] bg-[#f8fafc]"}`}>
            <span className={`text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.noPreviousInvoices || "No previous invoices yet"}</span>
            <span className={`rounded-full px-2 py-1 text-[10px] ${isDark ? "bg-[#222223] text-slate-400" : "bg-slate-100 text-slate-500"}`}>{labels.currentPlan}: {activePlanLabel}</span>
          </div>
        </div>
      )}
      <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
        <article className={`rounded-lg border p-4 ${isDark ? "border-[#3a3d46] bg-[#222223]" : "border-[#d5d7dc] bg-white"}`}>
          <p className={`text-[20px] leading-none ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.currentPlan}</p>
          <p className={`mt-3 text-[16px] ${isDark ? "text-slate-200" : "text-slate-700"}`}>{activePlanLabel}</p>
        </article>
        <article className={`rounded-lg border p-4 ${isDark ? "border-[#3a3d46] bg-[#222223]" : "border-[#d5d7dc] bg-white"}`}>
          <p className={`text-[20px] leading-none ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.paymentMethod}</p>
          <p className={`mt-3 text-[14px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{labels.noPaymentMethod}</p>
        </article>
      </div>
      <div className={`my-6 border-t ${isDark ? "border-[#343840]" : "border-[#d5d7dc]"}`} />
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className={`text-[20px] font-medium ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.changePlan}</p>
          <p className={`mt-1 text-[14px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{labels.changePlanDesc}</p>
        </div>
        <button type="button" onClick={onOpenPricing} className={`motion-interactive rounded-lg px-3 py-1.5 text-[13px] ${isDark ? "border border-[#434753] bg-[#2b2f38] text-slate-100 hover:bg-[#353b47]" : "border border-[#d0d2d7] bg-[#f3f4f6] text-slate-700 hover:bg-[#e9ebef]"}`}>{labels.billingUpgrade}</button>
      </div>
    </>
  );
};

interface PromotionsSectionProps {
  isDark: boolean;
  labels: any;
  referralSummary: ReferralSummary | null;
  isLoadingReferralSummary: boolean;
  referralSummaryError: string | null;
  onCopyReferralCode: (code: string) => void;
  onCopyReferralLink: (link: string) => void;
}
export const PromotionsSection = ({
  isDark,
  labels,
  referralSummary,
  isLoadingReferralSummary,
  referralSummaryError,
  onCopyReferralCode,
  onCopyReferralLink,
}: PromotionsSectionProps) => {
  const [bonusClaimed, setBonusClaimed] = useState(() =>
    readStoredBoolean(SETTINGS_BONUS_CLAIMED_STORAGE_KEY)
  );

  const handleClaimBonus = () => {
    setBonusClaimed(true);
    writeStoredSetting(SETTINGS_BONUS_CLAIMED_STORAGE_KEY, "true");
  };

  return (
    <>
      <h3 className={`mb-2 inline-flex items-center gap-2 text-[24px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}><Gift className="h-5 w-5" />{labels.promotionsHub}</h3>
      <p className={`mb-6 text-[14px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.promotionsDesc}</p>
      <div className={`max-w-3xl rounded-lg border px-4 py-3 ${isDark ? "border-[#3a3d46] bg-[#222223]" : "border-[#d5d7dc] bg-white"}`}>
        <p className={`text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>
          {labels.referralIntro || "Share your referral link with friends. When they subscribe through your code, your reward summary updates automatically."}
        </p>
      </div>
      <div className={`mt-4 max-w-3xl rounded-lg border p-4 ${isDark ? "border-[#31343b] bg-[#222223]" : "border-[#d8dbe2] bg-white"}`}>
        <p className={`text-[15px] font-medium ${isDark ? "text-slate-100" : "text-slate-800"}`}>{labels.referrals}</p>
        <p className={`mt-1.5 max-w-5xl text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.referralDesc}</p>
        <div className={`mt-3 rounded-lg border p-3 ${isDark ? "border-[#2f3238] bg-[#222223]" : "border-[#e2e8f0] bg-[#f8fafc]"}`}>
          <p className={`text-[11px] uppercase tracking-[0.12em] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{labels.referralCode}</p>
          <div className="mt-2 flex items-center gap-2">
            <div className={`flex-1 truncate rounded-md px-2.5 py-1.5 text-[13px] font-semibold ${isDark ? "bg-[#222223] text-slate-100" : "bg-white text-slate-800"}`}>
              {referralSummary?.referralCode || "--------"}
            </div>
            <button
              type="button"
              disabled={!referralSummary?.referralCode}
              onClick={() => referralSummary?.referralCode && onCopyReferralCode(referralSummary.referralCode)}
              className="motion-interactive inline-flex items-center gap-1 rounded-md bg-[#2588f4] px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-[#1f7be0] disabled:opacity-50"
            >
              <Copy className="h-3 w-3" />
              {labels.copyCode}
            </button>
          </div>
          <p className={`mt-2 text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>
            {labels.rewardRule} ${(referralSummary?.rewardPerConversionUsd ?? 10).toFixed(0)}
          </p>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className={`flex-1 truncate rounded-md px-2.5 py-1.5 text-[13px] ${isDark ? "bg-[#222223] text-slate-200" : "bg-[#f5f7fa] text-slate-700"}`}>
            {referralSummary?.referralLink || "-"}
          </div>
          <button
            type="button"
            disabled={!referralSummary?.referralLink}
            onClick={() => referralSummary?.referralLink && onCopyReferralLink(referralSummary.referralLink)}
            className="motion-interactive inline-flex items-center gap-1 rounded-md bg-[#2588f4] px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-[#1f7be0] disabled:opacity-50"
          >
            <Copy className="h-3 w-3" />
            {labels.copyLink}
          </button>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className={`rounded-md border px-3 py-2 ${isDark ? "border-[#2f3238] bg-[#222223]" : "border-[#e2e8f0] bg-[#f8fafc]"}`}>
            <p className={`text-[11px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{labels.successfulReferrals}</p>
            <p className={`mt-1 text-[16px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>{referralSummary?.successfulReferrals ?? 0}</p>
          </div>
          <div className={`rounded-md border px-3 py-2 ${isDark ? "border-[#2f3238] bg-[#222223]" : "border-[#e2e8f0] bg-[#f8fafc]"}`}>
            <p className={`text-[11px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{labels.pendingReferrals}</p>
            <p className={`mt-1 text-[16px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>{referralSummary?.pendingReferrals ?? 0}</p>
          </div>
          <div className={`rounded-md border px-3 py-2 ${isDark ? "border-[#2f3238] bg-[#222223]" : "border-[#e2e8f0] bg-[#f8fafc]"}`}>
            <p className={`text-[11px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{labels.totalRewards}</p>
            <p className={`mt-1 text-[16px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>${(referralSummary?.totalRewardsUsd ?? 0).toFixed(2)}</p>
          </div>
          <div className={`rounded-md border px-3 py-2 ${isDark ? "border-[#2f3238] bg-[#222223]" : "border-[#e2e8f0] bg-[#f8fafc]"}`}>
            <p className={`text-[11px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{labels.pendingRewards}</p>
            <p className={`mt-1 text-[16px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>${(referralSummary?.pendingRewardsUsd ?? 0).toFixed(2)}</p>
          </div>
        </div>
        {isLoadingReferralSummary && (
          <p className={`mt-3 text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{labels.loadingReferralData || "Loading referral data..."}</p>
        )}
        {referralSummaryError && (
          <p className={`mt-3 text-[12px] ${isDark ? "text-amber-300" : "text-amber-700"}`}>{referralSummaryError}</p>
        )}
        <button
          type="button"
          onClick={handleClaimBonus}
          disabled={bonusClaimed}
          className={`motion-interactive mt-3 inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] font-medium disabled:cursor-default ${bonusClaimed ? isDark ? "bg-emerald-400/10 text-emerald-200" : "bg-emerald-50 text-emerald-700" : "bg-[#2588f4] text-white hover:bg-[#1f7be0]"}`}
        >
          {bonusClaimed ? <Check className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
          {bonusClaimed ? labels.bonusClaimed || "Bonus claimed" : labels.bonusCta}
        </button>
      </div>
    </>
  );
};
interface ProfileSectionProps { isDark: boolean; labels: any; workspaceInitials: string; profileAvatarDataUrl: string | null; profileUsername: string; profileEmail: string; profileFirstName: string; setProfileFirstName: (v: string) => void; profileLastName: string; setProfileLastName: (v: string) => void; profileBio: string; setProfileBio: (v: string) => void; bioRemaining: number; saveProfileToStorage: () => void; handleAvatarUpload: (e: ChangeEvent<HTMLInputElement>) => void; }
export const ProfileSection = ({ isDark, labels, workspaceInitials, profileAvatarDataUrl, profileUsername, profileEmail, profileFirstName, setProfileFirstName, profileLastName, setProfileLastName, profileBio, setProfileBio, bioRemaining, saveProfileToStorage, handleAvatarUpload }: ProfileSectionProps) => {
  const initialEmail = readStoredSetting(SETTINGS_PROFILE_EMAIL_STORAGE_KEY, profileEmail);
  const [savedEmail, setSavedEmail] = useState(initialEmail);
  const [emailDraft, setEmailDraft] = useState(initialEmail);
  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [passwordUpdatedAt, setPasswordUpdatedAt] = useState(() =>
    readStoredSetting(SETTINGS_PASSWORD_UPDATED_STORAGE_KEY)
  );
  const [isPublicPreviewOpen, setIsPublicPreviewOpen] = useState(false);
  const profileDisplayName = `${profileFirstName} ${profileLastName}`.trim() || profileUsername;

  useEffect(() => {
    const nextEmail = readStoredSetting(SETTINGS_PROFILE_EMAIL_STORAGE_KEY, profileEmail);
    setSavedEmail(nextEmail);
    setEmailDraft(nextEmail);
  }, [profileEmail]);

  const handleEditEmail = () => {
    setEmailDraft(savedEmail);
    setIsEditingEmail(true);
  };

  const handleCancelEmail = () => {
    setEmailDraft(savedEmail);
    setIsEditingEmail(false);
  };

  const handleSaveEmail = () => {
    const nextEmail = emailDraft.trim();
    if (!nextEmail) return;
    setSavedEmail(nextEmail);
    setEmailDraft(nextEmail);
    writeStoredSetting(SETTINGS_PROFILE_EMAIL_STORAGE_KEY, nextEmail);
    setIsEditingEmail(false);
  };

  const handlePasswordUpdate = () => {
    const timestamp = new Date().toISOString();
    setPasswordUpdatedAt(timestamp);
    writeStoredSetting(SETTINGS_PASSWORD_UPDATED_STORAGE_KEY, timestamp);
  };

  return (
    <>
      <h3 className={`mb-5 inline-flex items-center gap-2 text-[13px] font-semibold ${isDark ? "text-slate-100" : "text-slate-700"}`}><User className="h-4 w-4" />{labels.profile}</h3>
      <div className="grid gap-4 md:grid-cols-[96px_1fr]">
        <div className="relative h-fit">
          {profileAvatarDataUrl ? (
            <img src={profileAvatarDataUrl} alt="Profile avatar" className="h-20 w-20 rounded-full object-cover" />
          ) : (
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[#12b5cb] text-[28px] text-white">{workspaceInitials}</div>
          )}
          <label className="absolute bottom-0 right-0 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-[#222223] text-white shadow-lg hover:bg-[#2a2a2b]">
            <Pencil className="h-3 w-3" />
            <input type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} />
          </label>
        </div>
        <div>
          <label className={`mb-1 block text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.username}</label>
          <div className="relative">
            <input type="text" disabled value={profileUsername} className={`motion-input w-full cursor-not-allowed rounded-lg border px-2.5 py-1.5 pr-16 text-[11px] ${isDark ? "border-[#3a3d46] bg-[#222223] text-slate-400" : "border-[#d0d2d7] bg-[#f3f4f6] text-slate-500"}`} />
            <span className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[10px] ${isDark ? "bg-[#23262c] text-slate-400" : "bg-[#e7ebf1] text-slate-500"}`}>{labels.locked || "Locked"}</span>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label className={`mb-1 block text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.firstName}</label>
              <input type="text" value={profileFirstName} onChange={(e) => setProfileFirstName(e.target.value)} className={`motion-input w-full rounded-lg border px-2.5 py-1.5 text-[11px] ${isDark ? "border-[#3a3d46] bg-[#222223] text-slate-200" : "border-[#d0d2d7] bg-[#ffffff] text-slate-700"}`} />
            </div>
            <div>
              <label className={`mb-1 block text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.lastName}</label>
              <input type="text" value={profileLastName} onChange={(e) => setProfileLastName(e.target.value)} className={`motion-input w-full rounded-lg border px-2.5 py-1.5 text-[11px] ${isDark ? "border-[#3a3d46] bg-[#222223] text-slate-200" : "border-[#d0d2d7] bg-[#ffffff] text-slate-700"}`} />
            </div>
          </div>
          <label className={`mb-1 mt-4 block text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.bio} ({bioRemaining})</label>
          <textarea maxLength={140} value={profileBio} onChange={(e) => setProfileBio(e.target.value)} placeholder={labels.addBio} className={`motion-input h-14 w-full resize-none rounded-lg border px-2.5 py-1.5 text-[11px] ${isDark ? "border-[#3a3d46] bg-[#222223] text-slate-200 placeholder:text-slate-500" : "border-[#d0d2d7] bg-[#ffffff] text-slate-700 placeholder:text-slate-400"}`} />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setIsPublicPreviewOpen((current) => !current)} className={`motion-interactive rounded-md px-2 py-1.5 text-[11px] ${isDark ? "bg-[#222223] text-slate-100 hover:bg-[#2d3340]" : "bg-[#f2f5f9] text-slate-700 hover:bg-[#e9eef6]"}`}>{isPublicPreviewOpen ? labels.publicProfileOpened || labels.viewPublicProfile : labels.viewPublicProfile}</button>
            <button type="button" onClick={saveProfileToStorage} className="motion-interactive rounded-md bg-[#2588f4] px-2 py-1.5 text-[11px] font-medium text-white hover:bg-[#1f7be0]">{labels.saveChanges}</button>
          </div>
          {isPublicPreviewOpen && (
            <div className={`motion-tab-panel mt-4 rounded-xl border p-4 ${isDark ? "border-[#343944] bg-[#222223]" : "border-[#d7dce5] bg-[#f8fbff]"}`}>
              <p className={`mb-3 text-[11px] uppercase tracking-[0.14em] ${isDark ? "text-slate-500" : "text-slate-500"}`}>{labels.publicProfilePreview || "Public profile preview"}</p>
              <div className="flex items-center gap-3">
                {profileAvatarDataUrl ? (
                  <img src={profileAvatarDataUrl} alt="Profile avatar preview" className="h-11 w-11 rounded-full object-cover" />
                ) : (
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#12b5cb] text-[15px] font-semibold text-white">{workspaceInitials}</span>
                )}
                <div className="min-w-0">
                  <p className={`truncate text-[14px] font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>{profileDisplayName}</p>
                  <p className={`truncate text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{savedEmail}</p>
                </div>
              </div>
              <p className={`mt-3 text-[12px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{profileBio || labels.addBio}</p>
            </div>
          )}
        </div>
      </div>
      <div className={`my-6 border-t ${isDark ? "border-[#343840]" : "border-[#d5d7dc]"}`} />
      <div className="space-y-3">
        <div className={`rounded-xl border p-3 ${isDark ? "border-[#343944] bg-[#222223]" : "border-[#d7dce5] bg-white"}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className={`text-[13px] font-medium ${isDark ? "text-slate-100" : "text-slate-700"}`}>{labels.yourEmail}</p>
              {!isEditingEmail && <p className={`truncate text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{savedEmail}</p>}
            </div>
            {!isEditingEmail && (
              <button type="button" onClick={handleEditEmail} className={`motion-interactive inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[9px] ${isDark ? "border-[#3a3d46] bg-[#222223] text-slate-200 hover:bg-[#262930]" : "border-[#d0d2d7] bg-white text-slate-700 hover:bg-[#f8fafc]"}`}><Pencil className="h-3 w-3" />{labels.emailEdit || labels.edit}</button>
            )}
          </div>
          {isEditingEmail ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="email"
                value={emailDraft}
                onChange={(event) => setEmailDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleSaveEmail();
                  if (event.key === "Escape") handleCancelEmail();
                }}
                className={`motion-input min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-[11px] outline-none sm:min-w-[220px] ${isDark ? "border-[#3a3d46] bg-[#222223] text-slate-100 placeholder:text-slate-500" : "border-[#d0d2d7] bg-[#ffffff] text-slate-700 placeholder:text-slate-400"}`}
              />
              <button type="button" onClick={handleSaveEmail} disabled={!emailDraft.trim()} className="motion-interactive rounded-md bg-[#2588f4] px-2 py-1.5 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{labels.save || labels.saveChanges}</button>
              <button type="button" onClick={handleCancelEmail} className={`motion-interactive rounded-md px-2 py-1.5 text-[11px] ${isDark ? "text-slate-400 hover:bg-[#262930] hover:text-slate-100" : "text-slate-500 hover:bg-[#f8fafc] hover:text-slate-800"}`}>{labels.cancel || "Cancel"}</button>
            </div>
          ) : savedEmail !== profileEmail ? (
            <p className={`mt-2 inline-flex items-center gap-1 text-[11px] ${isDark ? "text-emerald-200" : "text-emerald-700"}`}><Check className="h-3 w-3" />{labels.emailSaved || "Email saved"}</p>
          ) : null}
        </div>
        <div className={`rounded-xl border p-3 ${isDark ? "border-[#343944] bg-[#222223]" : "border-[#d7dce5] bg-white"}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className={`text-[13px] font-medium ${isDark ? "text-slate-100" : "text-slate-700"}`}>{labels.yourPassword}</p>
              <p className={`text-[13px] ${passwordUpdatedAt ? isDark ? "text-emerald-200" : "text-emerald-700" : isDark ? "text-slate-300" : "text-slate-600"}`}>{passwordUpdatedAt ? labels.passwordUpdated || "Password updated" : "**********"}</p>
              {passwordUpdatedAt && <p className={`mt-0.5 text-[11px] ${isDark ? "text-slate-500" : "text-slate-500"}`}>{labels.passwordUpdatedDesc || "Last change is saved on this browser."}</p>}
            </div>
            <button type="button" onClick={handlePasswordUpdate} className={`motion-interactive inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[9px] ${isDark ? "border-[#3a3d46] bg-[#222223] text-slate-200 hover:bg-[#262930]" : "border-[#d0d2d7] bg-white text-slate-700 hover:bg-[#f8fafc]"}`}><Pencil className="h-3 w-3" />{labels.edit}</button>
          </div>
        </div>
      </div>
    </>
  );
};
type WorkspaceKind = "personal" | "team";
type BillingCycle = "monthly" | "yearly";

interface WorkspaceModalProps { isDark: boolean; labels: any; workspaceType: WorkspaceKind; setWorkspaceType: (v: WorkspaceKind) => void; onClose: () => void; onOpenPricing: () => void; accountName: string; workspaceCards: any; }
export const WorkspaceModal = ({ isDark, labels, workspaceType, setWorkspaceType, onClose, onOpenPricing, workspaceCards }: WorkspaceModalProps) => (
  <div className="motion-overlay fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
    <div className={`motion-route motion-modal-panel w-full max-w-4xl rounded-3xl border p-6 ${isDark ? "border-[#383b44] bg-[#222223]" : "border-[#d7d9de] bg-white"}`}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className={`text-[24px] font-semibold ${isDark ? "text-white" : "text-slate-800"}`}>{labels.workspaceCardTitle}</h3>
          <p className={`mt-1 max-w-2xl text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.workspaceCardText}</p>
        </div>
        <button type="button" onClick={onClose} className={`rounded-lg p-2 ${isDark ? "text-slate-300 hover:bg-[#2a2a2b]" : "text-slate-500 hover:bg-slate-100"}`} aria-label={labels.close}><X className="h-5 w-5" /></button>
      </div>
      <div className="mb-5 flex flex-wrap gap-2">
        <button type="button" onClick={() => setWorkspaceType("personal")} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] ${workspaceType === "personal" ? "border-[#31577d] bg-[#31577d] text-white" : isDark ? "border-[#393c45] bg-[#222223] text-slate-200 hover:bg-[#2a2a2b]" : "border-[#d2d4d8] bg-white text-slate-700"}`}><Check className="h-3.5 w-3.5" />{labels.personal}</button>
        <button type="button" onClick={() => setWorkspaceType("team")} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] ${workspaceType === "team" ? "border-[#31577d] bg-[#31577d] text-white" : isDark ? "border-[#393c45] bg-[#222223] text-slate-200 hover:bg-[#2a2a2b]" : "border-[#d2d4d8] bg-white text-slate-700"}`}><Users className="h-3.5 w-3.5" />{labels.team}</button>
      </div>
      <div className={`grid gap-5 rounded-2xl border p-5 md:grid-cols-[180px_1fr] ${isDark ? "border-[#393c45] bg-[#222223]" : "border-[#d5d7dc] bg-[#f8f9fb]"}`}>
        <div className="flex flex-col items-center text-center">
          <div className="inline-flex h-20 w-20 items-center justify-center rounded-full bg-[#31577d] text-[28px] font-semibold text-white">{workspaceType === "personal" ? "AY" : "TM"}</div>
          <p className={`mt-3 text-[11px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{labels.workspaceOwner}</p>
          <p className={`text-[13px] font-medium ${isDark ? "text-slate-100" : "text-slate-700"}`}>{workspaceCards[workspaceType].owner}</p>
        </div>
        <div>
          <p className={`text-[11px] uppercase tracking-[0.16em] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{workspaceCards[workspaceType].subtitle}</p>
          <h4 className={`mt-1 text-[24px] font-semibold ${isDark ? "text-white" : "text-slate-800"}`}>{workspaceCards[workspaceType].title}</h4>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {workspaceCards[workspaceType].features.map((f: string) => (
              <div key={f} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] ${isDark ? "border-[#454953] bg-[#222223] text-slate-200" : "border-[#d7d9de] bg-white text-slate-700"}`}><Check className="h-3.5 w-3.5 text-[#3b82f6]" />{f}</div>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" className="motion-interactive inline-flex items-center gap-2 rounded-lg bg-[#31577d] px-4 py-2 text-[12px] font-medium text-white hover:bg-[#3b6793]">{workspaceCards[workspaceType].action}</button>
            <button type="button" onClick={() => { onClose(); onOpenPricing(); }} className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-[12px] ${isDark ? "border-[#454953] bg-[#222223] text-slate-200 hover:bg-[#2a2a2b]" : "border-[#d2d4d8] bg-white text-slate-700 hover:bg-slate-50"}`}><Crown className="h-3.5 w-3.5" />{labels.createWorkspace}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
);

interface PricingModalProps { isDark: boolean; labels: any; billingCycle: BillingCycle; setBillingCycle: (v: BillingCycle) => void; onClose: () => void; pricingPlans: any[]; onSelectPlan: (planKey: string) => void; }
export const PricingModal = ({ isDark, labels, billingCycle, setBillingCycle, onClose, pricingPlans, onSelectPlan }: PricingModalProps) => (
  <div className="motion-overlay fixed inset-0 z-[80] overflow-y-auto bg-black/70 px-4 py-10 backdrop-blur-sm">
    <div className="mx-auto w-full max-w-[1120px]">
      <div className={`motion-route motion-modal-panel rounded-3xl border p-6 md:p-8 ${isDark ? "border-[#3a3d46] bg-[#222223]" : "border-[#d7d9de] bg-white"}`}>
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className={`text-[34px] font-semibold ${isDark ? "text-white" : "text-slate-800"}`}>{labels.comparePlans}</h3>
            <p className={`mt-1 text-[14px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.compareSubtitle}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className={`inline-flex items-center rounded-xl border p-1 ${isDark ? "border-[#464955] bg-[#222223]" : "border-[#d2d4d8] bg-[#f5f6f8]"}`}>
              <button type="button" onClick={() => setBillingCycle("monthly")} className={`motion-interactive rounded-lg px-3 py-1.5 text-[12px] transition-colors ${billingCycle === "monthly" ? "bg-[#31577d] text-white shadow-sm" : isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.monthly}</button>
              <button type="button" onClick={() => setBillingCycle("yearly")} className={`motion-interactive rounded-lg px-3 py-1.5 text-[12px] transition-colors ${billingCycle === "yearly" ? "bg-[#31577d] text-white shadow-sm" : isDark ? "text-slate-300" : "text-slate-600"}`}>{labels.yearly}</button>
            </div>
            <span className="rounded-md bg-[#31577d]/20 px-2 py-1 text-[11px] text-[#7ec0ff]">{labels.yearlyDiscount}</span>
            <button type="button" onClick={onClose} className={`rounded-lg p-2 ${isDark ? "text-slate-300 hover:bg-[#2a2a2b]" : "text-slate-500 hover:bg-slate-100"}`} aria-label={labels.close}><X className="h-5 w-5" /></button>
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {pricingPlans.map((plan) => {
            const price = billingCycle === "monthly" ? plan.monthly : plan.yearly;
            const note = billingCycle === "monthly" ? plan.noteMonthly : plan.noteYearly;
            return (
              <article key={plan.key} className={`motion-card rounded-2xl border p-5 ${plan.featured ? isDark ? "border-[#3b82f6] bg-[#222223] shadow-[0_0_0_1px_rgba(59,130,246,0.25)]" : "border-[#b9d7fb] bg-white shadow-[0_18px_46px_rgba(49,87,125,0.08),0_0_0_1px_rgba(59,130,246,0.08)]" : isDark ? "border-[#3a3d46] bg-[#222223]" : "border-[#d7d9de] bg-[#fbfcff]"}`}>
                <h4 className={`text-[28px] font-semibold ${isDark ? "text-white" : "text-slate-800"}`}>{plan.name}</h4>
                <p className={`mt-2 text-[13px] ${isDark ? "text-slate-300" : "text-slate-600"}`}>{plan.desc}</p>
                <div className="mt-5">
                  {billingCycle === "yearly" && (
                    <p className={`mb-1 text-[13px] font-medium line-through ${isDark ? "text-slate-500" : "text-slate-400"}`}>
                      {plan.monthly}
                    </p>
                  )}
                  <p key={`${plan.key}-${billingCycle}`} className={`pricing-price-swap text-[40px] font-semibold leading-none ${isDark ? "text-white" : "text-slate-900"}`}>{price}</p>
                  <p className={`mt-1 text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{note}</p>
                </div>
                <ul className="mt-5 space-y-2">
                  {plan.features.map((f: string) => (
                    <li key={f} className={`flex items-start gap-2 text-[12px] ${isDark ? "text-slate-200" : "text-slate-700"}`}><Check className="mt-0.5 h-3.5 w-3.5 text-[#60a5fa]" /><span>{f}</span></li>
                  ))}
                </ul>
                <button type="button" onClick={() => onSelectPlan(plan.key)} className={`motion-interactive mt-6 inline-flex w-full items-center justify-center rounded-lg border px-3 py-2 text-[13px] font-medium ${plan.muted ? isDark ? "cursor-default border-[#41444d] bg-[#222223] text-slate-400" : "cursor-default border-[#d4d6db] bg-[#f3f4f6] text-slate-500" : plan.featured ? "border-[#3b82f6] bg-[#3b82f6] text-white hover:bg-[#4a8ee8]" : isDark ? "border-[#4b4f5b] bg-[#222223] text-slate-100 hover:bg-[#2a2a2b]" : "border-[#d0d2d7] bg-white text-slate-700 hover:bg-slate-50"}`}>{plan.cta}</button>
              </article>
            );
          })}
        </div>
        <p className={`mt-6 text-center text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>{labels.pricingFootnote}</p>
      </div>
    </div>
  </div>
);





