"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

const extractHashTokens = () => {
  if (typeof window === "undefined") return { accessToken: null, refreshToken: null };

  const rawHash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const hashParams = new URLSearchParams(rawHash);
  return {
    accessToken: hashParams.get("access_token"),
    refreshToken: hashParams.get("refresh_token"),
  };
};

function AuthBridgeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"loading" | "error">("loading");

  const nextPath = useMemo(
    () => searchParams.get("next") || "/",
    [searchParams]
  );

  useEffect(() => {
    const applySession = async () => {
      const queryAccessToken = searchParams.get("access_token");
      const queryRefreshToken = searchParams.get("refresh_token");
      const hashTokens = extractHashTokens();

      const accessToken = queryAccessToken || hashTokens.accessToken;
      const refreshToken = queryRefreshToken || hashTokens.refreshToken;

      if (!accessToken || !refreshToken) {
        setStatus("error");
        return;
      }

      const supabase = createClient();
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      if (error) {
        setStatus("error");
        return;
      }

      router.replace(nextPath);
      router.refresh();
    };

    applySession().catch(() => setStatus("error"));
  }, [nextPath, router, searchParams]);

  return (
    <>
      {status === "loading" ? (
        <>
          <h1 className="text-xl font-semibold">Signing you in...</h1>
          <p className="mt-2 text-sm text-slate-300">
            Klawpen oturumun builder çalışma alanına aktarılıyor.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold">Session transfer failed</h1>
          <p className="mt-2 text-sm text-slate-300">
            Oturum bilgisi bulunamadı veya süresi doldu. Lütfen Klawpen üzerinden tekrar giriş yap.
          </p>
        </>
      )}
    </>
  );
}

export default function AuthBridgePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0f1115] px-6 text-slate-100">
      <section className="w-full max-w-md rounded-2xl border border-slate-700/70 bg-slate-900/70 p-6 text-center">
        <Suspense fallback={<p className="text-sm text-slate-300">Loading...</p>}>
          <AuthBridgeContent />
        </Suspense>
      </section>
    </main>
  );
}