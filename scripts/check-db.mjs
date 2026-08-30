import pg from "pg";

/**
 * Works out the connection string this project needs, and proves it connects.
 *
 *   $env:SUPABASE_PASSWORD = "your-database-password"
 *   node scripts/check-db.mjs
 *
 * Supabase gives every project two hosts and they are not interchangeable:
 *
 *   db.<ref>.supabase.co       direct, IPv6-only — fine for the Cloud Run
 *                              worker, unreachable from Vercel's functions
 *   aws-N-<region>.pooler…     the connection pooler, IPv4 — what serverless
 *                              needs, and note the username carries the
 *                              project ref: postgres.<ref>, not postgres
 *
 * Nothing is printed that contains the password.
 */
const REF = process.env.SUPABASE_REF ?? "cybwqfnxxrfhybxufmat";
const REGION = process.env.SUPABASE_REGION ?? "ap-southeast-1";
const password = process.env.SUPABASE_PASSWORD;

if (!password) {
  console.error('Set your password first:  $env:SUPABASE_PASSWORD = "…"');
  process.exit(1);
}

const candidates = [
  { label: "transaction pooler (aws-0)", host: `aws-0-${REGION}.pooler.supabase.com`, port: 6543, user: `postgres.${REF}` },
  { label: "transaction pooler (aws-1)", host: `aws-1-${REGION}.pooler.supabase.com`, port: 6543, user: `postgres.${REF}` },
  { label: "session pooler (aws-0)", host: `aws-0-${REGION}.pooler.supabase.com`, port: 5432, user: `postgres.${REF}` },
  { label: "session pooler (aws-1)", host: `aws-1-${REGION}.pooler.supabase.com`, port: 5432, user: `postgres.${REF}` },
];

let winner = null;
for (const c of candidates) {
  const url = `postgresql://${c.user}:${encodeURIComponent(password)}@${c.host}:${c.port}/postgres`;
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 8000 });
  try {
    await pool.query("select 1");
    console.log(`  WORKS   ${c.label}`);
    winner ??= { ...c, url };
  } catch (err) {
    console.log(`  fails   ${c.label}  (${err.message.split("\n")[0]})`);
  } finally {
    await pool.end().catch(() => {});
  }
}

if (!winner) {
  console.error("\nNone connected. If every line says password authentication failed, the password is wrong.");
  process.exit(1);
}

console.log(`\nUse this one — it is on your clipboard-safe line below, with the password in it:\n`);
console.log(winner.url);
console.log(`
Next:
  1. $env:DATABASE_URL = "<the line above>"
  2. node worker/dist/adminuser.js admin       (if no operator exists yet)
  3. vercel env rm DATABASE_URL production --yes
  4. vercel env add DATABASE_URL production    (paste the same line)
`);
