import "server-only";

import { Pool } from "pg";
import type { Database } from "./service/database";

// The tracker's own PostgreSQL connection. Only files in ./service import this (see
// docs/MODULES.md): pages, actions and route handlers call service functions instead.
//
// TRACKER_DATABASE_URL is a postgres:// connection string for a login that holds the
// tracker_service role (db/tracker/migrations/0002_roles.sql). The forecast job uses
// TRACKER_ENGINE_DATABASE_URL, a login holding tracker_engine, which can write only the
// forecast tables.

export function trackerConfigured(): boolean {
  return !!process.env.TRACKER_DATABASE_URL?.trim();
}

const pools = new Map<string, Pool>();

function poolFor(envName: string): Pool {
  const url = process.env[envName]?.trim();
  if (!url) throw new Error(`The Project Tracker database is not configured: set ${envName} in .env.`);
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
    pools.set(url, pool);
  }
  return pool;
}

function databaseFor(envName: string): Database {
  return {
    async transaction(fn) {
      const client = await poolFor(envName).connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async (sql, params) => {
            const r = await client.query(sql, params as unknown[] | undefined);
            return { rows: r.rows };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

/** For everything people do: projects, tasks, statuses, history. */
export const trackerDb: Database = databaseFor("TRACKER_DATABASE_URL");

/** For the forecast job only. */
export const trackerEngineDb: Database = databaseFor("TRACKER_ENGINE_DATABASE_URL");

export async function closeTrackerPools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}
