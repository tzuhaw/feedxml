import { NextResponse, type NextRequest } from "next/server";

/**
 * A cheap routing hint, NOT the security boundary. Credentials live in the
 * database and Edge middleware cannot reach it, so real verification happens
 * in the /admin layout and again inside every server action.
 *
 * All this does is keep the destination when someone with no session at all
 * follows a deep link — /admin/runs?state=failed comes back after signing in
 * instead of dumping them on the overview. A present-but-invalid cookie falls
 * through to the layout, which redirects (and cannot loop, because this only
 * ever redirects when the cookie is absent).
 */
export const config = { matcher: ["/admin/:path*"] };

export function middleware(req: NextRequest): NextResponse {
  if (req.cookies.has("feedxml_session")) return NextResponse.next();

  const login = new URL("/", req.url);
  const target = req.nextUrl.pathname + req.nextUrl.search;
  if (target !== "/admin") login.searchParams.set("next", target);
  return NextResponse.redirect(login);
}
