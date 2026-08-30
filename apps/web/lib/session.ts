import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { getPool } from "@/lib/db";

/**
 * Admin sessions: an HMAC-signed cookie whose key and credentials both live in
 * the database, not in deployment configuration. Rotating an operator's
 * password or revoking their account takes effect immediately, with no
 * redeploy and no secret sitting in a platform's env store.
 *
 * Because verification needs the database, it happens in the Node runtime —
 * the /admin layout and the server actions — rather than in Edge middleware.
 */

export const SESSION_COOKIE = "feedxml_session";
const MAX_AGE_SECONDS = 12 * 60 * 60;
const SIGNING_KEY_NAME = "session_signing_key";

/**
 * The signing key, created on first use so a fresh deployment needs no manual
 * secret. Deliberately NOT cached: rotating this row is the emergency lever
 * that invalidates every live session, and a cache would delay that by however
 * long the cache lives. It is a primary-key lookup on a one-row table.
 */
async function signingKey(): Promise<string> {
  const pool = getPool();
  const existing = await pool.query(`select value from app_secrets where name = $1`, [
    SIGNING_KEY_NAME,
  ]);
  let value: string;
  if (existing.rowCount === 1) {
    value = existing.rows[0].value;
  } else {
    // Concurrent instances may race here; ON CONFLICT makes the first one win
    // and every other instance adopt the same key.
    const created = await pool.query(
      `insert into app_secrets (name, value) values ($1, $2)
       on conflict (name) do update set name = excluded.name
       returning value`,
      [SIGNING_KEY_NAME, randomBytes(32).toString("base64url")],
    );
    value = created.rows[0].value;
  }
  return value;
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`feedxml.session.v2:${await signingKey()}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sign(payload: string): Promise<string> {
  return toBase64Url(
    await crypto.subtle.sign("HMAC", await hmacKey(), new TextEncoder().encode(payload)),
  );
}

/** Checks a submitted username and password against the admin_users table. */
export async function verifyCredentials(user: string, password: string): Promise<boolean> {
  const row = await getPool().query(
    `select password_hash from admin_users where username = $1`,
    [user],
  );
  if (row.rowCount === 0) {
    // Spend comparable time on an unknown user so existence isn't timeable.
    await bcrypt.compare(password, "$2a$12$1234567890123456789012345678901234567890123456789012");
    return false;
  }
  const ok = await bcrypt.compare(password, row.rows[0].password_hash);
  if (ok) {
    await getPool().query(
      `update admin_users set last_login_at = now() where username = $1`,
      [user],
    );
  }
  return ok;
}

export async function issueSession(user: string): Promise<{ token: string; maxAge: number }> {
  const expires = Date.now() + MAX_AGE_SECONDS * 1000;
  const payload = `${user}.${expires}`;
  return { token: `${payload}.${await sign(payload)}`, maxAge: MAX_AGE_SECONDS };
}

/**
 * The admin identity carried by a valid, unexpired token — or null. The user
 * must still exist, so revoking an account ends its sessions immediately.
 */
export async function readSession(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [user, expiresRaw, signature] = parts as [string, string, string];

  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || Date.now() > expires) return null;

  if (!timingSafeEqual(signature, await sign(`${user}.${expiresRaw}`))) return null;

  const still = await getPool().query(`select 1 from admin_users where username = $1`, [user]);
  return still.rowCount === 1 ? user : null;
}

/** True when at least one operator account exists to sign in as. */
export async function adminConfigured(): Promise<boolean> {
  const row = await getPool().query(`select 1 from admin_users limit 1`);
  return row.rowCount === 1;
}
