import { fallbackAccountSnapshot, type AccountSnapshot } from "./types";

export const fetchAccountSnapshot = async (): Promise<AccountSnapshot> => {
  try {
    const response = await fetch("/api/account/me", { cache: "no-store" });
    if (!response.ok) return fallbackAccountSnapshot;

    const payload = (await response.json()) as AccountSnapshot;
    return {
      profile: {
        ...fallbackAccountSnapshot.profile,
        ...(payload.profile || {}),
      },
      entitlements: {
        ...fallbackAccountSnapshot.entitlements,
        ...(payload.entitlements || {}),
      },
      setupRequired: Boolean(payload.setupRequired),
    };
  } catch {
    return fallbackAccountSnapshot;
  }
};
