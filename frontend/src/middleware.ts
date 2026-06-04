import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

const publicPathPrefixes = ["/login", "/auth/bridge"];
const assetPathPrefixes = ["/_next", "/favicon.ico"];

const isPublicPath = (pathname: string) =>
  publicPathPrefixes.some((prefix) => pathname.startsWith(prefix)) ||
  assetPathPrefixes.some((prefix) => pathname.startsWith(prefix)) ||
  /\.(?:png|jpg|jpeg|gif|webp|svg|ico|ttf|woff|woff2|mp4)$/i.test(pathname);

const getAuthRedirectUrl = (request: NextRequest) => {
  const configuredUrl =
    process.env.AUTH_REDIRECT_URL || "https://klawpen.com/auth/builder-bridge";
  const redirectUrl = new URL(configuredUrl);

  redirectUrl.searchParams.set(
    "next",
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  );

  return redirectUrl;
};

export async function middleware(request: NextRequest) {
  const { response, user } = await updateSession(request);
  const { pathname } = request.nextUrl;

  if (!user && !isPublicPath(pathname) && !pathname.startsWith("/api")) {
    return NextResponse.redirect(getAuthRedirectUrl(request));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
