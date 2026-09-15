import "server-only";
import { readFile } from "fs/promises";
import { parseHiringWorkbook, HiringWorkbookError } from "@/lib/hiring-workbook-parse";
import type { HiringPositionSourceRow } from "@/lib/hiring-workbook-parse";

export type { HiringPositionSourceRow };
export { HiringWorkbookError, isOpenPosition, parseHiringWorkbook, SHEET_NAME, REQUIRED_HEADERS } from "@/lib/hiring-workbook-parse";

// ── The open-positions workbook, read straight off disk (2026-08-19) ────────
//
// A Paylocity Recruiting "Job" report — confirmed by reading the live file
// directly. Same local-file convention as lib/paylocity-workbook.ts: an env var
// (HIRING_POSITIONS_LOCAL_PATH) pointing at the real path. It used to fall back
// to the path this was built against under one person's OneDrive profile; since
// 2026-09-14 an unset variable is a configuration error instead, because a
// silent fallback to a stale copy is worse than a missing hiring panel (which
// hiring-positions.ts already degrades to on any HiringWorkbookError).
//
// Parsing itself lives in hiring-workbook-parse.ts (no `fs`, no
// "server-only", directly unit-testable) — this file is only the disk read.

export function hiringWorkbookPath(): string {
  const configured = process.env.HIRING_POSITIONS_LOCAL_PATH?.trim();
  if (configured) return configured;
  throw new HiringWorkbookError(
    "file_missing",
    "The hiring positions workbook is not configured: set HIRING_POSITIONS_LOCAL_PATH in .env. There is no default path.",
  );
}

// /*turbopackIgnore*/ below: this path is a runtime value pointing OUTSIDE
// the project (an env var, or the absolute OneDrive path it falls back to).
// Next's build-time tracer (@vercel/nft) statically scans `fs` calls to decide
// what a route must bundle; when it can't resolve an argument to a literal
// path it over-includes to be safe, which is exactly the "next.config.ts was
// traced unintentionally / whole project was traced" build warning this
// produced on every route reaching this module. Same reasoning and same fix as
// job-cost-inventory-sync.ts (2026-08-11) -- see its own longer note. The
// comment only affects TRACING; the read itself is unchanged.
export async function readHiringWorkbook(): Promise<HiringPositionSourceRow[]> {
  const path = hiringWorkbookPath();
  let buf: Buffer;
  try {
    buf = await readFile(/* turbopackIgnore: true */ path);
  } catch (err) {
    throw new HiringWorkbookError(
      "file_missing",
      `Couldn't read the hiring positions workbook at "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseHiringWorkbook(buf);
}
