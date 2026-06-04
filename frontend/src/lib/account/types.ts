export type AccountPlan = "starter" | "core" | "pro" | "enterprise";

export interface AccountProfileSnapshot {
  userId: string | null;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  isAuthenticated: boolean;
}

export interface AccountEntitlementsSnapshot {
  plan: AccountPlan;
  subscriptionStatus: string;
  balanceCents: number;
  apiAccessEnabled: boolean;
  monthlyAiLimit: number;
  monthlyAiUsed: number;
  currentPeriodEnd: string | null;
}

export interface AccountSnapshot {
  profile: AccountProfileSnapshot;
  entitlements: AccountEntitlementsSnapshot;
  setupRequired: boolean;
}

export const fallbackEntitlements: AccountEntitlementsSnapshot = {
  plan: "starter",
  subscriptionStatus: "inactive",
  balanceCents: 0,
  apiAccessEnabled: false,
  monthlyAiLimit: 25,
  monthlyAiUsed: 0,
  currentPeriodEnd: null,
};

export const fallbackAccountSnapshot: AccountSnapshot = {
  profile: {
    userId: null,
    email: null,
    displayName: "kaichen",
    avatarUrl: null,
    isAuthenticated: false,
  },
  entitlements: fallbackEntitlements,
  setupRequired: false,
};

export const accountPlanValues: AccountPlan[] = [
  "starter",
  "core",
  "pro",
  "enterprise",
];

export const coerceAccountPlan = (value: unknown): AccountPlan =>
  accountPlanValues.includes(value as AccountPlan) ? (value as AccountPlan) : "starter";

export const sanitizeDisplayName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.length > 80 || /base64,/i.test(trimmed)) {
    return null;
  }
  if (trimmed.includes("@")) return trimmed.split("@")[0]?.trim() || null;
  return trimmed;
};

export const displayNameFromEmail = (email: string | null | undefined) =>
  sanitizeDisplayName(email) || fallbackAccountSnapshot.profile.displayName;
