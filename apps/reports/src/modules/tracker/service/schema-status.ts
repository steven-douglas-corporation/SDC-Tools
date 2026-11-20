import type { Database } from "./database";

// Is the database as new as this code?
//
// A change to the tracker's tables is a numbered file in db/tracker/migrations, applied by
// scripts/tracker/migrate.ts or migrate-server.ps1, which record each applied file in
// public.tracker_schema_migration. Code deployed ahead of its migrations fails in odd places
// (a missing column on one screen, a refused save on another), so the tracker's pages and API
// ask this first and say what is wrong in one sentence.

/**
 * Every migration this code needs, oldest first. Adding a file to db/tracker/migrations means
 * adding its name here; a test fails until the two lists match.
 */
export const MIGRATIONS = [
  "0001_schema.sql",
  "0002_roles.sql",
  "0003_work_kinds.sql",
  "0004_count_work_cards.sql",
  "0005_kind_required.sql",
  "0006_requested_by.sql",
  "0007_checklist.sql",
  "0008_migration_record_readable.sql",
  "0009_project_priority_dropped.sql",
  "0010_project_justification.sql",
  "0011_project_for_department.sql",
  "0012_project_done_by_department.sql",
] as const;

/** `missing` is null when the record itself cannot be read, which is true of any database older than 0008. */
export type SchemaStatus = { current: true } | { current: false; missing: string[] | null };

// A database does not go backwards while the app runs, so a yes is remembered for the life of
// the process. A no is asked again every time, so the screens come back as soon as it is fixed.
const confirmed = new WeakSet<Database>();

const UNDEFINED_TABLE = "42P01";
const INSUFFICIENT_PRIVILEGE = "42501";

export async function getSchemaStatus(db: Database): Promise<SchemaStatus> {
  if (confirmed.has(db)) return { current: true };
  let applied: Set<string>;
  try {
    applied = await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ name: string }>(`SELECT name FROM public.tracker_schema_migration`);
      return new Set(rows.map((r) => r.name));
    });
  } catch (e) {
    // No record, or no right to read it: 0008 grants that right, so 0008 has not been applied.
    const code = (e as { code?: unknown } | null)?.code;
    if (code === UNDEFINED_TABLE || code === INSUFFICIENT_PRIVILEGE) return { current: false, missing: null };
    throw e;
  }
  const missing = MIGRATIONS.filter((m) => !applied.has(m));
  if (missing.length > 0) return { current: false, missing };
  confirmed.add(db);
  return { current: true };
}

/** What is missing and who fixes it, for the screen and the API. */
export function schemaBehindDetail(status: { missing: string[] | null }): string {
  const what =
    status.missing == null
      ? "The record of applied migrations cannot be read, so at least 0008_migration_record_readable.sql is missing."
      : `Missing: ${status.missing.join(", ")}.`;
  return `${what} An administrator applies them with apps\\reports\\scripts\\tracker\\migrate-server.ps1 (on a development machine: npm run db:tracker-migrate).`;
}
