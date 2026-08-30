import { NextResponse, type NextRequest } from "next/server";

/**
 * The admin panel mutates the live catalog, so it is never public. HTTP Basic
 * over HTTPS against ADMIN_USER/ADMIN_PASSWORD — spartan by design for a small
 * ops team (DESIGN.md §7). Without credentials configured the panel refuses to
 * serve at all: an unprotected panel must never be the fallback.
 *
 * Runs on the Edge runtime, so the comparison uses Web Crypto rather than
 * node:crypto — constant-time via digest comparison of equal-length hashes.
 */
export const config = { matcher: ["/admin/:path*"] };

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function unauthorized(message: string): NextResponse {
  return new NextResponse(message, {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="feedxml admin", charset="UTF-8"' },
  });
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const user = process.env.ADMIN_USER;
  const password = process.env.ADMIN_PASSWORD;
  if (!user || !password) {
    return new NextResponse(
      "Admin panel is not configured (ADMIN_USER / ADMIN_PASSWORD).",
      { status: 503 },
    );
  }

  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return unauthorized("Authentication required");

  let provided: string;
  try {
    // atob yields one char per BYTE; decode those bytes as UTF-8 so that
    // non-ASCII credentials compare equal to the env values (browsers
    // base64-encode the UTF-8 form).
    const raw = atob(header.slice("Basic ".length));
    provided = new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
  } catch {
    return unauthorized("Malformed credentials");
  }
  // Compare digests: equal-length hex strings, so no length-based early exit.
  const [expectedHash, providedHash] = await Promise.all([
    sha256(`${user}:${password}`),
    sha256(provided),
  ]);
  let diff = 0;
  for (let i = 0; i < expectedHash.length; i++) {
    diff |= expectedHash.charCodeAt(i) ^ providedHash.charCodeAt(i);
  }
  if (diff !== 0) return unauthorized("Invalid credentials");

  return NextResponse.next();
}
