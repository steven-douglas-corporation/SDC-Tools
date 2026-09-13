import "server-only";
import { prisma } from "@/lib/prisma";

// ── Job Cost Explorer: reading the inventory snapshot table (2026-08-11) ────
//
// Split out of job-cost-inventory-sync.ts on purpose (2026-08-11) — that file
// also does the fs.readdir/ExcelJS.readFile work that actually ingests Lisa's
// workbook, on a runtime-computed path OUTSIDE the project entirely
// (`C:\Users\...\Finance - General`). job-cost-source.ts needs to import
// these two READ functions at the top of the module (it calls them on every
// page render), and a plain `import { x } from "./y"` pulls in the WHOLE file
// `y` for bundling/tracing purposes — including code paths that page render
// never touches. With the fs-touching sync function still living in the same
// file as these, Next's file-trace couldn't statically resolve that dynamic,
// outside-the-project path and fell back to tracing the entire project root
// into every page that (transitively) imported it — reported directly as 7
// build warnings ("Encountered unexpected file in NFT list") spanning pages
// that have nothing to do with this feature (etc, hours, employees, even the
// root dashboard). This file contains ONLY plain Prisma reads — nothing here
// ever touches the filesystem — so it is safe for job-cost-source.ts to
// import statically without dragging fs/ExcelJS into the trace at all.
//
// The sync function itself (syncJobCostInventorySnapshots, still in
// job-cost-inventory-sync.ts) is untouched and still reached the same way it
// always was: a LAZY `await import(...)` inside auto-sync.ts's runAllSyncs,
// which was never part of any page's static import graph in the first place.

export type InventorySnapshotJob = { salesPrice: number | null; percentComplete: number | null };

export async function listInventorySnapshotDates(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ asOfDate: Date }[]>`
    SELECT DISTINCT asOfDate FROM JobCostInventorySnapshot ORDER BY asOfDate DESC`;
  return rows.map((r) => r.asOfDate.toISOString().slice(0, 10));
}

// The latest snapshot on or before `target` (Current = null = the true latest
// ever, no ceiling) — never a snapshot AFTER target, which is the one rule this
// whole feature exists to enforce. `asOfDate: null` in the return means no
// snapshot at all qualifies (nothing on or before target exists yet) — the
// caller's missing-data case, not a silent fall-through to a later month.
export async function getInventorySnapshotForDate(
  target: string | null,
): Promise<{ map: Map<string, InventorySnapshotJob>; asOfDate: string | null }> {
  const ceiling = target ?? "9999-12-31";
  const latest = await prisma.$queryRaw<{ asOfDate: Date }[]>`
    SELECT MAX(asOfDate) AS asOfDate FROM JobCostInventorySnapshot WHERE asOfDate <= ${ceiling}`;
  const asOfDate = latest[0]?.asOfDate ? latest[0].asOfDate.toISOString().slice(0, 10) : null;
  const map = new Map<string, InventorySnapshotJob>();
  if (!asOfDate) return { map, asOfDate: null };

  const rows = await prisma.$queryRaw<{ jobId: string; salesPrice: unknown; percentComplete: unknown }[]>`
    SELECT jobId, salesPrice, percentComplete FROM JobCostInventorySnapshot WHERE asOfDate = ${asOfDate}`;
  for (const r of rows) {
    map.set(r.jobId, {
      salesPrice: r.salesPrice == null ? null : Number(r.salesPrice),
      percentComplete: r.percentComplete == null ? null : Number(r.percentComplete),
    });
  }
  return { map, asOfDate };
}
