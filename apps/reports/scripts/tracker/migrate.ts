// Applies the Project Tracker's database migrations: every .sql file in
// db/tracker/migrations, in name order, each one once and in its own transaction.
//
//   npm run db:tracker-migrate                  apply anything not yet applied
//   npm run db:tracker-migrate -- --dev-logins  also create the two local dev logins
//
// Needs TRACKER_ADMIN_DATABASE_URL: a postgres:// connection string for a login that may
// create schemas and roles. That is NOT the login the app runs as. The app uses
// TRACKER_DATABASE_URL (tracker_service) and the forecast job uses
// TRACKER_ENGINE_DATABASE_URL (tracker_engine), neither of which can change the schema.
//
// What has been applied is recorded in public.tracker_schema_migration. An applied file is
// never run again, so a change to the schema is always a new numbered file, never an edit.
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/tracker/migrations/", import.meta.url));
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Dev only. A password in a file is acceptable for a database that listens on loopback and holds
// fake data; --dev-logins refuses to run against anything else.
const DEV_LOGINS = `
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_app') THEN
        CREATE ROLE tracker_app LOGIN PASSWORD 'devpassword' IN ROLE tracker_service;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_forecast') THEN
        CREATE ROLE tracker_forecast LOGIN PASSWORD 'devpassword' IN ROLE tracker_engine;
    END IF;
END $$;
`;

async function main() {
  const url = process.env.TRACKER_ADMIN_DATABASE_URL?.trim();
  if (!url) throw new Error("Set TRACKER_ADMIN_DATABASE_URL (a login that may create schemas and roles).");
  const devLogins = process.argv.includes("--dev-logins");
  const host = new URL(url).hostname;
  if (devLogins && !LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing --dev-logins: the database host is ${host}, not this machine.`);
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  if (files.length === 0) throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public.tracker_schema_migration (
         name       text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (await client.query<{ name: string }>(`SELECT name FROM public.tracker_schema_migration`)).rows.map(
        (r) => r.name,
      ),
    );

    let applied = 0;
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(MIGRATIONS_DIR + file, "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(`INSERT INTO public.tracker_schema_migration (name) VALUES ($1)`, [file]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`${file} failed and was rolled back: ${e instanceof Error ? e.message : String(e)}`);
      }
      // A migration may set a search path for its own convenience; do not let it leak into the next.
      await client.query("RESET search_path");
      console.log(`applied ${file}`);
      applied++;
    }
    console.log(applied === 0 ? "nothing to apply: the schema is up to date" : `${applied} migration(s) applied`);

    if (devLogins) {
      await client.query(DEV_LOGINS);
      console.log("dev logins ready: tracker_app (service) and tracker_forecast (engine)");
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
