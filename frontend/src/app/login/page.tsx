import Link from "next/link";

export default function LoginRedirectPage() {
  const loginUrl = process.env.AUTH_REDIRECT_URL || "https://klawpen.com/sign-in";

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0f1115] px-6 text-slate-100">
      <section className="w-full max-w-md rounded-2xl border border-slate-700/70 bg-slate-900/70 p-6 text-center">
        <h1 className="text-xl font-semibold">Sign In Required</h1>
        <p className="mt-2 text-sm text-slate-300">
          Klawpen Builder'a erişmek için önce Klawpen hesabına giriş yapman gerekiyor.
        </p>
        <p className="mt-3 text-xs text-slate-400">
          Giriş yaptıktan sonra otomatik olarak çalışma alanına geri döneceksin.
        </p>
        <Link
          href={loginUrl}
          className="mt-5 inline-flex rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Sign in on Klawpen
        </Link>
      </section>
    </main>
  );
}