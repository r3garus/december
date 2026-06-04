import {
  coerceAccountPlan,
  displayNameFromEmail,
  fallbackAccountSnapshot,
  fallbackEntitlements,
  sanitizeDisplayName,
  type AccountEntitlementsSnapshot,
} from "@/lib/account/types";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

const backendApiUrl = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

const isSchemaNotReadyError = (error: { code?: string; message?: string } | null) => {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "42703" || error.code === "PGRST204") return true;
  const message = (error.message || "").toLowerCase();
  return (
    message.includes("relation") ||
    message.includes("column") ||
    message.includes("does not exist") ||
    message.includes("schema cache")
  );
};

const toNumber = (value: unknown, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const toBoolean = (value: unknown, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  if (typeof value === "number") return value === 1;
  return fallback;
};

const readMetadataName = (metadata: Record<string, unknown> | null | undefined) =>
  sanitizeDisplayName(metadata?.name) ||
  sanitizeDisplayName(metadata?.full_name) ||
  sanitizeDisplayName(metadata?.display_name) ||
  sanitizeDisplayName(metadata?.username);

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json(fallbackAccountSnapshot);
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (backendApiUrl && session?.access_token) {
      try {
        const backendResponse = await fetch(`${backendApiUrl}/account/me`, {
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (backendResponse.ok) {
          return NextResponse.json(await backendResponse.json());
        }
      } catch {
        // Fall back to direct Supabase reads while the builder backend is offline.
      }
    }

    let setupRequired = false;
    const metadataName = readMetadataName(user.user_metadata);
    const metadataAvatar =
      typeof user.user_metadata?.avatar_url === "string"
        ? user.user_metadata.avatar_url
        : typeof user.user_metadata?.picture === "string"
          ? user.user_metadata.picture
          : null;

    const profileResult = await supabase
      .from("user_profiles")
      .select("display_name, avatar_url")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profileResult.error && isSchemaNotReadyError(profileResult.error)) {
      setupRequired = true;
    }

    const profileRow = profileResult.error ? null : profileResult.data;
    const profileDisplayName =
      sanitizeDisplayName(profileRow?.display_name) ||
      metadataName ||
      displayNameFromEmail(user.email);

    const entitlementsResult = await supabase
      .from("account_entitlements")
      .select(
        "plan, subscription_status, balance_cents, api_access_enabled, monthly_ai_limit, monthly_ai_used, current_period_end"
      )
      .eq("user_id", user.id)
      .maybeSingle();

    if (entitlementsResult.error && isSchemaNotReadyError(entitlementsResult.error)) {
      setupRequired = true;
    }

    const row = entitlementsResult.error ? null : entitlementsResult.data;
    const entitlements: AccountEntitlementsSnapshot = {
      plan: coerceAccountPlan(row?.plan),
      subscriptionStatus:
        typeof row?.subscription_status === "string"
          ? row.subscription_status
          : fallbackEntitlements.subscriptionStatus,
      balanceCents: Math.max(0, Math.round(toNumber(row?.balance_cents, 0))),
      apiAccessEnabled: toBoolean(row?.api_access_enabled, false),
      monthlyAiLimit: Math.max(0, Math.round(toNumber(row?.monthly_ai_limit, fallbackEntitlements.monthlyAiLimit))),
      monthlyAiUsed: Math.max(0, Math.round(toNumber(row?.monthly_ai_used, fallbackEntitlements.monthlyAiUsed))),
      currentPeriodEnd:
        typeof row?.current_period_end === "string" ? row.current_period_end : null,
    };

    return NextResponse.json({
      profile: {
        userId: user.id,
        email: user.email || null,
        displayName: profileDisplayName,
        avatarUrl:
          typeof profileRow?.avatar_url === "string" && profileRow.avatar_url.trim()
            ? profileRow.avatar_url
            : metadataAvatar,
        isAuthenticated: true,
      },
      entitlements,
      setupRequired,
    });
  } catch {
    return NextResponse.json(fallbackAccountSnapshot);
  }
}
