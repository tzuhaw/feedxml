import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { audit } from "@feedxml/domain";

/**
 * Create or re-password an operator account.
 *   DATABASE_URL=… node dist/adminuser.js <username> [--password <value>]
 *
 * With no --password a strong one is generated and printed ONCE; only the
 * bcrypt hash is stored. Changing a password takes effect immediately —
 * no redeploy — and existing sessions for that user keep working until they
 * expire, so rotate and then remove the account if you need to cut access now.
 *
 *   ... --remove   deletes the account, ending its sessions immediately.
 */
const USERNAME = /^[a-z0-9][a-z0-9_.-]{1,62}$/;

async function main(): Promise<void> {
  const [username, ...rest] = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL;
  if (!username || !databaseUrl) {
    throw new Error(
      "usage: DATABASE_URL=… node dist/adminuser.js <username> [--password <value>] [--remove]",
    );
  }
  if (!USERNAME.test(username)) {
    throw new Error(`username must match ${USERNAME} (lowercase, 2-63 chars)`);
  }

  const remove = rest.includes("--remove");
  const passwordFlag = rest.indexOf("--password");
  const supplied = passwordFlag >= 0 ? rest[passwordFlag + 1] : undefined;
  if (passwordFlag >= 0 && !supplied) throw new Error("--password needs a value");

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    if (remove) {
      const gone = await pool.query(`delete from admin_users where username = $1`, [username]);
      if (gone.rowCount === 0) throw new Error(`no operator named ${username}`);
      await audit(pool, "system", "remove_admin_user", { username });
      console.log(`removed operator ${username}; their sessions no longer verify`);
      return;
    }

    const password = supplied ?? randomBytes(15).toString("base64url");
    const hash = await bcrypt.hash(password, 12);
    const existing = await pool.query(
      `insert into admin_users (username, password_hash) values ($1, $2)
       on conflict (username) do update set password_hash = excluded.password_hash
       returning (xmax = 0) as created`,
      [username, hash],
    );
    const created: boolean = existing.rows[0].created;
    await audit(pool, "system", created ? "create_admin_user" : "reset_admin_password", {
      username,
    });

    console.log(`${created ? "created" : "updated"} operator: ${username}`);
    if (!supplied) console.log(`password (shown once, store it now): ${password}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
