// What the tracker's service functions need from a database, and nothing more. Kept this small
// on purpose: production passes a PostgreSQL pool (../db.ts), tests pass an in-process Postgres
// (PGlite), and the service code cannot tell the difference.
//
// Every table name in the service is written with its schema (tracker.task), so nothing here
// depends on a search path.

export interface Tx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Database {
  /** Runs `fn` in one transaction: everything it does is saved together or not at all. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** The person doing something. Every change is recorded against them. */
export interface Actor {
  personId: number;
}

export type TrackerErrorCode = "not_found" | "forbidden" | "invalid" | "conflict";

/** A refusal the caller should show to the user, as opposed to a bug. */
export class TrackerError extends Error {
  readonly code: TrackerErrorCode;
  constructor(code: TrackerErrorCode, message: string) {
    super(message);
    this.name = "TrackerError";
    this.code = code;
  }
}

/** Exactly one row, or a not-found error. */
export async function one<T>(tx: Tx, sql: string, params: unknown[], what: string): Promise<T> {
  const { rows } = await tx.query<T>(sql, params);
  if (rows.length !== 1) throw new TrackerError("not_found", `${what} was not found.`);
  return rows[0] as T;
}

/** ISO date check for values that arrive from a form or an API call. */
export function assertIsoDate(value: string | null | undefined, label: string): void {
  if (value == null) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new TrackerError("invalid", `${label} must be a date in YYYY-MM-DD form.`);
  }
}
