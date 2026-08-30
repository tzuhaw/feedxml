import { NextResponse } from "next/server";
import { SESSION_COOKIE, adminConfigured, issueSession, verifyCredentials } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign in and out. A plain route handler rather than a server action, for two
 * reasons: the form works with no JavaScript, and the most security-critical
 * path in the app stays testable over plain HTTP instead of only through
 * React's RSC wire format.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    // No body, or not form-encoded: a malformed request, not a server fault.
    const url = new URL("/", req.url);
    url.searchParams.set("error", "credentials");
    return NextResponse.redirect(url, 303);
  }

  if (form.get("intent") === "signout") {
    const res = NextResponse.redirect(new URL("/", req.url), 303);
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  const user = String(form.get("user") ?? "");
  const password = String(form.get("password") ?? "");
  const requested = String(form.get("next") ?? "/admin");
  // Only ever return to a path inside the panel — never an absolute URL.
  const next = requested.startsWith("/admin") ? requested : "/admin";

  const back = (reason: string): NextResponse => {
    const url = new URL("/", req.url);
    url.searchParams.set("error", reason);
    if (next !== "/admin") url.searchParams.set("next", next);
    return NextResponse.redirect(url, 303);
  };

  if (!(await adminConfigured())) return back("unconfigured");
  // One outcome for a wrong username and a wrong password alike.
  if (!(await verifyCredentials(user, password))) return back("credentials");

  const session = await issueSession(user);
  const res = NextResponse.redirect(new URL(next, req.url), 303);
  res.cookies.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: session.maxAge,
  });
  return res;
}
