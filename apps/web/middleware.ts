import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, adminConfigured, readSession } from "@/lib/session";

/**
 * The admin panel mutates the live catalog, so it is never public. Access is a
 * signed session cookie issued by the login page — not HTTP Basic, which hands
 * the browser's own dialog to an operator and can't be signed out of.
 *
 * Without credentials configured the panel refuses to serve at all: an
 * unprotected panel must never be the fallback.
 */
export const config = { matcher: ["/admin/:path*"] };

export async function middleware(req: NextRequest): Promise<NextResponse> {
  if (!adminConfigured()) {
    return new NextResponse(
      "Admin panel is not configured (ADMIN_USER / ADMIN_PASSWORD).",
      { status: 503, headers: { "content-type": "text/plain" } },
    );
  }

  const user = await readSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (user) return NextResponse.next();

  const login = new URL("/", req.url);
  // Come back to whatever they were reaching for, once signed in.
  const target = req.nextUrl.pathname + req.nextUrl.search;
  if (target && target !== "/admin") login.searchParams.set("next", target);
  return NextResponse.redirect(login);
}
