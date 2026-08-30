import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Applies supabase/migrations/*.sql in order to DATABASE_URL, tracking what
 * has run so it is safe to re-run. This is for LOCAL databases; production
 * migrations go through Supabase.
 *
 *   npm run db:migrate                 # uses the compose Postgres
 *   npm run db:migrate -- --reset      # drop and rebuild from scratch
 */
const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../supabase/migrations");
const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:55432/postgres";

if (!/localhost|127\.0\.0\.1/.test(url) && process.env.ALLOW_REMOTE !== "1") {
  throw new Error(`refusing to migrate a non-local database (${new URL(url).host})`);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  if (process.argv.includes("--reset")) {
    await pool.query("drop schema public cascade; create schema public;");
    console.log("schema reset");
  }
  await pool.query(
    `create table if not exists schema_migrations (
       name text primary key, applied_at timestamptz not null default now())`,
  );
  const applied = new Set(
    (await pool.query("select name from schema_migrations")).rows.map((r) => r.name),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    await pool.query(readFileSync(join(dir, file), "utf8"));
    await pool.query("insert into schema_migrations (name) values ($1)", [file]);
    console.log(`applied ${file}`);
    ran += 1;
  }
  console.log(ran === 0 ? "already up to date" : `${ran} migration(s) applied`);
} finally {
  await pool.end();
}
