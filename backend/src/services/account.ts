import type express from "express";
import postgres from "postgres";

export type BillingPlanKey = "free" | "essential" | "professional" | "expert";

export interface AuthenticatedAccount {
  supabaseUserId: string;
  localUserId: number;
  teamId: number;
  email: string;
  displayName: string;
  planKey: BillingPlanKey;
  billingCycle: "monthly" | "yearly";
  subscriptionStatus: string | null;
  requestCreditBalanceCents: number;
  monthlyRequestCreditCents: number;
  freeRequestsUsed: number;
  currentPeriodEnd: string | null;
}

interface SupabaseUser {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}

interface AuthCacheEntry {
  user: SupabaseUser;
  expiresAt: number;
}

declare global {
  namespace Express {
    interface Request {
      account?: AuthenticatedAccount;
    }
  }
}

const FREE_REQUEST_LIMIT = Number(process.env.FREE_AI_REQUEST_LIMIT || "3");
const CREDIT_UNIT_CENTS = Number(process.env.KLAWPEN_CORE_CREDIT_CENTS || "100");
const DEFAULT_REQUEST_CREDIT_CENTS = Number(
  process.env.AI_REQUEST_CREDIT_CENTS || String(CREDIT_UNIT_CENTS)
);

const authCache = new Map<string, AuthCacheEntry>();
let sqlClient: postgres.Sql | null = null;

function getPostgresClient() {
  if (sqlClient) return sqlClient;

  const postgresUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;

  if (!postgresUrl) {
    throw new Error("POSTGRES_URL is required for account and usage limits");
  }

  sqlClient = postgres(postgresUrl, {
    max: Number(process.env.POSTGRES_MAX_CONNECTIONS || "5"),
    prepare: false,
  });

  return sqlClient;
}

function getSupabaseConfig() {
  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase URL and publishable key are required");
  }

  return { supabaseUrl: supabaseUrl.replace(/\/$/, ""), supabaseKey };
}

function extractBearerToken(req: express.Request) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return null;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function getJwtExpiryMs(token: string) {
  try {
    const [, payload] = token.split(".");
    if (!payload) return 0;

    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(normalized, "base64").toString("utf8");
    const parsed = JSON.parse(json) as { exp?: number };

    return parsed.exp ? parsed.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function getSupabaseUser(token: string): Promise<SupabaseUser | null> {
  const now = Date.now();
  const cached = authCache.get(token);

  if (cached && cached.expiresAt > now) {
    return cached.user;
  }

  const { supabaseUrl, supabaseKey } = getSupabaseConfig();
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    authCache.delete(token);
    return null;
  }

  const user = (await response.json()) as SupabaseUser;
  const jwtExpiryMs = getJwtExpiryMs(token);
  const cacheUntil = Math.min(
    jwtExpiryMs || now + 60_000,
    now + Number(process.env.AUTH_CACHE_TTL_MS || "60000")
  );

  authCache.set(token, { user, expiresAt: cacheUntil });
  return user;
}

function sanitizeDisplayName(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();

  if (!trimmed || trimmed.startsWith("data:") || trimmed.length > 80) {
    return null;
  }

  return trimmed;
}

function getDisplayName(user: SupabaseUser) {
  const metadata = user.user_metadata || {};
  return (
    sanitizeDisplayName(metadata.name) ||
    sanitizeDisplayName(metadata.full_name) ||
    sanitizeDisplayName(metadata.display_name) ||
    sanitizeDisplayName(metadata.username) ||
    user.email?.split("@")[0] ||
    "Klawpen user"
  );
}

function resolveBillingPlanKey(
  planKey: string | null | undefined,
  planName: string | null | undefined,
  subscriptionStatus: string | null | undefined
): BillingPlanKey {
  const raw = `${planKey || ""} ${planName || ""}`.toLowerCase();
  const isPaidActive = subscriptionStatus === "active";

  if (!isPaidActive) return "free";
  if (raw.includes("expert") || raw.includes("uzman")) return "expert";
  if (raw.includes("professional") || raw.includes("profesyonel")) {
    return "professional";
  }
  if (raw.includes("essential") || raw.includes("temel")) return "essential";

  return "free";
}

function mapPlanToDashboard(planKey: BillingPlanKey) {
  if (planKey === "essential") return "core";
  if (planKey === "professional") return "pro";
  if (planKey === "expert") return "enterprise";
  return "starter";
}

async function selectAccountByEmail(
  sql: postgres.Sql | postgres.TransactionSql,
  email: string,
  supabaseUserId: string,
  displayName: string
) {
  const [existingUser] = await sql<
    { id: number; email: string; name: string | null }[]
  >`
    select id, email, name
    from users
    where lower(email) = lower(${email}) and deleted_at is null
    limit 1
  `;

  let user = existingUser;

  if (!user) {
    const [createdUser] = await sql<
      { id: number; email: string; name: string | null }[]
    >`
      insert into users (email, name, password_hash, role)
      values (${email}, ${displayName}, ${`supabase:${supabaseUserId}`}, 'owner')
      on conflict (email) do update
      set name = coalesce(users.name, excluded.name), updated_at = now()
      returning id, email, name
    `;

    user = createdUser;
  } else if (!user.name && displayName) {
    await sql`
      update users
      set name = ${displayName}, updated_at = now()
      where id = ${user.id}
    `;
    user.name = displayName;
  }

  if (!user) {
    throw new Error("Could not create local account");
  }

  let [membership] = await sql<
    Array<{
      user_id: number;
      email: string;
      display_name: string | null;
      team_id: number;
      plan_key: string | null;
      plan_name: string | null;
      subscription_status: string | null;
      billing_cycle: string | null;
      ai_request_credit_balance_cents: number;
      ai_monthly_request_credit_cents: number;
      ai_free_requests_used: number;
      ai_credit_period_end: Date | null;
    }>
  >`
    select
      u.id as user_id,
      u.email,
      u.name as display_name,
      tm.team_id,
      t.plan_key,
      t.plan_name,
      t.subscription_status,
      t.billing_cycle,
      t.ai_request_credit_balance_cents,
      t.ai_monthly_request_credit_cents,
      t.ai_free_requests_used,
      t.ai_credit_period_end
    from users u
    inner join team_members tm on tm.user_id = u.id
    inner join teams t on t.id = tm.team_id
    where u.id = ${user.id}
    order by case when tm.role = 'owner' then 0 else 1 end, tm.id asc
    limit 1
  `;

  if (!membership) {
    const [createdTeam] = await sql<{ id: number }[]>`
      insert into teams (name)
      values (${`${email}'s Team`})
      returning id
    `;

    if (!createdTeam) {
      throw new Error("Could not create local team");
    }

    await sql`
      insert into team_members (user_id, team_id, role)
      values (${user.id}, ${createdTeam.id}, 'owner')
    `;

    [membership] = await sql`
      select
        u.id as user_id,
        u.email,
        u.name as display_name,
        tm.team_id,
        t.plan_key,
        t.plan_name,
        t.subscription_status,
        t.billing_cycle,
        t.ai_request_credit_balance_cents,
        t.ai_monthly_request_credit_cents,
        t.ai_free_requests_used,
        t.ai_credit_period_end
      from users u
      inner join team_members tm on tm.user_id = u.id
      inner join teams t on t.id = tm.team_id
      where u.id = ${user.id}
      limit 1
    `;
  }

  if (!membership) {
    throw new Error("Could not resolve local account");
  }

  return membership;
}

export async function ensureAccountForSupabaseUser(
  user: SupabaseUser
): Promise<AuthenticatedAccount> {
  const email = user.email?.toLowerCase();
  if (!email) {
    throw new Error("Supabase user has no email address");
  }

  const displayName = getDisplayName(user);
  const sql = getPostgresClient();
  const membership = await sql.begin((tx) =>
    selectAccountByEmail(tx, email, user.id, displayName)
  );
  const planKey = resolveBillingPlanKey(
    membership.plan_key,
    membership.plan_name,
    membership.subscription_status
  );

  return {
    supabaseUserId: user.id,
    localUserId: membership.user_id,
    teamId: membership.team_id,
    email: membership.email,
    displayName: membership.display_name || displayName,
    planKey,
    billingCycle: membership.billing_cycle === "yearly" ? "yearly" : "monthly",
    subscriptionStatus: membership.subscription_status,
    requestCreditBalanceCents: Math.max(
      0,
      Number(membership.ai_request_credit_balance_cents || 0)
    ),
    monthlyRequestCreditCents: Math.max(
      0,
      Number(membership.ai_monthly_request_credit_cents || 0)
    ),
    freeRequestsUsed: Math.max(0, Number(membership.ai_free_requests_used || 0)),
    currentPeriodEnd: membership.ai_credit_period_end
      ? membership.ai_credit_period_end.toISOString()
      : null,
  };
}

export async function requireAccount(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  try {
    const token = extractBearerToken(req);

    if (!token) {
      res.status(401).json({
        success: false,
        error: "Please sign in to continue.",
      });
      return;
    }

    const supabaseUser = await getSupabaseUser(token);

    if (!supabaseUser) {
      res.status(401).json({
        success: false,
        error: "Your session is invalid or expired. Please sign in again.",
      });
      return;
    }

    req.account = await ensureAccountForSupabaseUser(supabaseUser);
    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not verify account access",
    });
  }
}

async function recordUsageEvent({
  account,
  eventType,
  requestCreditCents = 0,
  balanceAfterCents,
  provider = "klawpen-core",
  model,
  metadata,
}: {
  account: AuthenticatedAccount;
  eventType: "request" | "request_denied";
  requestCreditCents?: number;
  balanceAfterCents?: number | null;
  provider?: string;
  model?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const sql = getPostgresClient();

  await sql`
    insert into ai_usage_events (
      team_id,
      user_id,
      event_type,
      provider,
      model,
      request_credit_cents,
      estimated_cost_cents,
      balance_after_cents,
      metadata
    )
    values (
      ${account.teamId},
      ${account.localUserId},
      ${eventType},
      ${provider},
      ${model || null},
      ${requestCreditCents},
      0,
      ${balanceAfterCents ?? null},
      ${metadata ? JSON.stringify(metadata) : null}
    )
  `;
}

export type AiRequestConsumptionResult =
  | {
      allowed: true;
      balanceAfterCents: number;
      freeRequestsRemaining: number;
    }
  | {
      allowed: false;
      reason: "free_limit_reached" | "insufficient_credit";
      balanceAfterCents: number;
      freeRequestsRemaining: number;
    };

export async function consumeAiRequestCredit({
  account,
  requestCreditCents = DEFAULT_REQUEST_CREDIT_CENTS,
  model,
  metadata,
}: {
  account: AuthenticatedAccount;
  requestCreditCents?: number;
  model?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<AiRequestConsumptionResult> {
  const sql = getPostgresClient();

  if (account.planKey === "free") {
    const [updatedTeam] = await sql<{ ai_free_requests_used: number }[]>`
      update teams
      set ai_free_requests_used = ai_free_requests_used + 1,
          updated_at = now()
      where id = ${account.teamId}
        and ai_free_requests_used < ${FREE_REQUEST_LIMIT}
      returning ai_free_requests_used
    `;

    if (!updatedTeam) {
      await recordUsageEvent({
        account,
        eventType: "request_denied",
        model,
        metadata: {
          ...metadata,
          reason: "free_limit_reached",
          freeRequestLimit: FREE_REQUEST_LIMIT,
        },
      });

      return {
        allowed: false,
        reason: "free_limit_reached",
        balanceAfterCents: 0,
        freeRequestsRemaining: 0,
      };
    }

    const freeRequestsRemaining = Math.max(
      0,
      FREE_REQUEST_LIMIT - updatedTeam.ai_free_requests_used
    );

    await recordUsageEvent({
      account,
      eventType: "request",
      model,
      metadata: {
        ...metadata,
        freeRequestsRemaining,
      },
    });

    return {
      allowed: true,
      balanceAfterCents: 0,
      freeRequestsRemaining,
    };
  }

  const [updatedTeam] = await sql<
    { ai_request_credit_balance_cents: number }[]
  >`
    update teams
    set ai_request_credit_balance_cents =
          ai_request_credit_balance_cents - ${requestCreditCents},
        updated_at = now()
    where id = ${account.teamId}
      and ai_request_credit_balance_cents >= ${requestCreditCents}
    returning ai_request_credit_balance_cents
  `;

  if (!updatedTeam) {
    await recordUsageEvent({
      account,
      eventType: "request_denied",
      requestCreditCents,
      balanceAfterCents: account.requestCreditBalanceCents,
      model,
      metadata: {
        ...metadata,
        reason: "insufficient_credit",
      },
    });

    return {
      allowed: false,
      reason: "insufficient_credit",
      balanceAfterCents: account.requestCreditBalanceCents,
      freeRequestsRemaining: 0,
    };
  }

  await recordUsageEvent({
    account,
    eventType: "request",
    requestCreditCents,
    balanceAfterCents: updatedTeam.ai_request_credit_balance_cents,
    model,
    metadata,
  });

  return {
    allowed: true,
    balanceAfterCents: updatedTeam.ai_request_credit_balance_cents,
    freeRequestsRemaining: 0,
  };
}

export function buildAccountSnapshot(account: AuthenticatedAccount) {
  const monthlyLimit =
    account.planKey === "free"
      ? FREE_REQUEST_LIMIT
      : Math.max(0, Math.floor(account.monthlyRequestCreditCents / CREDIT_UNIT_CENTS));
  const monthlyUsed =
    account.planKey === "free"
      ? account.freeRequestsUsed
      : Math.max(
          0,
          monthlyLimit -
            Math.floor(
              account.requestCreditBalanceCents / CREDIT_UNIT_CENTS
            )
        );

  return {
    profile: {
      userId: String(account.localUserId),
      email: account.email,
      displayName: account.displayName,
      avatarUrl: null,
      isAuthenticated: true,
    },
    entitlements: {
      plan: mapPlanToDashboard(account.planKey),
      subscriptionStatus: account.subscriptionStatus || account.planKey,
      balanceCents: account.requestCreditBalanceCents,
      apiAccessEnabled:
        account.planKey !== "free" ||
        account.freeRequestsUsed < FREE_REQUEST_LIMIT,
      monthlyAiLimit: monthlyLimit,
      monthlyAiUsed: Math.min(monthlyUsed, monthlyLimit),
      currentPeriodEnd: account.currentPeriodEnd,
    },
    setupRequired: false,
  };
}
