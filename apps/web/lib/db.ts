import { Pool } from "pg";

// Serverless-friendly singleton. Sprint 3 note: switch to the Supabase pooler
// (transaction mode) before real traffic; direct connections are for the worker.
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // The panel renders several queries per page (and the Consequence Preview
    // is a heavy scan), so a single connection would serialize them.
    pool = new Pool({ connectionString: url, max: 4 });
  }
  return pool;
}
