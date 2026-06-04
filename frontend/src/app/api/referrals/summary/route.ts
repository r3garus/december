import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

interface ReferralSummary {
  referralCode: string;
  referralLink: string;
  successfulReferrals: number;
  pendingReferrals: number;
  totalRewardsUsd: number;
  pendingRewardsUsd: number;
  rewardPerConversionUsd: number;
}

const DEFAULT_REWARD_PER_CONVERSION_USD = 10;

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

const buildFallbackSummary = (origin: string, accountName: string): ReferralSummary => {
  const referralCode = buildFallbackReferralCode(accountName);
  return {
    referralCode,
    referralLink: `${origin}/auth/bridge?ref=${referralCode}`,
    successfulReferrals: 0,
    pendingReferrals: 0,
    totalRewardsUsd: 0,
    pendingRewardsUsd: 0,
    rewardPerConversionUsd: DEFAULT_REWARD_PER_CONVERSION_USD,
  };
};

const isSchemaNotReadyError = (error: { code?: string; message?: string } | null) => {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST202") return true;
  const message = (error.message || "").toLowerCase();
  return (
    message.includes("relation") ||
    message.includes("does not exist") ||
    message.includes("function") ||
    message.includes("schema cache")
  );
};

export async function GET(request: NextRequest) {
  const accountName = request.nextUrl.searchParams.get("accountName")?.trim() || "user";
  const fallbackSummary = buildFallbackSummary(request.nextUrl.origin, accountName);

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ summary: fallbackSummary });
    }

    const profileResult = await supabase
      .from("referral_profiles")
      .select("referral_code")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profileResult.error && !isSchemaNotReadyError(profileResult.error)) {
      return NextResponse.json({ summary: fallbackSummary });
    }

    if (isSchemaNotReadyError(profileResult.error)) {
      return NextResponse.json({ summary: fallbackSummary, setupRequired: true });
    }

    const referralCode = profileResult.data?.referral_code || fallbackSummary.referralCode;

    const statsResult = await supabase.rpc("get_referral_summary", {
      p_referral_code: referralCode,
    });

    if (statsResult.error) {
      if (isSchemaNotReadyError(statsResult.error)) {
        return NextResponse.json({
          summary: {
            ...fallbackSummary,
            referralCode,
            referralLink: `${request.nextUrl.origin}/auth/bridge?ref=${referralCode}`,
          },
          setupRequired: true,
        });
      }
      return NextResponse.json({ summary: fallbackSummary });
    }

    const statsRow = Array.isArray(statsResult.data)
      ? statsResult.data[0]
      : statsResult.data;

    const summary: ReferralSummary = {
      referralCode,
      referralLink: `${request.nextUrl.origin}/auth/bridge?ref=${referralCode}`,
      successfulReferrals: Number(statsRow?.successful_referrals || 0),
      pendingReferrals: Number(statsRow?.pending_referrals || 0),
      totalRewardsUsd: Number(statsRow?.total_rewards_usd || 0),
      pendingRewardsUsd: Number(statsRow?.pending_rewards_usd || 0),
      rewardPerConversionUsd: Number(
        statsRow?.reward_per_conversion_usd || DEFAULT_REWARD_PER_CONVERSION_USD
      ),
    };

    return NextResponse.json({ summary });
  } catch {
    return NextResponse.json({ summary: fallbackSummary });
  }
}
