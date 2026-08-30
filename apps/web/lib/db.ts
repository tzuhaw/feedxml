import { Pool } from "pg";

// Serverless-friendly singleton. Sprint 3 note: switch to the Supabase pooler
// (transaction mode) before real traffic; direct connections are for the worker.
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // Supabase's direct host is IPv6-only and does not resolve from a
    // serverless function; the failure is otherwise an opaque ENOTFOUND at
    // query time, long after the misconfiguration.
    if (/@db\.[a-z0-9]+\.supabase\.co/.test(url) && process.env.VERCEL) {
      throw new Error(
        "DATABASE_URL points at Supabase's direct host, which is IPv6-only and unreachable from Vercel. " +
          "Use the transaction pooler instead: postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres",
      );
    }
    // The panel renders several queries per page (and the Consequence Preview
    // is a heavy scan), so a single connection would serialize them.
    pool = new Pool({ connectionString: url, max: 4 });
  }
  return pool;
}
