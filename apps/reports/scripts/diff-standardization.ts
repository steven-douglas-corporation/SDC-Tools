// Before/after impact of the approved Section+Function rule book, month by month.
// Read-only — touches no database and writes nothing. Run with:
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/diff-standardization.ts
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// The rule book classifies any Section+Function combination it does not approve
// as `Undefined` rather than guessing a department for it. That is the correct,
// honest answer — but it MOVES hours out of departmental buckets that have already
// been reported and signed off, so nothing should be switched over until the size
// and shape of that movement is on the table. This script puts it there.
//
// It compares two classifications of the SAME raw hours:
//
//   BEFORE  hours-operational-grouping.ts's `departmentFor(section)`, applied to
//           the STANDARDIZED section — i.e. exactly what the app shows today,
//           after the 10-311 split, the 414->413 merge and the 12/13/14-211 fold.
//
//   AFTER   paylocity-standard-rules.ts's `classifyPunch(rawSection, rawFunction)`,
//           applied to the RAW pair.
//
// BEFORE's department dimension has 18 values and AFTER's has four, so the two are
// not directly comparable as-is. COARSEN below rolls BEFORE's 18 down onto the
// same four buckets. That roll-up is the one judgement call in this script and it
// is deliberately conservative: every phase-qualified engineering department
// ("Machine Testing — Engineering", "Warranty — Engineering", ...) rolls to
// Engineering and every shop one to Shop, so BEFORE is credited with the most
// favourable reading and the reported movement into Undefined is a floor, never
// inflated.
import { readFileSync } from "fs";
import * as XLSX from "xlsx";
import { mapPunchToColumns } from "../src/lib/sections";
import { departmentFor, UNDEFINED_LABEL as OPERATIONAL_UNDEFINED } from "../src/lib/hours-operational-grouping";
import {
  RECONCILIATION_BUCKETS,
  classifyPunch,
  emptyBucketTotals,
  normalizeSectionId,
  totalOf,
  type BucketTotals,
  type Department,
} from "../src/lib/paylocity-standard-rules";
import { normalizeFunctionId } from "../src/lib/paylocity-canonical";

const APP_SOURCE =
  process.env.JOB_HOURS_LOCAL_PATH?.trim() ||
  "C:/Users/akamuju/OneDrive - Steven Douglas Corp/SDC- Power BI Integration - Job Hours Report/Job Hours From Paylocity/Current_Job_Hours.xlsx";

const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const pad = (n: number, w = 11) => f2(n).padStart(w);
const signed = (n: number, w = 11) => (n >= 0 ? `+${f2(n)}` : f2(n)).padStart(w);

// BEFORE's 18 departments -> the rule book's four buckets. Explicit and total:
// an unlisted department throws rather than defaulting, so a new department added
// to DEPARTMENT_ORDER cannot silently land in the wrong bucket (or in Undefined)
// and quietly change what this comparison claims.
const COARSEN: Record<string, Department> = {
  Management: "PM",
  "Mechanical Engineering": "Engineering",
  "Controls Engineering": "Engineering",
  "General Engineering": "Engineering",
  Engineering: "Engineering",
  "Mechanical Build": "Shop",
  "Electrical Build": "Shop",
  Manufacturing: "Shop",
  "Machine Testing — Engineering": "Engineering",
  "Machine Testing — Shop": "Shop",
  "Teardown & Install — Engineering": "Engineering",
  "Teardown & Install — Shop": "Shop",
  "Warranty — Engineering": "Engineering",
  "Warranty — Shop": "Shop",
  "Service — Engineering": "Engineering",
  "Service — Shop": "Shop",
  "Spare Parts — Engineering": "Engineering",
  "Spare Parts — Shop": "Shop",
  [OPERATIONAL_UNDEFINED]: "Undefined",
};

function coarsen(department: string): Department {
  const bucket = COARSEN[department];
  if (!bucket) throw new Error(`diff-standardization: no coarse bucket for department "${department}" — add it to COARSEN`);
  return bucket;
}

type Punch = { month: string; section: string; fn: string; hours: number };

function readAppSource(file: string): Punch[] {
  const wb = XLSX.read(readFileSync(file), { cellDates: true });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { raw: true, defval: null });
  return rows.map((r) => {
    const d = r["Work Date"];
    return {
      month: d instanceof Date ? d.toISOString().slice(0, 7) : String(d ?? "").slice(0, 7),
      section: normalizeSectionId(r["MachineSec"] as string),
      fn: normalizeFunctionId(r["Function"] as string | number),
      hours: Number(r["Total Hours Worked"]) || 0,
    };
  });
}

/**
 * BEFORE: standardize the raw pair into an app column exactly as ingestion does,
 * then read today's department off that column. Uses the SAME mapPunchToColumns
 * the app uses (including the 10-311 split, hence the multi-column loop), so this
 * really is what the app shows rather than an approximation of it.
 */
function beforeBuckets(punches: readonly Punch[]): BucketTotals {
  const totals = emptyBucketTotals();
  for (const p of punches) {
    for (const col of mapPunchToColumns(`${p.section}-${p.fn}`, p.hours)) {
      totals[coarsen(departmentFor(col.section))] += col.hours;
    }
  }
  return totals;
}

function afterBuckets(punches: readonly Punch[]): BucketTotals {
  const totals = emptyBucketTotals();
  for (const p of punches) totals[classifyPunch(p.section, p.fn).department] += p.hours;
  return totals;
}

function printRow(label: string, before: BucketTotals, after: BucketTotals) {
  const cells = RECONCILIATION_BUCKETS.map((b) => signed(after[b] - before[b], 10)).join(" ");
  console.log(`  ${label.padEnd(9)} ${pad(totalOf(after))} | ${cells}`);
}

function main() {
  const punches = readAppSource(APP_SOURCE);
  const byMonth = new Map<string, Punch[]>();
  for (const p of punches) {
    const list = byMonth.get(p.month);
    if (list) list.push(p);
    else byMonth.set(p.month, [p]);
  }

  console.log("=".repeat(84));
  console.log("STANDARDIZATION BEFORE/AFTER — approved Section+Function rule book");
  console.log("=".repeat(84));
  console.log(`source: ${APP_SOURCE}`);
  console.log(`
BEFORE = today's app departments (hours-operational-grouping), coarsened to four buckets
AFTER  = the approved rule book applied to the RAW Section+Function pair
Cells below are the CHANGE (after - before). Raw hours are identical on both sides,
so the four changes always sum to zero — hours only move between buckets.
`);

  const header = RECONCILIATION_BUCKETS.map((b) => b.padStart(10)).join(" ");
  console.log(`  ${"month".padEnd(9)} ${"raw total".padStart(11)} | ${header}`);
  console.log(`  ${"-".repeat(9)} ${"-".repeat(11)}-+-${"-".repeat(header.length)}`);

  for (const month of [...byMonth.keys()].sort()) {
    const rows = byMonth.get(month)!;
    printRow(month, beforeBuckets(rows), afterBuckets(rows));
  }

  const before = beforeBuckets(punches);
  const after = afterBuckets(punches);
  console.log(`  ${"-".repeat(9)} ${"-".repeat(11)}-+-${"-".repeat(header.length)}`);
  printRow("ALL", before, after);

  console.log(`\n  absolute totals`);
  console.log(`  ${"bucket".padEnd(12)} ${"before".padStart(11)} ${"after".padStart(11)} ${"change".padStart(11)}`);
  for (const b of RECONCILIATION_BUCKETS) {
    console.log(`  ${b.padEnd(12)} ${pad(before[b])} ${pad(after[b])} ${signed(after[b] - before[b])}`);
  }
  console.log(`  ${"TOTAL".padEnd(12)} ${pad(totalOf(before))} ${pad(totalOf(after))} ${signed(totalOf(after) - totalOf(before))}`);

  // The invariant that makes this a re-bucketing rather than a restatement. Asserted,
  // not eyeballed: if standardization ever creates or destroys hours, this fails loudly.
  const drift = Math.abs(totalOf(after) - totalOf(before));
  console.log(
    `\n  raw hours conserved across the change : ${drift < 1e-6 ? "OK" : `FAILED (drift ${f2(drift)}h)`}`,
  );
  if (drift >= 1e-6) process.exitCode = 1;
  console.log("");
}

main();
