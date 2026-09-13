import { runDax } from "@/lib/powerbi-client";
import { ETC_TRACKED_CODES, HOURS_IMPORT_CODES, SECTIONS, mapPunchToColumns, poolCategoryForPunch } from "@/lib/sections";
import { normalizeJobNumber } from "@/lib/job-filters";
import { normalizeFunctionId } from "@/lib/paylocity-canonical";
import { normalizeSectionId } from "@/lib/paylocity-standard-rules";

// Power BI reader for actual hours worked — NOT the live source since 2026-08-05.
// The live source today is the OneDrive-synced Paylocity workbook, read via
// paylocity-workbook.ts and reached through hours-feed.ts's readHoursFeed(),
// which is the one entry point every hours consumer actually goes through.
//
// What's still live from THIS file on every hours read: buildColumnResolver()
// below, which reads only Power BI's `Function Hierarchy` table (metadata — what
// a punch code MEANS, not hours worked) and falls back to the hand-written
// SECTION_ALIASES if Power BI is unreachable, so an outage here never costs a
// single hour of data.
//
// fetchJobHoursRowsWithIssues()/fetchJobHoursRows()/hoursByJobSection() below —
// the actual hours-from-PBI path — are reached only via hours-feed.ts's
// readFromPowerBi(): explicit opt-in (HOURS_SOURCE=power_bi) or the historical-
// backfill scripts that legitimately need months older than the workbook covers.
// They are not on the default path.
//
// ── Why hours moved OFF Power BI onto the workbook (2026-08-05) ─────────────
// This file's reader briefly replaced an OneDrive-synced Paylocity workbook
// reader (sharepoint-hours.ts, deleted 2026-08-03) on the strength of a
// measurement that the two were the SAME DATA: for 2026-01..2026-07, 1,127 of
// 1,127 job x section x month cells agreed. Two days later the PBI model was
// found running days behind the workbook (July short 150.53h, August entirely
// absent) — so paylocity-workbook.ts + hours-feed.ts took over as the live
// source, and this file's row-level reader became the fallback described above.
//
// An earlier measurement appeared to show the export running ~9,600h AHEAD of the
// model. That was an artefact of comparing against Power BI's RAW function codes
// without the alias rules below — not staleness, not late punches. Worth knowing
// before anyone "fixes" a gap by that method again.
//
// ── Contract ────────────────────────────────────────────────────────────────
// Deliberately the same row shape the old SharePoint reader returned, because
// several callers still depend on it via readFromPowerBi() (sync-actuals,
// standard-pool-local's opt-in path) and none of them should care where hours
// come from.

// Company-wide hours worked per Standard Fees pool, keyed `${YYYY-MM}::${category}`.
//
// Collected on the same pass as the job rows but deliberately NOT routed through
// them. Three of the four pool sections (PM 111, and both Warranty phases) are
// outside HOURS_IMPORT_CODES, and widening that set would fold them into
// JobMonthlyActualHours — silently moving every job-level actual-hours figure on
// the dashboard, the Projects over/under colouring and the job detail. The pools
// are company-wide and need no per-job attribution, so they get their own tally
// instead of a change to what "actual hours for a job" means.
export type PoolHoursByMonth = Map<string, number>;

// `employeeId` is Paylocity's Employee Id, carried through so the punch-level
// Hours Detail drill can name who booked the time (resolved via
// Employee.paylocityId at read time). Empty string when the feed omits it — the
// hours still count, they just can't be attributed.
export type JobHoursRow = {
  jobId: string;
  /** The STANDARDIZED app column — post alias/split/merge. Unchanged semantics. */
  section: string;
  year: number;
  month: number;
  date: Date;
  hours: number;
  employeeId: string;
  // ── Raw punch identity (2026-08-21) ───────────────────────────────────────
  //
  // Carried alongside `section`, never instead of it. `section` is what every
  // existing consumer reads and its meaning has not changed; these two say which
  // raw Paylocity punch it came from, which standardization would otherwise
  // destroy (the 10-311 split, the 414->413 merge, the 12/13/14-211 fold).
  //
  // Needed because the approved rule book validates the RAW PAIR — Section 40 +
  // Function 311 is approved Engineering, Section 10 + Function 311 is Undefined —
  // and `section` cannot distinguish those once folded onto 40-211/10-31x.
  //
  // Normalized (see normalizeSectionId/normalizeFunctionId), so "010", 10 and
  // "010 - Complete Design & Build" all arrive as "10". Empty string, never
  // undefined, when the source cell was blank or non-numeric — that punch is real
  // and must still reconcile; it classifies as Undefined on exactly that basis.
  rawSection: string;
  rawFunction: string;
  // ── Travel location (2026-08-28) ──────────────────────────────────────────
  //
  // The Paylocity export's own "Travel" column, normalized the way the Job Hours
  // Report's Power Query does it: the literal "TRAVEL" becomes "Travel", and
  // "Not Defined"/blank becomes "Concord" (the home site). Feeds the Department
  // Utilization section's Travel / Travel % columns, which are a straight
  // reproduction of that report's `Hours Actual Travel` measure
  // (SUM of hours WHERE Travel = "Travel").
  //
  // OPTIONAL because this file's own Power BI reader cannot supply it — the PBI
  // model exposes the column on its fact table but the fallback DAX here does not
  // select it. Rows from that path arrive without travel rather than with a
  // fabricated "Concord", so a Travel figure computed over a PBI-sourced month is
  // absent instead of wrong. The live workbook path always sets it.
  travel?: string;
};

// Hours the feed holds against something that isn't a job number. An untracked
// section (PM, Manufacturing, Warranty) is absent from the ETC grid whether or
// not its job is valid, so counting it here would overstate what a valid job
// number would actually have recovered.
export type HoursImportIssue = {
  month: string; // "2026-07"
  label: string; // the raw value, e.g. "NOT DEFINED"
  rows: number;
  hours: number;
};

// One rejected PUNCH, not a total. The aggregate above says 171 hours are
// unattributed; only this says whose they are, and "somebody booked to NOT
// DEFINED" is not actionable in Paylocity without a name and a date.
export type UnattributedRow = {
  month: string;
  label: string;
  date: Date;
  employeeId: string;
  section: string;
  hours: number;
};

// Latest work date across the feed — the "Hours Refreshed Thru" freshness figure.
export function latestWorkDate(rows: JobHoursRow[]): Date | null {
  let max: Date | null = null;
  for (const r of rows) if (!max || r.date > max) max = r.date;
  return max;
}

// Power BI zero-pads Job Id ("0814"); the app stores it unpadded ("814").
// Joining raw makes every older job look like it has no hours at all. The
// rule itself now lives in job-filters.ts (normalizeJobNumber) -- this name
// is kept as the export every existing caller here already uses.
export function normalizePbiJobId(raw: string): string {
  return normalizeJobNumber(raw);
}

type PbiRow = {
  "Job[Job Id]": string | null;
  "Function Hierarchy[Section-Function Code]": string | null;
  "Date[Date]": string | null;
  "Hours Actual[Employee Id]": string | null;
  // Extension columns come back WITHOUT brackets, unlike the table columns
  // above. Getting that wrong is silent: every row still arrives, the hours just
  // read zero, and the model looks empty.
  Hours: number | null;
};

// ── Code -> app column, read from the model instead of guessed ──────────────
//
// The model's `Function Hierarchy` table maps every one of its 413 punch codes to
// a (Section Name, Section Function Name) pair — precisely the app's (phase,
// column) pair. So the mapping can be READ rather than reverse-engineered, which
// is how it is done here.
//
// This replaced nine hand-written aliases in sections.ts (SECTION_ALIASES), which
// were derived by probing Power BI's measures code by code against one month's
// export. That method got the codes it was tested against right and silently
// missed the rest — most importantly the whole `11-211`..`20-211` band, which the
// model files under "Complete Design and Build / ME / ME General", i.e. the app's
// 10-211 column. Job 1101 was the report that surfaced it: the app showed 149h of
// ME Gen where the Power BI report showed 634h, and the missing 485h was exactly
// 11/12/13/14/15/16/17-211.
//
// Anchored on the app's OWN 17 codes: each is looked up in the hierarchy to learn
// its (Section Name, Section Function Name), and any other code sharing that pair
// maps onto it. Nothing is hardcoded, so a code added upstream lands in the right
// column without a change here.
//
// Codes the model marks `Is Valid = false` (its "Invalid" bucket — 5-111, 10-400,
// and others) are NOT mapped: the report shows them in its own Invalid column, and
// inventing a home for them here would disagree with it.
//
// Two things the hierarchy does NOT resolve, deliberately left alone:
//   • 10-311 — the model calls it Invalid, but the app splits it 30/70 into
//     10-312/10-313 as a documented house rule (see mapPunchToColumns). Changing
//     that would move design/software hours the team has signed off, so it stays
//     and is flagged instead.
//   • Sections the app has no phase for at all — "Service" (80-*) and 90-* — which
//     stay unmapped and are reported by the caller.
type ColumnResolver = (rawSection: string) => string | null;

type HierarchyRow = {
  code: string | null;
  sectionName: string | null;
  sfName: string | null;
  isValid: boolean | null;
  isTotal: boolean | null;
};

export async function buildColumnResolver(): Promise<{ resolve: ColumnResolver; mapped: number }> {
  const rows = (await runDax(`
EVALUATE
FILTER(
  SELECTCOLUMNS('Function Hierarchy',
    "code", 'Function Hierarchy'[Section-Function Code],
    "sectionName", 'Function Hierarchy'[Section Name],
    "sfName", 'Function Hierarchy'[Section Function Name],
    "isValid", 'Function Hierarchy'[Is Valid],
    "isTotal", 'Function Hierarchy'[Is Total]),
  [isTotal] = FALSE())`)) as HierarchyRow[];

  // code -> "Section Name::Section Function Name", valid rows only.
  const pairByCode = new Map<string, string>();
  for (const r of rows) {
    const code = (r.code ?? "").trim();
    if (!code || r.isValid === false) continue;
    const pair = `${(r.sectionName ?? "").trim()}::${(r.sfName ?? "").trim()}`;
    pairByCode.set(code, pair);
  }

  // The app's own codes are the anchors: whatever pair each one carries in the
  // hierarchy is the pair that means "this column".
  const appCodeByPair = new Map<string, string>();
  for (const s of SECTIONS) {
    const pair = pairByCode.get(s.code);
    if (pair) appCodeByPair.set(pair, s.code);
  }

  let mapped = 0;
  const resolved = new Map<string, string>();
  for (const [code, pair] of pairByCode) {
    const appCode = appCodeByPair.get(pair);
    if (!appCode || appCode === code) continue;
    resolved.set(code, appCode);
    mapped++;
  }

  return {
    resolve: (rawSection: string) => resolved.get(rawSection) ?? null,
    mapped,
  };
}

// `Data Source = "Paylocity Hours"` is load-bearing, not defensive. The table
// also holds `Historical Import 20250131` — 282,445h of pre-2025 work collapsed
// onto the single date 2025-01-31 — which the app already holds as
// EstimatedHours.actualHistoricalHours (282,448h; they agree to 3 hours). Letting
// it through would double-count all of it. The two sources don't overlap by date
// either: Paylocity Hours runs 2025-02-01 onward.
const PAYLOCITY_SOURCE = "Paylocity Hours";

// One month at a time. The whole feed in a single query is ~30k rows at this
// grain and would sit near executeQueries' response limits; per month it is a few
// thousand, and a failure costs one month rather than the pass.
async function fetchMonthRows(year: number, month: number): Promise<PbiRow[]> {
  const nextY = month === 12 ? year + 1 : year;
  const nextM = month === 12 ? 1 : month + 1;
  const dax = `
EVALUATE
FILTER(
  SUMMARIZECOLUMNS(
    'Job'[Job Id],
    'Function Hierarchy'[Section-Function Code],
    'Date'[Date],
    'Hours Actual'[Employee Id],
    FILTER(ALL('Date'[Date]), 'Date'[Date] >= DATE(${year},${month},1) && 'Date'[Date] < DATE(${nextY},${nextM},1)),
    FILTER(ALL('Hours Actual'[Data Source]), 'Hours Actual'[Data Source] = "${PAYLOCITY_SOURCE}"),
    "Hours", SUM('Hours Actual'[Hours Actual])
  ),
  [Hours] <> 0
)`;
  return (await runDax(dax)) as PbiRow[];
}

// The feed's own bounds, so the window widens on its own as months are added
// rather than needing a constant bumped every January.
async function feedBounds(): Promise<{ first: { y: number; m: number }; last: { y: number; m: number } } | null> {
  const rows = (await runDax(`
EVALUATE
CALCULATETABLE(
  ROW("minDate", MIN('Hours Actual'[Date]), "maxDate", MAX('Hours Actual'[Date])),
  FILTER(ALL('Hours Actual'[Data Source]), 'Hours Actual'[Data Source] = "${PAYLOCITY_SOURCE}")
)`)) as { minDate: string | null; maxDate: string | null }[];
  const min = rows[0]?.minDate;
  const max = rows[0]?.maxDate;
  if (!min || !max) return null;
  return {
    first: { y: Number(min.slice(0, 4)), m: Number(min.slice(5, 7)) },
    last: { y: Number(max.slice(0, 4)), m: Number(max.slice(5, 7)) },
  };
}

// "2026-07" -> {y, m}, or null when not asked for. Invalid input is treated as
// "not asked for" rather than throwing: the worst case is a slower full read,
// never a month silently skipped.
function onlyMonthBounds(month?: string): { y: number; m: number } | null {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null;
  return { y: Number(month.slice(0, 4)), m: Number(month.slice(5, 7)) };
}

// Every punch the feed holds, resolved to the app's own grain.
//
// Returns ALL months, not a rolling window — which is the point of the switch.
// The SharePoint file only reached back to 2026-01, so the app had no
// month-level history for 2025-02..2025-12 at all and the Projects grid was
// short ~49,000h on the sections it models. Reading the model covers every job
// the hours were booked to, Complete and Active alike: nothing here filters on
// job status.
export async function fetchJobHoursRowsWithIssues(opts?: { onlyMonth?: string }): Promise<{
  rows: JobHoursRow[];
  issues: HoursImportIssue[];
  unattributed: UnattributedRow[];
  poolHours: PoolHoursByMonth;
}> {
  const bounds = await feedBounds();
  if (!bounds) {
    console.warn("[job-hours] Power BI returned no Paylocity rows at all — treating as an empty import rather than zeroing anything.");
    return { rows: [], issues: [], unattributed: [], poolHours: new Map() };
  }

  // Read the model's own code->column mapping once for the whole pass. Falls back
  // to the hand-written aliases if the hierarchy query fails, so a Power BI hiccup
  // degrades to the previous behaviour rather than losing every aliased hour.
  let resolve: ColumnResolver = () => null;
  try {
    const built = await buildColumnResolver();
    resolve = built.resolve;
    console.log(`[job-hours] code->column map read from Function Hierarchy: ${built.mapped} codes fold onto an app column.`);
  } catch (err) {
    console.warn("[job-hours] could not read Function Hierarchy; falling back to SECTION_ALIASES:", err);
  }

  const out: JobHoursRow[] = [];
  const unattributed = new Map<string, HoursImportIssue>(); // `${month}::${label}`
  const unattributedRows: UnattributedRow[] = [];
  const poolHours: PoolHoursByMonth = new Map();

  // `onlyMonth` narrows the read to a single month (2026-08-03).
  //
  // The full span is 18 months and costs one DAX round-trip each — ~6.6s, plus
  // the writes that follow it. That is right for the scheduled pass, which owns
  // the whole history. It is badly wrong for the ETC page's "Refresh Data"
  // button, which only ever touches ONE month: that click went from ~900ms
  // (reading a local workbook) to ~15s when hours moved to Power BI, because it
  // was re-pulling and re-writing every month to change one.
  const first = onlyMonthBounds(opts?.onlyMonth) ?? bounds.first;
  const last = onlyMonthBounds(opts?.onlyMonth) ?? bounds.last;

  let { y, m } = { y: first.y, m: first.m };
  while (y < last.y || (y === last.y && m <= last.m)) {
    const rows = await fetchMonthRows(y, m);
    const monthStr = `${y}-${String(m).padStart(2, "0")}`;

    for (const r of rows) {
      const hours = Number(r.Hours ?? 0);
      if (!hours) continue;
      const rawSection = (r["Function Hierarchy[Section-Function Code]"] ?? "").trim();
      const dateRaw = (r["Date[Date]"] ?? "").slice(0, 10);
      if (!rawSection || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) continue;
      const date = new Date(`${dateRaw}T00:00:00.000Z`);
      const employeeId = (r["Hours Actual[Employee Id]"] ?? "").trim();
      const [machineSec, fn] = rawSection.split("-");

      // Must be a real job number. Anything else is counted and skipped — never
      // coerced into a fake id.
      const rawJob = (r["Job[Job Id]"] ?? "").trim();
      const jobNum = Number(rawJob);
      if (rawJob === "" || !Number.isFinite(jobNum)) {
        // Only report what a valid job number would actually have recovered:
        // 10-311 is not itself tracked but splits into two codes that are.
        const wouldHaveCounted = rawSection === "10-311" || ETC_TRACKED_CODES.has(SECTION_OR_SELF(rawSection));
        if (wouldHaveCounted) {
          const label = rawJob === "" ? "(blank)" : rawJob;
          const key = `${monthStr}::${label}`;
          const seen = unattributed.get(key) ?? { month: monthStr, label, rows: 0, hours: 0 };
          unattributed.set(key, { ...seen, rows: seen.rows + 1, hours: seen.hours + hours });
          unattributedRows.push({ month: monthStr, label, date, employeeId, section: rawSection, hours });
        }
        continue;
      }
      const jobId = normalizePbiJobId(rawJob);

      // Pool tally, from the RAW phase/function rather than the mapped section:
      // the aliases fold warranty away, and two of the four pools are warranty.
      // Counted after the real-job-number check, so the pools use the same notion
      // of a genuine punch as every other figure.
      const poolCategory = poolCategoryForPunch(machineSec, fn);
      if (poolCategory) {
        const poolKey = `${monthStr}::${poolCategory}`;
        poolHours.set(poolKey, (poolHours.get(poolKey) ?? 0) + hours);
      }

      // Raw Paylocity code -> the app's column(s). Aliases, plus the 10-311
      // 30/70 design/software split. See mapPunchToColumns in sections.ts — as of
      // 2026-08-21 it never drops a row for being unmapped; a code outside
      // HOURS_IMPORT_CODES comes back as itself and flows into `out` like
      // everything else.
      const columns = mapPunchToColumns(rawSection, hours, resolve);
      // The raw pair is taken from `machineSec`/`fn` — the untransformed cells —
      // not re-derived from `rawSection` or from `c.section`, so a future change to
      // the column mapping cannot quietly alter what we record as raw. Every
      // column a punch splits into carries the SAME raw pair, which is what lets
      // the split halves sum back to the punch when grouped by it.
      const rawSectionId = normalizeSectionId(machineSec);
      const rawFunctionId = normalizeFunctionId(fn);
      for (const c of columns) {
        out.push({
          jobId,
          section: c.section,
          year: y,
          month: m,
          date,
          hours: c.hours,
          employeeId,
          rawSection: rawSectionId,
          rawFunction: rawFunctionId,
        });
      }
    }

    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  const issues = [...unattributed.values()].sort((a, b) => b.hours - a.hours);
  if (issues.length > 0) {
    const total = issues.reduce((s, i) => s + i.hours, 0);
    console.warn(
      `[job-hours] ${out.length} rows imported; ${total.toFixed(2)}h booked to non-job values and NOT counted anywhere ` +
        `(${issues.length} month/label combinations). Worth chasing upstream in Paylocity.`,
    );
  }

  return { rows: out, issues, unattributed: unattributedRows, poolHours };
}

// The alias applied before the tracked-code test, for the unattributed report
// only — so "would this have counted?" asks about the column the punch would
// have landed in, not the raw code.
function SECTION_OR_SELF(rawSection: string): string {
  const mapped = mapPunchToColumns(rawSection, 1);
  return mapped[0]?.section ?? rawSection;
}

// Rows only — the common case, and what the reconciliation scripts want.
export async function fetchJobHoursRows(): Promise<JobHoursRow[]> {
  return (await fetchJobHoursRowsWithIssues()).rows;
}

// Hours worked in a given calendar month, keyed "jobId::section".
export function hoursByJobSection(rows: JobHoursRow[], year: number, month: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.year !== year || r.month !== month) continue;
    const key = `${r.jobId}::${r.section}`;
    map.set(key, (map.get(key) ?? 0) + r.hours);
  }
  return map;
}

// Re-exported so callers that only want the tracked-code test don't reach past
// this module into sections.ts for it.
export { HOURS_IMPORT_CODES };
