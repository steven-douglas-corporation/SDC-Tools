import type { PunchBucket } from "@/lib/department-utilization";
import type { EmployeeMonthPunch } from "@/lib/employee-punch-drill";
import type { SortColumns } from "@/lib/table-sort";

// ── Sorting the employee punch drill-through (2026-08-31) ───────────────────
//
// The column definitions only. The state, the click cycle, the chevron and the
// aria wiring all come from the app's shared sort (lib/table-sort.ts +
// ui/SortableHeader.tsx) — the same one the job drill and the department table
// use — so this file is just "what does each column compare by", which is the
// half that is worth testing and the half that is easy to get wrong.
//
// Its own module rather than living in EmployeePunchDrill.tsx so it can be
// tested without pulling React and a server action into the test process.
//
// ── The default order is NOT here, deliberately ─────────────────────────────
//
// The table's default is the server's own `orderBy: [{ workDate: "desc" },
// { section: "asc" }]` — newest punch first. sortRows() returns the input array
// untouched when the sort state is null, so the third click on a header (the
// "none" step of cycleSortState) restores that order for free. Re-implementing
// it here as a default comparator would be a second definition of the default
// that could drift from the query.

export type PunchSortKey = "date" | "jobId" | "project" | "section" | "bucket" | "hours";

/**
 * The logical order for "Counts as": Billable → Warranty → Service → Spare
 * Parts → Bellco → Non-Billable.
 *
 * That is the business order the utilization measures already use — billable
 * work first, the two things that pull utilization down last — and it is why
 * this column sorts by RANK rather than by its label text. Alphabetically
 * "Bellco" would lead and "Warranty" would trail, which tells a reader nothing
 * about the thing the column is for.
 *
 * ── Why this is a literal and not derived from BUCKET_LABEL ─────────────────
 *
 * BUCKET_LABEL lives in employee-punch-drill.ts, which is `server-only`. Reading
 * it here would be a VALUE import, and this module is reached from a client
 * component — which drags Prisma into the browser bundle and 500s the whole
 * page. (Measured: it did exactly that.) `import type` is erased at build time
 * and is safe; a value import is not.
 *
 * Typed as Record<PunchBucket, number>, so the compiler still requires an entry
 * for every bucket — a new one is a build error here rather than a silent
 * fall-to-the-end. employee-punch-sort.test.ts additionally asserts this stays in
 * step with BUCKET_LABEL's own order.
 */
const BUCKET_ORDER: Record<PunchBucket, number> = {
  billableActive: 0,
  warranty: 1,
  service: 2,
  spareParts: 3,
  bellco: 4,
  nonBillable: 5,
};

/** The same order as a lookup, exported for the test that cross-checks it against BUCKET_LABEL. */
export const BUCKET_RANK: ReadonlyMap<string, number> = new Map(Object.entries(BUCKET_ORDER));

/**
 * A section code rewritten so a plain string compare orders it naturally: every
 * digit run zero-padded, so "9-211" < "10-211" < "40-311".
 *
 * A raw compare is right only while every position has the same digit count, and
 * this app's section list does not — sections.ts carries 1-digit sections
 * ("1-311") beside the usual 2-digit ones. Measured, the two cases it gets wrong:
 *
 *   "9-211"  vs "10-211"  -> raw puts 10-211 first ("9" > "1"), numerically wrong
 *   "10-99"  vs "10-100"  -> raw puts 10-100 first ("9" > "0"), numerically wrong
 *
 * (It happens to get "1-311" vs "10-211" right, because the digits tie and "-"
 * sorts below "0" — luck that does not generalise, which is the point.)
 *
 * Padding also makes the result independent of how the collator treats the "-":
 * localeCompare may weight punctuation as ignorable, which would compare "1311"
 * against "10211" and give a different answer again.
 */
export function sectionSortKey(code: string): string {
  return code
    .split(/(\d+)/)
    .map((part) => (/^\d+$/.test(part) ? part.padStart(6, "0") : part))
    .join("");
}

/** Column key -> how that column compares. Fed straight to sortRows(). */
export const PUNCH_SORT_COLUMNS: SortColumns<EmployeeMonthPunch, PunchSortKey> = {
  // The ISO value, never the "Fri, Aug 28" label the cell renders: lexicographic
  // order on YYYY-MM-DD IS chronological order, while sorting the formatted text
  // would put April before August and Friday before Monday.
  date: { type: "date", value: (r) => r.date },
  // "id" compares numerically when both sides parse and falls back to a string
  // compare when they do not — so 979 sorts before 1129 rather than after it,
  // and a non-numeric job id still lands somewhere stable instead of as NaN.
  jobId: { type: "id", value: (r) => r.jobId },
  // Lower-cased for a genuinely case-insensitive compare, rather than relying on
  // localeCompare's collation happening to treat case as a tertiary difference.
  project: { type: "text", value: (r) => r.jobName.toLowerCase() },
  section: { type: "text", value: (r) => sectionSortKey(r.section) },
  bucket: { type: "number", value: (r) => BUCKET_ORDER[r.bucket] ?? Number.MAX_SAFE_INTEGER },
  hours: { type: "hours", value: (r) => r.hours },
};
