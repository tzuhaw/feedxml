import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

/**
 * Disposable-database helpers shared by the integration harness and the load
 * test. Everything here assumes it may DROP SCHEMA public — hence the guard.
 */

export function connectDisposable(url: string | undefined): Pool {
  if (!url) throw new Error("TEST_DATABASE_URL not set");
  const local = /localhost|127\.0\.0\.1/.test(url);
  if (!local && process.env.TEST_DATABASE_ALLOW_REMOTE !== "1") {
    throw new Error(
      "TEST_DATABASE_URL is not local; set TEST_DATABASE_ALLOW_REMOTE=1 only for a dedicated, disposable test database",
    );
  }
  return new Pool({ connectionString: url, max: 4 });
}

/** Wipe and rebuild the schema from the real migration files. */
export async function migrateDisposable(pool: Pool): Promise<void> {
  await pool.query("drop schema public cascade; create schema public;");
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = resolve(here, "../../supabase/migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    await pool.query(readFileSync(join(migrationsDir, file), "utf8"));
  }
}
