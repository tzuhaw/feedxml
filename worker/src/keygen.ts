import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

/**
 * Issue (or rotate) a supplier API key for the push channel.
 *   DATABASE_URL=... node dist/keygen.js <supplier-name>
 * Prints the key ONCE — only the bcrypt hash is stored (DESIGN.md decision 15).
 */
async function main(): Promise<void> {
  const name = process.argv[2];
  const databaseUrl = process.env.DATABASE_URL;
  if (!name || !databaseUrl) {
    throw new Error("usage: DATABASE_URL=... node dist/keygen.js <supplier-name>");
  }

  const apiKey = `fxk_${randomBytes(24).toString("base64url")}`;
  const hash = await bcrypt.hash(apiKey, 12);

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const supplier = await pool.query(
      `insert into suppliers (name, api_key_hash) values ($1, $2)
       on conflict (name) do update set api_key_hash = excluded.api_key_hash
       returning id`,
      [name, hash],
    );
    await pool.query(
      `insert into audit_log (actor, action, subject) values ('system', 'issue_api_key', $1)`,
      [JSON.stringify({ supplier_id: supplier.rows[0].id, supplier_name: name })],
    );
    console.log(`supplier: ${name}`);
    console.log(`supplier_id: ${supplier.rows[0].id}`);
    console.log(`api_key (shown once, store it now): ${apiKey}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
