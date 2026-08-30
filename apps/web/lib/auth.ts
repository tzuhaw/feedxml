import { timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Pool } from "pg";

export function secretsMatch(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SupplierIdentity {
  id: string;
  name: string;
}

/**
 * Supplier authentication for the push channel: `x-supplier-id` + `x-api-key`
 * headers, bcrypt-compared against the stored hash. The two-credential
 * contract exists because bcrypt hashes can't be looked up by value
 * (DESIGN.md decision 15).
 */
export async function authenticateSupplier(
  pool: Pool,
  req: Request,
): Promise<SupplierIdentity | null> {
  const supplierId = req.headers.get("x-supplier-id");
  const apiKey = req.headers.get("x-api-key");
  if (!supplierId || !apiKey || !/^[0-9a-f-]{36}$/.test(supplierId)) return null;
  const row = await pool.query(
    `select id, name, api_key_hash from suppliers where id = $1`,
    [supplierId],
  );
  if (row.rowCount === 0 || !row.rows[0].api_key_hash) return null;
  const ok = await bcrypt.compare(apiKey, row.rows[0].api_key_hash);
  return ok ? { id: row.rows[0].id, name: row.rows[0].name } : null;
}
