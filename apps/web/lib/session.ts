/**
 * Admin sessions: an HMAC-signed cookie, verified in both the Edge middleware
 * and Node server actions — so one implementation guards every entrance.
 *
 * The signing key is derived from ADMIN_PASSWORD, which gives rotation for
 * free: change the password and every existing session stops verifying.
 */

export const SESSION_COOKIE = "feedxml_session";
const MAX_AGE_SECONDS = 12 * 60 * 60;

function creds(): { user: string; password: string } | null {
  const user = process.env.ADMIN_USER;
  const password = process.env.ADMIN_PASSWORD;
  return user && password ? { user, password } : null;
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`feedxml.session.v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string compare — both operands are fixed-length hex/base64url. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Issues a session token for a verified admin. Returns null if unconfigured. */
export async function issueSession(): Promise<{ token: string; maxAge: number } | null> {
  const c = creds();
  if (!c) return null;
  const expires = Date.now() + MAX_AGE_SECONDS * 1000;
  const payload = `${c.user}.${expires}`;
  const signature = await crypto.subtle.sign("HMAC", await key(c.password), new TextEncoder().encode(payload));
  return { token: `${payload}.${toBase64Url(signature)}`, maxAge: MAX_AGE_SECONDS };
}

/** The admin identity carried by a valid, unexpired token — or null. */
export async function readSession(token: string | undefined): Promise<string | null> {
  const c = creds();
  if (!c || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [user, expiresRaw, signature] = parts as [string, string, string];

  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || Date.now() > expires) return null;
  if (user !== c.user) return null;

  const expected = toBase64Url(
    await crypto.subtle.sign("HMAC", await key(c.password), new TextEncoder().encode(`${user}.${expiresRaw}`)),
  );
  return timingSafeEqual(signature, expected) ? user : null;
}

/** Checks a submitted username and password against the configured admin. */
export function credentialsMatch(user: string, password: string): boolean {
  const c = creds();
  if (!c) return false;
  // Compare both, without short-circuiting on the first mismatch.
  const userOk = timingSafeEqual(user, c.user);
  const passOk = timingSafeEqual(password, c.password);
  return userOk && passOk;
}

export function adminConfigured(): boolean {
  return creds() !== null;
}
