import "server-only";

import { Pool } from "pg";

// ── The DataWarehouse: PostgreSQL, read-only (2026-10-04) ─────────────────────
//
// Since 2026-10-04 the Paylocity files no longer stay on the SFTP share: the
// warehouse loader (tools/data-warehouse) copies each one, loads it, and deletes
// it from the server. So the three Paylocity readers — hours (paylocity-workbook.ts),
// the roster and position families (paylocity-warehouse.ts) — read the warehouse
// instead of the share.
//
// DATAWAREHOUSE_URL is a postgres:// connection string for the read-only
// `reports_app` login (tools/data-warehouse/sql/05_access.sql). Set means "read
// Paylocity from the warehouse"; unset means the old *_LOCAL_PATH file settings
// still apply. Never both: when it is set and the warehouse can't be read, the
// step fails the way an unreadable file did. Falling back to a file would answer
// with whatever stale copy happened to be lying around, which is the failure
// paylocity-sources.ts's "no default path" note exists to prevent.
//
// Names in the warehouse are PascalCase and so are always double-quoted in SQL.

export function warehouseConfigured(): boolean {
  return !!process.env.DATAWAREHOUSE_URL?.trim();
}

let pool: Pool | null = null;

function getPool(): Pool {
  const url = process.env.DATAWAREHOUSE_URL?.trim();
  if (!url) throw new Error("The DataWarehouse is not configured: set DATAWAREHOUSE_URL in .env.");
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
    // An idle connection the server drops (a Postgres restart, a network blip) is
    // reported as an "error" event on the pool. With no listener, Node treats it as
    // unhandled and the whole app process exits. Log it instead: pg has already
    // discarded that connection, and the next query opens a fresh one. (2026-10-04,
    // found when Postgres moved to a Windows service and was restarted.)
    pool.on("error", (err) => console.error("[data-warehouse] idle connection lost:", err.message));
  }
  return pool;
}

export type WarehouseQuery = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/**
 * Run several reads against one consistent snapshot of the warehouse. The loader
 * replaces whole years of hours in one transaction; without a snapshot, a read
 * that straddled that moment could pair one file version's identity with the
 * next version's rows.
 */
export async function warehouseSnapshot<R>(fn: (query: WarehouseQuery) => Promise<R>): Promise<R> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const query: WarehouseQuery = async <T>(sql: string, params: unknown[] = []) =>
      (await client.query(sql, params)).rows as T[];
    const result = await fn(query);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
