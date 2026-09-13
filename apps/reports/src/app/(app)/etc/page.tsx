import { Fragment } from "react";
import { prisma } from "@/lib/prisma";
import { compareJobIds, isSdcCustomer, validJobTypeFilter } from "@/lib/job-filters";
import { compareSections } from "@/lib/off-grid-hours";
import { EtcViewMenu } from "@/components/EtcViewMenu";
import { EtcGridView } from "@/components/EtcGridView";
import { ETC_DEPT_GROUPS } from "@/lib/etc-view";
import { bandColSpan } from "@/lib/grid-view";
import { ExportMenu } from "@/components/ExportMenu";
import { getEtcMonthJobWhere } from "@/lib/etc-month-jobs";
import { getEtcMonthKpis } from "@/lib/etc-month-kpis";
import { getUndefinedHoursTotals } from "@/lib/unattributed-hours";
import { EtcMonthKpiCards } from "@/components/EtcMonthKpiCards";
import { auth } from "@/lib/auth";
import { requirePagePermission } from "@/lib/require-permission";
import { hasPermission } from "@/lib/permissions";
import { DepartmentEtcChecklist } from "@/components/DepartmentEtcChecklist";
import { readDepartmentCompletions } from "@/lib/etc-department-status";
import { manageableDepartments, parseDepartmentOwners, DEPARTMENT_OWNERS_ENV } from "@/lib/etc-departments";
import { EtcIssuesIndicator } from "@/components/EtcIssuesIndicator";
// From lib/, not from the component beside it: this page renders on the SERVER, and a
// function exported from a "use client" module cannot be called there.
import { buildEtcIssues } from "@/lib/etc-issues";
import { PartsCostNewEtcCell } from "@/components/PartsCostNewEtcCell";
import { PartsBreakoutCell } from "@/components/PartsBreakoutCell";
import { readPartsEtcBreakout } from "@/lib/parts-etc-breakout";
import { monthEndLabel } from "@/lib/left-to-invoice";
import { showsPartsBreakout } from "@/lib/parts-breakout-scope";
import { resolveLeftToInvoice, partsNewEtc } from "@/lib/left-to-invoice";
import { EtcSectionCells } from "@/components/EtcSectionCells";
import {
  StandardRatesProvider,
  EtcStandardCells,
  StandardGrandCells,
  StandardHeaderVisible,
  NoJobsMessageRow,
} from "@/components/EtcStandardColumns";
import type { StandardJobBase, StandardRates, FrozenStandardRow, PoolRowInput } from "@/components/EtcStandardColumns";
import { EtcRatesButton } from "@/components/EtcRatesButton";
import { StandardsVisibilityToggle } from "@/components/StandardsGate";
import { StandardFeesCard } from "@/components/StandardFeesCard";
import { SuppressToasts } from "@/components/ui/Toast";
import { POOL_PANEL_META } from "@/lib/pool-panel-meta";
import type { PoolPanelRow, NewProjectRow } from "@/components/StandardPoolPanel";
import { newProjectsEnteringMonth } from "@/lib/standard-pool-local";
import { savePools } from "@/lib/standard-sheet-actions";
// ONE submission and ONE reopen for the whole month — see lib/monthly-report.ts.
import { reopenMonthlyReport, checkMonthlyReport } from "@/lib/monthly-report-actions";
import { ETC_SECTIONS, PARTS_COST_SECTION } from "@/lib/sections";
import { calcHoursLeft, suggestNewEtc, isMonthLocked, isValidMonth, nextMonth, currentMonth, round2, workingDaysInMonth, effectiveNewEtc, newEtcDiff, newEtcSeedText, isNewEtcCellDecided, rollupNewEtc, type NewEtcCellState, type NewEtcRollupCell } from "@/lib/etc";
import { ReopenMonthButton } from "@/components/ReopenMonthButton";
import { EtcAutosave } from "@/components/EtcAutosave";
import { EtcLiveTotals } from "@/components/EtcLiveTotals";
import { isStandardSheetUnlocked, lockStandardSheet } from "@/lib/standard-sheet-gate";
import { getExecutionEtcByJob, isInStandardFeesAllocation } from "@/lib/execution-etc";
import { PageTitle } from "@/components/ui/Typography";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { hours as formatHours, usd as currency, usdExact as currencyExact } from "@/components/ui/format";
import { MonthYearSelect } from "@/components/MonthYearSelect";
import { JobCellMenuHost } from "@/components/JobCellMenuHost";
import { jobCellMenuProps } from "@/lib/job-cell-menu";
import { getSchedulerLinkContext, schedulerScheduleUrl } from "@/lib/scheduler-link";
import { BUTTON_SECONDARY, ETC_COL_W, GRID_SCROLLER, PAGE_SHELL, PARTS_COL_W, TABLE_GRID, TABLE_HEADER_ROW, TOOLBAR_MIN_W } from "@/components/ui/classnames";
import { diffCellStyle, diffTotalStyle, DIFF_CEILING } from "@/components/ui/etc-diff-colors";
import { abbreviateLabel } from "@/lib/abbrev";
import { DragScroll } from "@/components/DragScroll";

// Matches the real "Managers Fill Out" sheet's column shape exactly — every
// department block has these same 5 columns; Parts Cost and the Total rollup
// use the sheet's own label variants.
const SUB_COLUMNS = ["Prior ETC", "Hours Worked Month", "Hours Left", "New ETC", "Diff"] as const;
// ── "Left to Invoice" / "Left to Purchase" added 2026-09-03, by request ──────
//
// They break New ETC into the two things it is made of, and they sit immediately
// before it so the row reads left-to-right as the sum it IS:
//
//     Left to Invoice  +  Left to Purchase  =  New ETC
//
// Both are manager-editable and New ETC is CALCULATED from them — it is not an input at
// all on a month that has these columns. There is one authoritative value: the halves
// are stored per EtcEntry and the save derives New ETC from them, so nothing can hold a
// manual figure that disagrees with the sum beside it.
//
// The two halves are not symmetrical, though (2026-09-04):
//
//   Left to Invoice   defaults to the Parts List figure at this month's cutoff, so the
//                     two surfaces reconcile unless somebody says otherwise. An
//                     override is stored and the cell is HIGHLIGHTED.
//   Left to Purchase  starts empty. Nothing upstream can compute it — a BOM part with
//                     no purchase line does not appear in the parts rows at all.
//
// And New ETC stays BLANK until both have a value. A blank half is not $0: treating it
// as one displayed a forecast nobody had made the moment one cell was filled in.
//
// So Total ETO is consulted for one thing — Left to Invoice's default — which makes it
// the only upstream call this page makes: a single batched query, see
// lib/parts-etc-breakout.ts.
// Not every month has all seven — see lib/parts-breakout-scope.ts. The two breakout
// columns start at August 2026, so the grid derives its own list from this one and
// EVERY consumer must use that derived list: the header colSpans, the body cells, the
// totals row and the footer's colSpan all have to agree, and a header one cell wider
// than its body is the failure this list-of-one prevents.
const PARTS_COST_SUB_COLUMNS = [
  "Prior ETC",
  "Money Spent Month",
  "Money Left",
  "Left to Invoice",
  "Left to Purchase",
  "New ETC",
  "Diff",
] as const;
const TOTAL_SUB_COLUMNS = ["Prior ETC", "Hours Worked", "Hours Left", "Total New ETC", "Diff"] as const;

// Why a Total (New ETC) cell is blank (§51). A blank with no explanation reads as
// missing data or a broken formula; naming the sections still waiting turns it into a
// list of things to go and do. Says "0 counts" outright, because the one thing a
// manager will try when a rollup refuses to appear is typing a zero, and it works.
function rollupPendingTitle(pending: string[]): string {
  if (pending.length === 0) return "";
  const list = pending.length <= 4 ? pending.join(", ") : `${pending.slice(0, 4).join(", ")} and ${pending.length - 4} more`;
  return (
    `Waiting on ${pending.length} ${pending.length === 1 ? "section" : "sections"}: ${list}. ` +
    `Total New ETC and Diff appear once every section here has a New ETC — 0 counts as an answer.`
  );
}


// The sheet's 5-level header above the column labels: Phase -> billing group
// (Engineering/Shop) -> sub-group (ME / CE / General Engineering / dept
// abbreviations) -> colored section cell. Rather than hardcode column counts
// (which break the moment the Engineering/Shop filter hides some), the header
// rows are derived at render time from the visible column list by run-length
// grouping consecutive columns that share a label. Display-only — internal
// section names/phases in sections.ts are unchanged.
const PHASE_DISPLAY: Record<string, string> = {
  "Complete Design & Build": "Complete Design and Build",
  "Machine Testing": "Testing",
  "Teardown & Install": "Teardown and Install",
};
const SUBGROUP_DISPLAY: Record<string, string> = {
  "10-211": "ME",
  "10-312": "CE",
  "10-313": "CE",
  "10-515": "General Engineering",
  "10-516": "General Engineering",
  "10-517": "General Engineering",
  "10-518": "General Engineering",
  "10-411": "Shop",
  "10-412": "Shop",
  // "& GE" removed (2026-08-20): General Engineering's codes (515-518) never
  // merge into this column — only 211/311/312/313 do, via sections.ts's
  // SECTION_ALIASES ("40-311/312/313" -> "40-211" etc.). The label was
  // claiming a fourth discipline that was never actually part of this bucket.
  "40-211": "ME & CE",
  "40-411": "MB & EB",
  "50-211": "ME & CE",
  "50-411": "MB & EB",
};

type EtcCol = {
  code: string;
  name: string;
  billingGroup: "Engineering" | "Shop";
  phaseLabel: string;
  groupLabel: string;
  subgroupLabel: string;
  sectionDisplay: string;
};

// Consecutive columns sharing keyOf(col) collapse into one header cell whose
// colSpan is count × 5 (the sub-columns per section). Used for the phase,
// billing-group, and sub-group header rows.
// `codes` carries the section codes each run spans, which is what lets a banded
// header cell fix its own colSpan when a column is hidden client-side. A colSpan is a
// number in the DOM and no stylesheet can change it, so the band has to declare what
// it covers and GridViewProvider recomputes it — see bandColSpan in lib/grid-view.ts.
function headerRuns(cols: EtcCol[], keyOf: (c: EtcCol) => string, labelOf: (c: EtcCol) => string) {
  const runs: { key: string; label: string; count: number; codes: string[] }[] = [];
  for (const c of cols) {
    const key = keyOf(c);
    const last = runs[runs.length - 1];
    // The leaf's FULL key set, matching its cells' `data-col` — a leaf is hidden if
    // either its section code or its billing group is, and bandColSpan has to agree
    // with the stylesheet or the banded header shears sideways.
    const leafKey = `${c.code} ${c.billingGroup}`;
    if (last && last.key === key) {
      last.count += 1;
      last.codes.push(leafKey);
    } else runs.push({ key, label: labelOf(c), count: 1, codes: [leafKey] });
  }
  return runs;
}

// Re-exported from the client wrapper that also uses them as `data-col` keys and as
// `?dept=` values, so the three cannot drift apart. See EtcGridView.
const DEPT_GROUPS = ETC_DEPT_GROUPS;

// Colored section-cell labels. Testing/Teardown show "All"/"Total" rather
// than a section name (those columns merge several codes — see sections.ts).
// The phase-10 codes used to override sections.ts's own `name` here with a
// second, independently hand-typed abbreviation ("ME Gen", "HMI", "Design and
// Drawings", ...) — found live, 2026-08-20: sections.ts's `name` now carries
// the centralized canonical wording, so this override was actively
// SUPPRESSING that rename on the one row that's most visible, while this same
// cell's own tooltip (built straight from `s.name`, line ~1397) had already
// moved on — the header text and its own tooltip disagreed. Removed rather
// than updated to match: `sectionDisplay` falls back to `s.name` below, so
// there is nothing left here to independently keep in sync.
const ETC_SECTION_DISPLAY: Record<string, string> = {
  "40-211": "All",
  "40-411": "Total",
  "50-211": "All",
  "50-411": "Total",
};

// Department header colors, matching the real "Managers Fill Out" sheet's
// column banding (ME = blue, CE = green, general engineering = teal, shop =
// tan). Machine Testing/Teardown & Install swap in their own Engineering/Shop
// tint (40-211/50-211 = Engineering, 40-411/50-411 = Shop) since those phases
// have no per-department breakdown, just the two billing groups.
// Re-themed to the SDC brand palette, matching the Projects tab's group bands
// so the two grids read as one system: ME = light blue, CE = green tint,
// General Engineering = bold brand blue, Shop = yellow tint, Engineering
// (40/50-211) = light blue #aacee8. Bold blue carries white text.
const SECTION_HEADER_COLOR: Record<string, string> = {
  "10-211": "bg-sdc-blue-light text-sdc-navy", // ME
  "10-312": "bg-sdc-green-bg text-sdc-navy", // CE — Design & Drawings
  "10-313": "bg-sdc-green-bg text-sdc-navy", // CE — Software
  "10-515": "bg-sdc-blue text-white", // General Engineering
  "10-516": "bg-sdc-blue text-white",
  "10-517": "bg-sdc-blue text-white",
  "10-518": "bg-sdc-blue text-white",
  "10-411": "bg-sdc-yellow-bg text-sdc-navy", // Shop — Mechanical Build
  "10-412": "bg-sdc-yellow-bg text-sdc-navy", // Shop — Electrical Build
  "40-211": "bg-sdc-blue-100 text-sdc-navy", // Engineering ME & CE
  "50-211": "bg-sdc-blue-100 text-sdc-navy",
  "40-411": "bg-sdc-yellow-bg text-sdc-navy", // Shop MB & EB
  "50-411": "bg-sdc-yellow-bg text-sdc-navy",
};

// Faint column wash (used on the DIFF sub-column header, which has no function
// color of its own) — the same brand hues at low opacity.
const SECTION_HEADER_COLOR_LIGHT: Record<string, string> = {
  "10-211": "bg-sdc-blue-light/60",
  "10-312": "bg-sdc-green-bg/60",
  "10-313": "bg-sdc-green-bg/60",
  "10-515": "bg-sdc-blue/10",
  "10-516": "bg-sdc-blue/10",
  "10-517": "bg-sdc-blue/10",
  "10-518": "bg-sdc-blue/10",
  "10-411": "bg-sdc-yellow-bg/60",
  "10-412": "bg-sdc-yellow-bg/60",
  "40-211": "bg-sdc-blue-100/25",
  "50-211": "bg-sdc-blue-100/25",
  "40-411": "bg-sdc-yellow-bg/60",
  "50-411": "bg-sdc-yellow-bg/60",
};

// The full ETC column list with all its header-row labels resolved once, so
// filtering is just `.filter(...)` on this and the header derives from it.
const ALL_ETC_COLS: EtcCol[] = ETC_SECTIONS.map((s) => ({
  code: s.code,
  name: s.name,
  billingGroup: s.billingGroup,
  phaseLabel: PHASE_DISPLAY[s.phase] ?? s.phase,
  groupLabel: s.billingGroup,
  subgroupLabel: SUBGROUP_DISPLAY[s.code] ?? s.name,
  sectionDisplay: ETC_SECTION_DISPLAY[s.code] ?? s.name,
}));

// Column-identity backgrounds for the 5-column block shared by every
// department/Parts Cost/Engineering/Shop group, matching the real sheet.
const HOURS_WORKED_BG = "bg-[#C7DAF7]";
const HOURS_LEFT_BG = "bg-[#F1F6FD]";
// New ETC cells always use the plain neutral background now — the old yellow
// "unconfirmed suggestion" wash was removed at the managers' request so the
// column reads clean for lookup like every other column. The pending count in
// the toolbar still tracks what's unconfirmed (needsReview), so nothing is lost
// operationally. Arg kept so callers don't all need editing.
function newEtcBg(_hasValue: boolean) {
  return "bg-[#F2F2F2]";
}
// The Diff colouring lives in components/ui/etc-diff-colors.ts: the live repaint
// (EtcLiveTotals) has to apply the SAME colours when a total's number changes, and it
// was leaving the server's behind. It is a magnitude gradient now, applied as inline
// styles — Tailwind cannot generate a computed colour.

// Hours display on this page is whole numbers with thousands separators — no
// decimals, rounded rather than truncated. Delegates to the shared formatter so
// this grid can't drift from the KPI cards above it, the Projects grid or the
// charts: a four-figure hour total was printing as "21993" here while the card
// directly above it read "2,198", which is the same number type formatted two
// ways on one screen. Use this for any value added here later too.
//
// Display-only, and it must stay that way — every form field on this page carries
// its raw value (String(worked), the New ETC input's own text state), because a
// comma would break the Number() parse in submitMonth.
function wholeNum(n: number): string {
  return formatHours(n);
}

// Header cells have no row value, so "New ETC"/"Diff" fall back to a neutral
// flat shade rather than the value-conditional colors used in the body.
function subColHeaderBg(col: string): string {
  if (col === "Prior ETC") return "bg-[#5E91D3] text-sdc-gray-700";
  if (col === "Hours Worked Month" || col === "Hours Worked" || col === "Money Spent Month") return HOURS_WORKED_BG;
  if (col === "Hours Left" || col === "Money Left") return HOURS_LEFT_BG;
  // ── The two breakout columns wear New ETC's grey (2026-09-03, by request) ──
  //
  // They shared Money Left's tint while they were read-only live figures. They are
  // now the cells a manager types into and New ETC is calculated from them, so the
  // grey is what says so: on this grid it is the editable-cell colour, and the three
  // Parts Cost columns that take input have to look like one another rather than like
  // the read-only column next door.
  if (col === "Left to Invoice" || col === "Left to Purchase") return "bg-[#F2F2F2]";
  if (col === "New ETC" || col === "Total New ETC") return "bg-[#F2F2F2]";
  return "";
}

// Column-level "this is editable" marker — replaces the old per-cell dashed
// underline, which got noisy across a grid this dense. Only "New ETC" is
// actually manager-editable (Hours Worked Month auto-syncs from Power BI and
// is read-only display now; Money Spent Month is likewise a read-only
// actual; the Total/Standard columns are pure rollups), so the pencil only
// appears on that column-label header cell.
// Parts Cost New ETC is no longer typed — it is Left to Invoice + Left to Purchase —
// so the pencil moved to the two cells that ARE typed. The set still carries "New ETC"
// because the hours sections' New ETC column is unchanged, and this is one header row
// shared by every section (the Parts Cost header is rendered from partsCostCols
// below, which is where the exception is applied).
const EDITABLE_COL_LABELS = new Set(["New ETC", "Left to Invoice", "Left to Purchase"]);
function colHeaderLabel(col: string) {
  if (!EDITABLE_COL_LABELS.has(col)) return col;
  return (
    <>
      {col} <span className="text-sdc-blue" title="Editable column">✎</span>
    </>
  );
}

// Same column-identity backgrounds, without a text-color opinion — for cells
// (like the "—" empty-section placeholder) that set their own text color.
function subColBodyBg(col: string): string {
  if (col === "Hours Worked Month" || col === "Hours Worked" || col === "Money Spent Month") return HOURS_WORKED_BG;
  if (col === "Hours Left" || col === "Money Left") return HOURS_LEFT_BG;
  // ── The two breakout columns wear New ETC's grey (2026-09-03, by request) ──
  //
  // They shared Money Left's tint while they were read-only live figures. They are
  // now the cells a manager types into and New ETC is calculated from them, so the
  // grey is what says so: on this grid it is the editable-cell colour, and the three
  // Parts Cost columns that take input have to look like one another rather than like
  // the read-only column next door.
  if (col === "Left to Invoice" || col === "Left to Purchase") return "bg-[#F2F2F2]";
  if (col === "New ETC" || col === "Total New ETC") return "bg-[#F2F2F2]";
  if (col === "Diff") return "bg-white";
  return "";
}

// Money formatting comes from ui/format (§39.13): `usd` for whole dollars and
// `usdExact` for the cents-precision figure behind it. These were two local copies
// of both — three files had the identical pair, under the identical names.
// Full names for the department abbreviations printed in the sub-group header
// row (SUBGROUP_DISPLAY) — only defined for labels that are actually
// abbreviated; "General Engineering"/"Shop" are already spelled out.
const SUBGROUP_FULL_NAME: Record<string, string> = {
  ME: "Mechanical Engineering",
  CE: "Controls Engineering",
  "ME & CE": "Mechanical Engineering & Controls Engineering",
  "MB & EB": "Mechanical Build & Electrical Build",
};

// The Standard Sheet columns appended to the grid once unlocked, in the order
// they print on that page — Execution Rates, Execution ETC (New ETC), Total
// ETC, the merged Standard Fees (Engineering + Shop as one), Contingency,
// Total Standard Fees, Notes. Display-only here (editing lives on /standard-sheet).
const STANDARD_LEAF_COLUMNS = [
  "Total ETC", "% Total",
  "Standard Fees",
  "Contingency",
  "Total Std Fees",
  "Notes",
] as const;

// Category → billing group / department, in the sheet's print order — drives the
// read-only "Standard Fees By Department" side panel. Moved to lib/pool-panel-meta.ts
// (§48) so the client-side card build reads the same list; see the note there.

// The department pools for `month`, or — if that month was never refreshed —
// the most recent PRIOR month's pools as a labeled fallback (so Standard Fees
// never silently collapse to $0). Mirrors the same-named helper on the
// /standard-sheet tab, keeping the two views in lockstep on which figures show.
async function loadEffectivePools(month: string) {
  const own = await prisma.categoryPool.findMany({ where: { month } });
  if (own.length > 0) return { pools: own, carriedFrom: null as string | null };
  const prior = await prisma.categoryPool.findFirst({
    where: { month: { lt: month } },
    orderBy: { month: "desc" },
    select: { month: true },
  });
  if (!prior) return { pools: own, carriedFrom: null as string | null };
  return { pools: await prisma.categoryPool.findMany({ where: { month: prior.month } }), carriedFrom: prior.month };
}
// Marks the left edge of the whole Standard block, every phase/Parts-Cost/
// Total block boundary, and the billing-group/sub-group boundaries nested
// inside a phase — all unified at one heavier weight (8px) than the grid's
// normal thin gridline, so every structural section break reads the same.
// `!` forces these to win over TABLE_GRID's blanket `[&_th]:border-l`/
// `[&_td]:border-l` rules, which — being a class+element selector —
// otherwise out-specificity a plain utility class and silently reset the
// border back to the grid's thin default. Matches TABLE_GRID's own gridline
// color (#808080, a mid gray) exactly — same color on both the wide
// border-left and the thin border-bottom means their mitered corner is
// invisible, instead of the jagged two-tone seam a mismatched divider color
// made.
const STD_EDGE = "border-l-8! border-l-[#808080]!";
const PHASE_EDGE = "border-l-8! border-l-[#808080]!";
const GROUP_EDGE = "border-l-8! border-l-[#808080]!";
const SUBGROUP_EDGE = "border-l-8! border-l-[#808080]!";

// ── The grid's cell padding, which used to be two user controls (§45) ───────
//
// These blanket rules gave every body cell and in-cell input one uniform padding.
// They read --etc-row-py / --etc-col-px, which the View menu's Row height and Column
// width steppers wrote (0–16px, persisted, this tab only) — and a matching pair on
// Projects wrote --quoted-row-py / --quoted-col-px, so the two grids could sit at
// different densities in the same app. §45 replaced all four with the one sidebar
// Zoom, which scales these paddings along with everything else, so what is left here
// is the constant the steppers defaulted to.
//
// 0.2667rem, not 4px: 4px at the 15px root, and rem is what keeps a padding in step
// with the type scale (§39.14) and reachable by the browser's own text-size setting.
// Nothing on screen moved — that is checked live, and the DEVLOG section for §45
// records the measurement.
//
// Same specificity trick as TABLE_GRID (a class+element descendant selector beats a
// plain utility class on the cell itself) so no `!` is needed. `:not sticky` keeps the
// frozen #/Job Id/Job Name columns — which own their own fixed widths — off the
// horizontal rule.
//
// leading-none stays: it collapses the line box so the row height is the padding plus
// the glyphs rather than the font's own generous default.
//
// Row height is scoped to TBODY on purpose. It used to hit every `td`, which included
// the grand-total row — so that row's own py-2.5 was overridden down to 4px and it read
// as a hairline strip under the data (reported 2026-07-30: "bottom header too thin").
// Horizontal padding stays grid-wide, because the totals must keep column alignment
// with the rows above them.
//
// The grid also carried a "Font size" box writing --etc-font-size, which had NEVER
// worked (globals.css's un-layered `table, table * { font-size: … !important }` beat
// it; measured 2026-08-04 — setting it to 22px moved a cell from 10.2px to 10.2px).
// §39.14 fixed it with a `table[data-grid="etc"]` rule; §45 removed the control, and
// that rule with it. `data-grid="etc"` stays on the table — GridViewProvider scopes
// its generated column-hiding CSS by it.
const CELL_PADDING =
  "[&_tbody_td]:py-[0.2667rem] [&_tbody_td]:leading-none [&_td_input]:py-[0.2667rem] [&_td_input]:leading-none [&_td:not([class*='sticky'])]:px-[0.2667rem] [&_th:not([class*='sticky'])]:px-[0.2667rem] [&_td_input:not([class*='sticky'])]:px-[0.2667rem]";


export async function MonthlyEtcView({ params }: { params: { month?: string; dept?: string; jobname?: string; billables?: string } }) {
  const etcSession = await requirePagePermission("monthly-etc:view");
  // Read-only is now a real state: monthly-etc:view without monthly-etc:edit.
  // The server action re-checks this independently (saveAllNewEtcDrafts), so
  // this flag only decides what is RENDERED — it is not the enforcement.
  const canEditEtc = hasPermission(etcSession.user.role, "monthly-etc:edit");
  const { month: monthParam, dept: deptParam, jobname: jobnameParam, billables: billablesParam } = params;

  // Billable / Non-Billable row filter (same pattern as the Projects tab).
  // Absent => both shown. SDC's own projects read as Non-Billable regardless of
  // the stored flag (isSdcCustomer), matching how they display everywhere else.
  const BILLABLE_OPTIONS = ["Billable", "Non-Billable"];
  const selectedBillables = billablesParam === undefined ? BILLABLE_OPTIONS : billablesParam.split(",").filter(Boolean);
  const showBillable = selectedBillables.includes("Billable");
  const showNonBillable = selectedBillables.includes("Non-Billable");
  const billableFilterActive = !(showBillable && showNonBillable);
  // Job Name column toggle (Columns dropdown) — shown unless ?jobname=0.
  //
  // NOT used to decide what to render any more (§40.2). The column is always printed
  // and hidden with CSS, because a server round-trip plus a 3,649-mutation React
  // reconciliation to stop showing 49 cells that were already on screen is what made
  // this menu feel broken. This value now only seeds the client's initial hidden set,
  // so a reload and a shared link still show what the URL asks for. See
  // lib/grid-view.ts and GridViewProvider.
  const showJobName = jobnameParam !== "0";

  // Engineering / Shop column filter. Empty or absent => show both (the full
  // grid); the grid can never collapse to zero section columns.
  const selectedGroups = (() => {
    const raw = (deptParam ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((g): g is (typeof DEPT_GROUPS)[number] => g === "Engineering" || g === "Shop");
    return new Set(raw.length ? raw : DEPT_GROUPS);
  })();
  // ── The grid is printed COMPLETE, always (§40.2) ────────────────────────────
  //
  // These used to be filtered here, which meant every tick of the View menu's
  // "Section columns" was a route navigation: a fresh 596KB payload and a React
  // reconciliation of 4,272 cells, measured at 4,113 DOM mutations and ~100ms of
  // blocked main thread to hide columns that were already rendered.
  //
  // Now both are the full set on every render and visibility is one CSS rule, applied
  // by GridViewProvider. The filter costs nothing per cell, so it is instant no matter
  // how large the month is.
  //
  // This is safe for the money on the page, which is the only reason it is allowed:
  // `totals` below iterates ETC_SECTIONS (every section, not the visible ones), and
  // `sectionGrandTotals` is keyed per section code, so no figure anywhere on this grid
  // changes with which columns are shown. A hidden column's total is hidden with it.
  // Anything that DID change a total stays server-side — see the `billables` filter,
  // which still navigates.
  const visibleCols = ALL_ETC_COLS;
  const visibleGroups = DEPT_GROUPS;
  // What the client starts hidden, parsed from the URL so SSR and a share link agree.
  // `jobname` is a pseudo-column key: the Job Name cells carry data-col="jobname".
  const initialHiddenView = [
    ...DEPT_GROUPS.filter((g) => !selectedGroups.has(g)),
    ...(showJobName ? [] : ["jobname"]),
  ];
  const initialHiddenSet: ReadonlySet<string> = new Set(initialHiddenView);

  // The banded header cells' colSpans for the FIRST render.
  //
  // GridViewProvider recomputes these on every later change, but it does so in an
  // effect — which runs after hydration. Without this the server would emit full-width
  // bands for a URL that already hides a group (a shared link, a reload, a saved View),
  // and the banded header would sit visibly sheared until hydration caught up. The
  // stylesheet is server-rendered for exactly the same reason.
  //
  // A band with every leaf hidden gets display:none rather than colSpan={0}, because 0
  // means "span to the end of the column group" in HTML — see bandColSpan.
  const bandProps = (codes: readonly string[], mult: number) => {
    const span = bandColSpan(codes, initialHiddenSet, mult);
    return {
      "data-band-codes": codes.join(","),
      "data-band-mult": mult,
      colSpan: span === 0 ? 1 : span,
      style: span === 0 ? { display: "none" } : undefined,
    } as const;
  };

  // Every section that starts a new phase (Complete Design & Build / Testing /
  // Teardown & Install) gets a heavier divider — like the sheet's solid black
  // rules between phase blocks — instead of the grid's usual thin gridline.
  const phaseStartCodes = new Set<string>();
  {
    let lastPhase: string | undefined;
    for (const c of visibleCols) {
      if (c.phaseLabel !== lastPhase) {
        phaseStartCodes.add(c.code);
        lastPhase = c.phaseLabel;
      }
    }
  }

  // Same idea, one level down: billing-group (Engineering/Shop) boundaries
  // within a phase, and sub-group (ME/CE/GE/dept) boundaries within a billing
  // group — each gets its own divider weight, lighter than the phase divider
  // above it but still heavier than the grid's default gridline.
  const groupStartCodes = new Set<string>();
  const subgroupStartCodes = new Set<string>();
  {
    let lastGroup: string | undefined;
    let lastSubgroup: string | undefined;
    for (const c of visibleCols) {
      const groupKey = `${c.phaseLabel}|${c.groupLabel}`;
      if (groupKey !== lastGroup) {
        groupStartCodes.add(c.code);
        lastGroup = groupKey;
      }
      const subgroupKey = `${groupKey}|${c.subgroupLabel}`;
      if (subgroupKey !== lastSubgroup) {
        subgroupStartCodes.add(c.code);
        lastSubgroup = subgroupKey;
      }
    }
  }

  // Priority: phase > billing-group > sub-group > the grid's normal thin
  // gridline. Every boundary set above a given level also implies the ones
  // below it (a new phase is also a new group and sub-group), so checking in
  // this order and returning on the first match is enough.
  function edgeFor(code: string, index: number): string {
    if (index === 0) return "border-l border-sdc-border";
    if (phaseStartCodes.has(code)) return PHASE_EDGE;
    if (groupStartCodes.has(code)) return GROUP_EDGE;
    if (subgroupStartCodes.has(code)) return SUBGROUP_EDGE;
    return "border-l border-sdc-border";
  }

  // Both in one round trip: `inProgressMonths` asks about every month with a pending
  // entry, so it does not depend on which month this render settles on. Awaiting them in
  // sequence just added one query's latency for nothing.
  const [distinctMonths, inProgressMonths] = await Promise.all([
    prisma.etcEntry.findMany({
      distinct: ["month"],
      select: { month: true },
      orderBy: { month: "desc" },
    }),
    // A month is locked when it has entries and none still need review — months with any
    // pending entry are "in progress"; the rest of the history is locked.
    prisma.etcEntry.groupBy({
      by: ["month"],
      where: { needsReview: true },
    }),
  ]);
  // A malformed ?month= (typo'd URL) must not flow into queries/date math —
  // fall back to the default month instead of rendering a nonsense view.
  const month = (monthParam && isValidMonth(monthParam) ? monthParam : undefined) || distinctMonths[0]?.month || currentMonth();

  // ── Do Left to Invoice / Left to Purchase exist for this month? ───────────
  //
  // August 2026 onward, by request (lib/parts-breakout-scope.ts carries the why).
  // Everything downstream keys off this one boolean rather than re-deriving it.
  const showBreakout = showsPartsBreakout(month);
  const partsCostCols: readonly (typeof PARTS_COST_SUB_COLUMNS)[number][] = showBreakout
    ? PARTS_COST_SUB_COLUMNS
    : PARTS_COST_SUB_COLUMNS.filter((c) => c !== "Left to Invoice" && c !== "Left to Purchase");
  const inProgressSet = new Set(inProgressMonths.map((m) => m.month));
  const lockedMonthList = distinctMonths.map((m) => m.month).filter((m) => !inProgressSet.has(m));

  // Once the latest month is locked, the only seedable month is the next one —
  // surface it in the picker so it can actually be started.
  const latestMonth = distinctMonths[0]?.month;
  const nextStartable = latestMonth && !inProgressSet.has(latestMonth) ? nextMonth(latestMonth) : undefined;

  // A reopened HISTORICAL month is a correction pass: every stored newEtc is a
  // previously-confirmed value the grid must seed its inputs from, so a
  // no-changes resubmit is a true no-op. Detected by month position rather
  // than per-entry submittedAt, because Excel restores and the Power BI
  // history backfill both leave submittedAt null on confirmed history.
  const isHistoricalMonth = latestMonth != null && month < latestMonth;

  // Which jobs the grid shows depends on whether the month is history:
  // - A locked month is a frozen snapshot — show exactly the jobs that have
  //   entries in it (Power BI parity), regardless of what their status is
  //   TODAY. Filtering by current status hides every job completed since,
  //   which made historical months show far fewer jobs than the source report.
  // - An in-progress (or not-yet-started) month keeps etcActiveJobFilter —
  //   the same universe seeding/pruning/submission operate on, which must
  //   stay in lockstep with the grid.
  // Single source of truth for the month's job universe — the Standard Sheet
  // reads from the exact same helper, so the two pages can never drift on which
  // projects a month contains.
  const { where: monthJobWhere, monthIsLocked } = await getEtcMonthJobWhere(month);

  const [jobs, lastPowerBiSync, hoursActualFreshness, etcHoursFreshness, undefinedHoursTotals] = await Promise.all([
    prisma.job.findMany({
      where: monthJobWhere,
      include: { etcEntries: { where: { month } }, executionRate: true },
    }),
    prisma.jobMonthlyActualHours.findFirst({ orderBy: { syncedAt: "desc" }, select: { syncedAt: true } }),
    prisma.powerBiFreshness.findUnique({ where: { source: "hours_actual" }, select: { refreshedThrough: true, status: true, checkedAt: true } }),
    // The ETC grid's own hours sync, tracked separately: syncActualHours can
    // succeed (leaving "hours_actual" looking healthy) while this one fails,
    // which is exactly how the grid went stale behind a reassuring header.
    prisma.powerBiFreshness.findUnique({ where: { source: "etc_hours_worked" }, select: { status: true, checkedAt: true } }),
    // Time the importer could not attribute to any job — booked against
    // "Not Defined" and similar. Absent from every figure on this page, so it
    // is stated rather than left as an unexplained shortfall. Rows that round to 0
    // hours are excluded here too, by the same rule the drill applies (see
    // getUndefinedHoursTotals) — the card and the drill it opens must never disagree.
    getUndefinedHoursTotals(month),
  ]);
  // No `role` read here any more: every control on this page that used to be
  // admin-only (Reopen, Sync History) is password-gated instead, checked
  // server-side in the action rather than by hiding a button. 2026-08-02.

  // Hours recorded against jobs this month's grid does NOT render.
  //
  // Found 2026-08-02 reconciling against Power BI: job 1163 had 105.82 July hours while
  // the grid showed 3,128 instead of 3,234. Its status had moved to HeadStart, and
  // etcActiveJobFilter is status:"Active" — so seeding created its rows while it was
  // Active, the hours sync kept filling them in, and the grid then stopped showing it.
  //
  // ── Sourced from PUNCHES, not EtcEntry (2026-08-03) ───────────────────────
  //
  // This used to read EtcEntry, and that was the wrong table: pruneStaleEntries deletes
  // exactly these rows on the next Refresh Data and submitMonth deletes them as staleIds
  // on submit, so the figure this card exists to show was erased by the very actions it
  // was warning about. Asked to stop that happening, and the honest fix is not to keep
  // the rows — prune has to delete them or a month can never be submitted (seeding,
  // pruning and submission must all share etcActiveJobFilter) — but to stop depending on
  // them.
  //
  // JobHoursDetail is the durable record: one row per employee/day/job/section, written
  // by the hours sync and never touched by prune or submit. Reading it makes this card
  // unwipeable by design rather than by a promise not to delete.
  //
  // It is also simply more complete. Measured on 2026-07 the moment this changed: 126.3
  // hours existed in punches with no EtcEntry row at all — 105.81h of it job 1163's,
  // exactly the loss the paragraph above predicted, plus 8.99h of job 4000 that was
  // under-reported even while the job WAS listed, and 11.5h on four Complete jobs that
  // never appeared. The card's figure moves up accordingly; it was wrong before, not now.
  //
  // No PARTS_COST concern here either: punches are hours by construction, so there is no
  // dollars-in-an-hours-total trap to avoid (which EtcEntry needed excluding for).
  //
  // Type-gated like every other job query. Still deliberately NOT folded into any total:
  // whether this work belongs in an ETC month is a business call, and quietly changing
  // which jobs a month contains would move the pools and the Standard Fees with it.
  const renderedJobIds = jobs.map((j) => j.id);
  // COMPLETE jobs are excluded (2026-08-03, by request). Reading from punches surfaced
  // four of them holding 11.5 July hours, and they are not what this card is for: every
  // other row here is a job you might still act on by setting it back to Active and
  // billable, whereas a finished job is finished — a stray hour booked to it is a
  // timesheet matter, not an ETC planning gap. Those hours remain visible on Job Hour
  // Details and the Projects grid, which is where they belong.
  // ── One wave, not four (2026-08-04, performance pass) ─────────────────────
  //
  // These four reads are independent of each other: two of them need `month` and
  // `renderedJobIds`, the other two need nothing at all. They were awaited one after
  // another, so the page paid four serial round trips for work that fits in one — and
  // this route is re-rendered far more often than it is navigated to (a timer, focus,
  // every filter change, every colleague's save), so the latency was being paid over
  // and over. Measured with scripts/perf-baseline.ts: the ETC page had NINE serial
  // waves for 18 queries.
  //
  // The Scheduler lookup crosses to a different MySQL server and the two gates read
  // cookies, so they are the ones most worth not queueing behind a punch query.
  const [hiddenJobEntries, headStartJobs, { baseUrl: schedulerBaseUrl, jobNumbers: schedulerJobNumbers, ssoEmail: schedulerSsoEmail }, showStandards] =
    await Promise.all([
      prisma.jobHoursDetail.findMany({
        where: {
          month,
          hours: { gt: 0 },
          jobId: { notIn: renderedJobIds },
          job: { ...validJobTypeFilter, status: { not: "Complete" } },
        },
        select: { hours: true, section: true, job: { select: { jobId: true, jobName: true, status: true } } },
      }),
      // Type-gated like every other job query (non-negotiable). No need to exclude the
      // rendered set: etcActiveJobFilter is status "Active", so a HeadStart job can
      // never be in it.
      prisma.job.findMany({
        where: { status: "HeadStart", ...validJobTypeFilter },
        select: { jobId: true, jobName: true, status: true },
      }),
      // "Open in Scheduler" icon target + which of these jobs actually have a
      // Scheduler project (fail-soft empty set when its DB isn't configured).
      getSchedulerLinkContext(),
      // Whether the hidden Standard Sheet view is unlocked for this session.
      isStandardSheetUnlocked(),
    ]);
  // ── HeadStart jobs are ALWAYS listed here ─────────────────────────────────
  //
  // 2026-08-03, by request. The query above only finds a job that has EtcEntry rows
  // WITH hours, which means a HeadStart job appears only by accident — if it happened
  // to be seeded while it was still Active and hasn't been pruned yet. A job that was
  // HeadStart all along has no rows, so it was invisible on this page entirely.
  //
  // Both of the current HeadStart jobs are in exactly that state: 1151 and 1163 have
  // ZERO July rows. And 1163 is the job the comment above was written about, when it
  // held 105.82 July hours — those rows have since been deleted, which is the loss that
  // comment predicted actually happening.
  //
  // job-filters.ts states the standing assumption: "A HeadStart job has no PO, so no
  // hours can be booked against it… If HeadStart work does start getting booked, this
  // is the line to revisit." Listing them here is the cheap half of revisiting it —
  // they stay out of the grid and out of every total, so the ENG/SHOP figures the team
  // signs off are untouched, but a HeadStart job booking time is now visible instead of
  // silently dropped.
  //
  // (the query itself now runs in the single wave above.)

  // Punch rows are one per employee/day/section, so sections are ACCUMULATED into a map
  // rather than pushed. Pushing (which was right for EtcEntry, one row per section) would
  // list "ME Gen" once per working day.
  const hiddenByJob = new Map<string, { jobId: string; jobName: string; status: string | null; hours: number; sectionHours: Map<string, number> }>();
  for (const e of hiddenJobEntries) {
    const k = e.job.jobId;
    const cur = hiddenByJob.get(k) ?? { jobId: k, jobName: e.job.jobName, status: e.job.status, hours: 0, sectionHours: new Map<string, number>() };
    const h = Number(e.hours);
    cur.hours += h;
    cur.sectionHours.set(e.section, (cur.sectionHours.get(e.section) ?? 0) + h);
    hiddenByJob.set(k, cur);
  }
  // Added AFTER, so a HeadStart job that does have hours keeps them rather than being
  // overwritten with an empty shell.
  for (const j of headStartJobs) {
    if (hiddenByJob.has(j.jobId)) continue;
    hiddenByJob.set(j.jobId, { jobId: j.jobId, jobName: j.jobName, status: j.status, hours: 0, sectionHours: new Map() });
  }

  const hiddenJobHours = [...hiddenByJob.values()]
    // ── Nothing booked, nothing to report (2026-08-05, by request) ───────────
    //
    // A job with 0 hours is not hours off the grid. This block exists to account for
    // time that reaches no total below, and a job that booked none is not part of that
    // shortfall — it was padding a list whose headline is a number of HOURS.
    //
    // This reverses the HeadStart rule added on 2026-08-03 ("listed always, even at 0
    // hours, so one that starts booking time is seen"). The intent there is preserved
    // for free: the moment such a job books an hour it clears this filter and appears
    // on its own. What is lost is the standing reminder that the job exists at all —
    // which is the Projects tab's job, not this block's.
    //
    // Filtered HERE, at the single source, rather than in the panel: the KPI card, the
    // issues chip and the drill all read this array, so filtering downstream would have
    // left the card counting 5 while the drill listed 4. (The chip was already applying
    // its own `hours > 0` filter to work around exactly that, and can now stop.)
    .filter((j) => j.hours > 0)
    // Sections in the Monthly ETC grid's own column order, not by hours (2026-08-03,
    // by request) — see compareSections. Jobs stay ordered by hours, biggest first.
    .map(({ sectionHours, ...j }) => ({
      ...j,
      sections: [...sectionHours.entries()]
        .map(([section, hours]) => ({ section, hours }))
        .sort((a, b) => compareSections(a.section, b.section)),
    }))
    .sort((a, b) => b.hours - a.hours);

  // Numeric Job Id order like the sheet (979 before 1020 before 10000) — the
  // column is a string, so the DB's own sort is lexicographic.
  jobs.sort((a, b) => compareJobIds(a.jobId, b.jobId));

  // Active T&M jobs sink to the BOTTOM, whatever the Job Id order says.
  //
  // Time & materials is billed as it is worked, so an ETC on one is a different
  // kind of number from a fixed-quote estimate — grouping them out of the main
  // sequence keeps the two from being read as one list. Same device the Projects
  // grid uses to sink SDC's own jobs.
  //
  // Array#sort is stable, so this only moves rows across the T&M boundary and
  // leaves the Job Id order within each group untouched.
  const isActiveTm = (j: { status: string | null; type: string | null }) => j.status === "Active" && j.type === "T&M";
  jobs.sort((a, b) => Number(isActiveTm(a)) - Number(isActiveTm(b)));

  // Rows the grid actually renders after the Billable filter. The FULL `jobs`
  // set still drives month status (started/locked/pending) and submission —
  // this filter is a display-only view, so it never changes what a Submit &
  // Lock would persist (which is why submitting is blocked while it's active).
  const visibleJobs = billableFilterActive
    ? jobs.filter((j) => {
        const effectiveBillable = j.billable && !isSdcCustomer(j.customer);
        return (effectiveBillable && showBillable) || (!effectiveBillable && showNonBillable);
      })
    : jobs;

  // KPI cards above the grid, built from `visibleJobs` — the same rows the grid
  // renders and the same rows its grand-total row sums, so the strip at the top
  // and the total at the bottom can never disagree. Free: it sums the etcEntries
  // already loaded above and runs no query of its own.
  //
  // The punch detail behind the drill is NOT loaded here any more (2026-08-04,
  // performance pass). It was 1,092 rows and 46ms — the slowest query on the page —
  // shipped in the RSC payload of every render for a panel that starts closed, and
  // this route re-renders on a timer, on focus, on every filter change and on every
  // colleague's save. The card now gets the job IDs and fetches the rows when a
  // drill is opened (lib/hours-detail-actions.ts). Scope is unchanged: the same
  // `visibleJobs`, so the drill still matches the card that opened it.
  const monthKpis = await getEtcMonthKpis(month, visibleJobs);
  const detailJobIds = visibleJobs.map((j) => j.id);

  // Rates are shared with /standard-sheet's own ExecutionRate rows — once
  // that tab has submitted+frozen this month's snapshot, rates must stop
  // changing here too (matches that tab's own editable/frozen rule).
  const standardSheetSubmitted = showStandards
    ? !!(await prisma.standardSheetSnapshot.findFirst({ where: { month }, select: { id: true } }))
    : false;

  // Fixed inputs only — Total ETC $/% Total/Standard Fees/Total Standard
  // Fees are all cross-linked (a rate edit shifts every job's % Total) and
  // computed live client-side by StandardRatesProvider/EtcStandardCells.
  const standardByJob = new Map<number, StandardJobBase>();
  // Per-category pool inputs the provider derives live poolTotals from.
  let poolRowsForProvider: PoolRowInput[] = [];
  let contingencyRate = 1.2;
  // Global execution rates applied to every job in this grid's Standard view —
  // set via the "ETC Rates" button, stored on the StandardSheetSetting row.
  let standardRates: StandardRates = { engrRate: 170, shopRate: 140, partsMarkup: 1.2 };
  let poolPanelRows: PoolPanelRow[] = [];
  // The jobs behind this month's "New Hours Added" — itemised under the pool
  // block, since the Projects page no longer carries a new-project view.
  let poolNewProjects: NewProjectRow[] = [];
  let poolsCarriedFrom: string | null = null;
  let poolsUpstreamNote: string | null = null;
  // Frozen snapshot rows for a submitted month — the grid renders these instead
  // of live math so a later rate/pool edit can't mutate a locked month.
  let frozenStandardRows: FrozenStandardRow[] | undefined;

  if (showStandards) {
    const [execEtcByJob, effective, setting, newProjects] = await Promise.all([
      getExecutionEtcByJob(jobs.map((j) => j.id), month),
      // Same carry-forward fallback the /standard-sheet tab uses, so the inline
      // Standard fees and the pool panel never silently collapse to $0 for a
      // month whose pools were never pulled.
      loadEffectivePools(month),
      prisma.standardSheetSetting.findUnique({ where: { id: 1 } }),
      // Always for THIS month, never the carried-from one: the list explains
      // which jobs started in the month you are looking at. When the pools are
      // a carry-forward estimate the panel already says so on its own banner.
      newProjectsEnteringMonth(month),
    ]);
    const pools = effective.pools;
    poolNewProjects = newProjects;
    poolsCarriedFrom = effective.carriedFrom;
    // The pools sync records WHY a month has no figures of its own (normally:
    // Power BI has not published the period yet). Read here so the panel can say
    // it, rather than telling people to click a Refresh that cannot help.
    const poolsFreshness = await prisma.powerBiFreshness.findUnique({
      where: { source: "standard_pools" },
      select: { status: true },
    });
    poolsUpstreamNote = poolsFreshness?.status?.startsWith("Waiting: ")
      ? poolsFreshness.status.slice("Waiting: ".length)
      : null;
    contingencyRate = setting ? Number(setting.contingencyRate) : 1.2;
    standardRates = {
      engrRate: setting ? Number(setting.engrRate) : 170,
      shopRate: setting ? Number(setting.shopRate) : 140,
      partsMarkup: setting ? Number(setting.partsMarkup) : 1.2,
    };
    poolRowsForProvider = POOL_PANEL_META.map(({ category }) => {
      const p = pools.find((x) => x.category === category);
      return {
        category,
        hoursAvailable: p ? Number(p.hoursAvailable) : 0,
        hoursPulled: p ? Number(p.hoursPulledThisMonth) : 0,
        rate: p ? Number(p.rate) : 0,
      };
    });

    poolPanelRows = POOL_PANEL_META.map(({ category, group, dept }) => {
      const p = pools.find((x) => x.category === category);
      return {
        category,
        group,
        dept,
        previousMonthPulledHours: p ? Number(p.previousMonthPulledHours) : 0,
        newHoursAddedThisMonth: p ? Number(p.newHoursAddedThisMonth) : 0,
        hoursAvailable: p ? Number(p.hoursAvailable) : 0,
        hoursWorkedThisMonth: p ? Number(p.hoursWorkedThisMonth) : 0,
        hoursPulledThisMonth: p ? Number(p.hoursPulledThisMonth) : 0,
        rate: p ? Number(p.rate) : 0,
        newEtcHours: p ? Number(p.newEtcHours) : 0,
        standardFee: p ? Number(p.standardFee) : 0,
        hasData: !!p,
      };
    });

    if (standardSheetSubmitted) {
      // Frozen month: render exactly the snapshot rows (contingency/notes and
      // every derived figure come from the freeze, immune to later edits).
      const snapshots = await prisma.standardSheetSnapshot.findMany({ where: { month } });
      frozenStandardRows = [];
      for (const s of snapshots) {
        standardByJob.set(s.jobId, {
          jobId: s.jobId,
          jobName: jobs.find((j) => j.id === s.jobId)?.jobName ?? "",
          etcEngineering: Number(s.etcEngineering),
          etcShop: Number(s.etcShop),
          etcParts: Number(s.etcParts),
          contingencyAmount: Number(s.contingencyAmount),
          notes: s.notes ?? "",
        });
        frozenStandardRows.push({
          jobId: s.jobId,
          totalEtcDollars: Number(s.totalEtcDollars),
          percentOfTotal: Number(s.percentOfTotal),
          standardFees: Number(s.standardFeeEngineering) + Number(s.standardFeeShop),
          totalStandardFees: Number(s.totalStandardFees),
        });
      }
    } else {
      for (const job of jobs) {
        // Same membership rule as the sheet's fee job list: non-billable /
        // flag-excluded jobs stay on the grid but get no Standard Fees row
        // and don't enter the % of total base.
        if (!isInStandardFeesAllocation(job)) continue;
        const etc = execEtcByJob.get(job.id) ?? { engineering: 0, shop: 0, parts: 0 };
        standardByJob.set(job.id, {
          jobId: job.id,
          jobName: job.jobName,
          etcEngineering: etc.engineering,
          etcShop: etc.shop,
          etcParts: etc.parts,
          contingencyAmount: job.executionRate ? Number(job.executionRate.contingencyAmount) : 0,
          notes: job.executionRate?.notes ?? "",
        });
      }
    }
  }

  const allEntries = jobs.flatMap((j) => j.etcEntries);
  const started = allEntries.length > 0;
  const locked = isMonthLocked(allEntries);
  // ── Read-only is NOT the same as locked (2026-09-01) ──────────────────────
  //
  // `locked` means the month is FROZEN — submitted. It drives the "Locked
  // (submitted)" badge and the Reopen Month button, so a role that simply lacks
  // edit rights must not be folded into it: a read-only PM would be told the
  // month had been submitted and offered a button to reopen it, neither of
  // which is true.
  //
  // This flag is the other reason an input is disabled: monthly-etc:view
  // WITHOUT monthly-etc:edit, a state that only became expressible when the
  // permission was split. Passed to every component that renders an editable
  // cell (EtcSectionCells, PartsCostNewEtcCell, EtcAutosave, the department
  // checklist) in place of `locked`, so a read-only role gets the whole grid
  // read-only with no cell left behind.
  //
  // Presentation only. saveAllNewEtcDrafts re-checks monthly-etc:edit
  // server-side and refuses regardless of what the browser was handed.
  const cellsReadOnly = locked || !canEditEtc;

  // ── The department ETC sign-off checklist (§50) ────────────────────────────
  //
  // One row per department, read for THIS month — switching the picker re-renders with the other
  // month's statuses, which is the property §50 asks for and the one a component
  // holding its own state would quietly break.
  //
  // The manageable map is computed here from the SAME policy the server action enforces
  // (canManageDepartment), purely so a box the server would refuse arrives greyed out.
  // It is not the permission check: §50 is explicit that frontend disabling is not
  // authorization, and lib/etc-department-actions.ts re-derives all of this per call.
  const departmentCompletions = await readDepartmentCompletions(month);
  const deptSession = await auth();
  const manageableDepts = manageableDepartments(
    {
      email: deptSession?.user?.email ?? null,
      role: deptSession?.user?.role ?? null,
    },
    parseDepartmentOwners(process.env[DEPARTMENT_OWNERS_ENV]),
  );
  // "2026-07" -> "JULY 2026", parsed as local parts. `new Date("2026-07")` is UTC
  // midnight and prints as the PREVIOUS month west of Greenwich — this server is UTC-4,
  // so every heading would be a month early. Same trap, same fix, as EtcMonthKpiCards.
  const monthHeading = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
    .toLocaleString("en-US", { month: "long", year: "numeric" })
    .toUpperCase();
  // Submission readiness, permission and the month's data fingerprint, for the Standard
  // Fees card's status line (§26.4). Computed here so the card's first paint already says
  // whether the month can be submitted; the client re-checks on mount and whenever a
  // realtime change lands. Only when the card is actually rendered — it is a real query
  // and nobody else needs it.
  //
  // Fetched for a LOCKED month too, unlike the first cut: that is where the submission
  // receipt comes from (who submitted it, when, under which id — §26.8), and a frozen
  // month would otherwise show a bare "Submitted" with none of it.
  const reportReadiness = showStandards ? await checkMonthlyReport(month) : null;
  const needsReviewCount = allEntries.filter((e) => e.needsReview).length;

  // A month's live actuals are only "complete" once the Paylocity hours are
  // refreshed through its final calendar day. Until then — for the current,
  // in-progress month — Money Spent, Parts Cost, and the auto-suggested New ETC
  // stay blank, so partial mid-month figures don't masquerade as final. Locked
  // (submitted) and historical months are always complete. This is display-only:
  // stored values and the submit path are untouched.
  // "July" — the month name the ONE submit button carries (`Submit July Report`), so
  // the label always names what it will freeze. Computed here rather than in the
  // client component: the button then renders correctly in the very first paint, and
  // the app has one place that turns "2026-07" into a human month.
  const monthNameOnly = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleString("en-US", { month: "long" });
  // The Left to Invoice cutoff, spelled out for the tooltip. From lib/left-to-invoice.ts
  // so the words and the arithmetic cannot name different days — and so it is testable,
  // which an IIFE inside this file is not.
  const cutoffLabel = monthEndLabel(month);

  const [completeYear, completeMonthNum] = month.split("-").map(Number);
  const monthEndDate = new Date(Date.UTC(completeYear, completeMonthNum, 0)); // last day of the month
  const hoursRefreshedThrough = hoursActualFreshness?.refreshedThrough ?? null;
  const monthComplete =
    locked || isHistoricalMonth || (hoursRefreshedThrough != null && hoursRefreshedThrough >= monthEndDate);

  // ── Every finding the banners used to carry, as data (§44) ────────────────
  //
  // Built from the SAME queries the banners used, so nothing new is fetched and nothing
  // is checked differently — only the presentation changed. buildEtcIssues owns the
  // ordering and the "don't report the same outage twice" rule, so the page does not
  // re-derive either.
  const stamp = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : null);
  const failedDetail = (s: string | null | undefined) => (s ?? "").replace(/^Failed:\s*/, "");
  const etcIssues = buildEtcIssues({
    hoursSyncFailure: hoursActualFreshness?.status?.startsWith("Failed")
      ? { detail: failedDetail(hoursActualFreshness.status), at: stamp(hoursActualFreshness.checkedAt) }
      : null,
    etcHoursSyncFailure: etcHoursFreshness?.status?.startsWith("Failed")
      ? { detail: failedDetail(etcHoursFreshness.status), at: stamp(etcHoursFreshness.checkedAt) }
      : null,
    undefinedHours: {
      hours: undefinedHoursTotals.hours,
      entries: undefinedHoursTotals.entries,
    },
    // No `hours > 0` filter here any more — hiddenJobHours is filtered at source now
    // (see where it is built), so the chip, the KPI card and the drill count one list.
    // This used to apply its own filter while the card did not, which is how the chip
    // said "4 jobs" beside a card saying "5 jobs not listed".
    offGrid: {
      hours: hiddenJobHours.reduce((s, j) => s + j.hours, 0),
      jobs: hiddenJobHours.length,
    },
  });

  // Grand totals footer, matching the real sheet's row 63 — accumulated as
  // each job row below computes its own values, then rendered once after.
  // No `decided` counter any more: newEtcDiff is live for every cell, so every
  // cell contributes to the variance and there is no longer such a thing as a
  // total with "nothing decided" in it.
  const sectionGrandTotals = new Map(
    ETC_SECTIONS.map((s) => [s.code, { prior: 0, worked: 0, newEtc: 0, diff: 0 }]),
  );
  const groupGrandTotals = {
    Engineering: { prior: 0, worked: 0, newEtc: 0, diff: 0 },
    Shop: { prior: 0, worked: 0, newEtc: 0, diff: 0 },
  };
  // ── The two breakout columns' data (2026-09-03) ───────────────────────────
  //
  // Deliberately AFTER the grid's own database reads and wrapped so it cannot throw:
  // this is the only upstream call on the page, and a Total ETO outage must cost two
  // columns rather than the month-end page. `readPartsEtcBreakout` already returns
  // nulls on failure; the catch is for the unexpected.
  //
  // Skipped outright on a month without the columns: this is the page's only upstream
  // call, and there is no reason to spend ~3s of Total ETO on a figure that has
  // nowhere to render.
  const partsBreakout = showBreakout
    ? await readPartsEtcBreakout(
        jobs.filter((j) => j.jobId).map((j) => ({ pk: j.id, jobNumber: j.jobId })),
        // The month being closed IS the cutoff. Without it this read was "as of right
        // now" on a month-end page — see lib/left-to-invoice.ts.
        month,
      ).catch((e) => {
        console.error("[etc] parts breakout failed; Left to Invoice/Purchase will read —:", e);
        return null;
      })
    : null;

  const partsCostGrandTotal = { prior: 0, worked: 0, newEtc: 0, leftToInvoice: 0, leftToPurchase: 0 };

  return (
    // EtcGridView wraps the toolbar AND the grid, because the menu and the cells are
    // two halves of one piece of state: the checkbox reads it, the stylesheet it
    // renders acts on it. Everything inside is unchanged by a tick except the one
    // <style> node and the ~20 banded header cells. See lib/grid-view.ts.
    <EtcGridView initialHidden={initialHiddenView}>
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">Monthly ETC</PageTitle>
      <p className="mb-4 text-sm text-sdc-gray-600">
        {`${visibleJobs.length}${billableFilterActive ? ` of ${jobs.length}` : ""} ${monthIsLocked ? "job" : "active job"}${visibleJobs.length === 1 ? "" : "s"} — replaces the "Managers Fill Out" sheet.`}
      </p>

      {/* ── Two rows, not three (2026-08-05, by request) ──────────────────────
          This was ONE wrapping row holding the controls, the two status chips and the
          sync metadata, plus the department checklist on a row of its own below it. At
          the width the sidebar leaves, that is three lines of header above a grid people
          come here to scroll.
          Split by what a thing IS rather than by where it fit: everything you can PRESS
          is on this row, everything the page is TELLING you is on the next one. The
          checklist joins this row because ticking a box is an action.
          `Report for:` went with the split — the select beside it reads "July — in
          progress", which says what the label said, in the control itself. */}
      <div className="mb-1.5 flex flex-wrap items-center gap-3">
        <MonthYearSelect
          months={distinctMonths.map((m) => m.month)}
          current={month}
          lockedMonths={lockedMonthList}
          nextStartable={nextStartable}
        />
        <EtcViewMenu selectedBillables={selectedBillables} />
        {/* Refresh Data is NOT here any more (§41.16, 2026-08-05). §29 had put it in this
            toolbar because the sidebar collapses to a rail and "a control nobody can find
            is not a control"; §41.16 asks for one application-wide control in the sidebar
            instead, and the rail keeps it visible as an icon rather than hiding it. There
            was always exactly one refresh PATH — this only ever decided how many buttons
            pointed at it. See Sidebar. */}
        {/* Downloads the month exactly as filtered, every department column included —
            the ones the on-screen table only reaches by scrolling. Flushes any pending
            autosave first, because the export reads the database (§24.8). */}
        <ExportMenu
          report="etc"
          fixedParams={{ month }}
          flushBeforeExport
          className={`${BUTTON_SECONDARY} ${TOOLBAR_MIN_W} justify-center`}
        />
        {/* No Save button (2026-08-04, §17). Every edit autosaves ~0.8s after the last
            keystroke — clearing a cell included — and the status chip below says where the
            save is up to. A manual Save was the last thing on this page that let a manager
            believe their work needed a click to survive. */}
        {/* Autosaves New ETC cells ~1.5s after typing stops. Unconditional on an
            unlocked month as of 2026-08-04: it used to require the Save gate, which
            meant no safety net at all on a fresh browser session. A submitted month
            is still untouchable. */}
        <EtcAutosave formId="etc-month-form" month={month} locked={cellsReadOnly} />
        {/* Keeps the row TOTAL (NEW ETC) block and the grand-total row in step
            with the section cells as they are typed. Both are summed on the
            server, so nothing else moves them until a save. Renders nothing. */}
        <EtcLiveTotals />
        {/* ONE right-click menu for the whole grid — see JobCellMenuHost. */}
        <JobCellMenuHost />
        {/* "Lock Editing" removed 2026-08-04: it relocked the Save gate, and with that
            gate gone it would have been a button that does nothing. */}
        {/* The submission button is NOT here any more (§26.2, 2026-08-04). It moved to
            the bottom of the Standard Fees card, under the figures it finalises — beside
            the filters and Refresh Data it was one mis-click from the controls people
            press dozens of times an hour. There is exactly one submission button in the
            app, and it is in StandardPoolPanel via SubmitReportAction. */}
        {/* Password-gated rather than admin-only (changed 2026-08-02): the
            person who needs to correct a closed month is the manager who
            filled it in, and requiring an ADMIN account for that just meant
            corrections didn't happen. Same confirmation phrase as Submit and
            Lock; the check itself is server-side in reopenMonth. */}
        {locked && <ReopenMonthButton action={reopenMonthlyReport.bind(null, month)} month={month} className={BUTTON_SECONDARY} />}
        {/* Sync History now lives inside the merged "Sync Data" menu above. */}
        {/* Standard Sheet columns — visible only to a role with standards:view
            (Sales/ELT), enforced by isStandardSheetUnlocked() now reading role
            instead of a shared password. Nothing renders here at all for
            anyone else — no password box, no entry point to find. */}
        {/* SuppressToasts: the "Standard Sheet" area's own controls (ETC Rates, the
            visibility toggle) have no toast() calls today, but are wrapped so a future
            one added here is silenced by default rather than leaking a global toast
            from an area the task names explicitly. */}
        {showStandards && (
          <SuppressToasts>
            {/* ── "Standards", not "Hide Standards" (2026-08-05) ─────────────
                The label names the thing; the ACTIVE colour says it is on, which is
                exactly how View reports being filtered two controls to the left, and
                how ProjectsShowActualsSwitch reports its state ("a switch already says
                which way it is set — so the label can just name the thing it
                controls"). This is a display collapse only, not a re-lock — see
                lockStandardSheet's own comment. */}
            <StandardsVisibilityToggle lockAction={lockStandardSheet} />
            <EtcRatesButton
              engrRate={standardRates.engrRate}
              shopRate={standardRates.shopRate}
              partsMarkup={standardRates.partsMarkup}
              contingencyRate={contingencyRate}
              disabled={standardSheetSubmitted}
            />
          </SuppressToasts>
        )}

        {/* ── The sign-off checklist, on the controls row (§50, moved here) ────
            It had a row to itself, which was the third line. It belongs here: five
            checkboxes are five controls, and they now sit at the same 2.4rem as the
            buttons beside them (BTN_MIN_H_STANDARD).
            Rendered even before the month is started, unlike the KPI strip: a department
            can legitimately sign off a month with nothing booked in it, and hiding the
            checklist until the first refresh would make an empty month unsubmittable
            with no visible reason. */}
        <DepartmentEtcChecklist
          month={month}
          monthTitle={monthHeading}
          initial={departmentCompletions}
          manageable={manageableDepts}
          locked={cellsReadOnly}
        />
      </div>

      {/* ── Row two: what the page is telling you ────────────────────────────
          State, not controls — the month's status, anything wrong with it, and how
          fresh the data is. None of it is pressable except the issues chip, which is a
          chip precisely because it reports something rather than doing something.
          Smaller gaps than the row above: these read as one sentence about the month,
          where the row above is a set of separate tools. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusBadge variant={!started ? "notStarted" : locked ? "locked" : "needsReview"}>
          {!started ? "Not started" : locked ? "Locked (submitted)" : `In progress — ${needsReviewCount} pending`}
        </StatusBadge>

        {/* Everything the four banners used to say, in one chip (§44). Renders nothing
            at all when there is nothing wrong — an "0 issues" control is permanent
            furniture that says the same thing every day, which is how people stop
            reading it. See EtcIssuesIndicator. */}
        <EtcIssuesIndicator issues={etcIssues} />
        <span className="text-xs text-sdc-gray-400">
          {lastPowerBiSync?.syncedAt
            ? `Last synced: ${lastPowerBiSync.syncedAt.toISOString().slice(0, 16).replace("T", " ")}`
            : "Never synced"}
          {/* ── The data VINTAGE, and why it can lead Power BI (§43) ──────────
              This date already existed, but as a bare figure it could not answer the
              question it kept provoking: "the app says 3,154 Engineering hours and the
              Power BI report says 3,020 — which is wrong?".
              Neither. Reconciled 2026-08-05, both differences account for exactly:
                +138.83h ENG / +22.77h SHOP — July punches Lisa's file has and the
                  semantic model has not ingested yet, so the APP is the fresher of the two;
                + 5.00h ENG /  +4.86h SHOP — Warranty (phase 70) and Service (phase 80),
                  which Power BI folds into Engineering/Shop and the ETC grid's fixed
                  9+4-code formula deliberately excludes (signed off 2026-07-31).
              So the vintage is named, and the source with it, because the whole point is
              that the two systems are at different ones. See docs/PAYLOCITY-INGESTION.md §43. */}
          {hoursActualFreshness?.refreshedThrough && (
            <>
              {" · "}
              <span
                title={
                  `Hours are complete through ${hoursActualFreshness.refreshedThrough.toISOString().slice(0, 10)} — the latest work date in the ` +
                  `Paylocity file. The Power BI report reads a semantic model that refreshes separately, so it can be a few days behind this ` +
                  `page. When the two disagree on a current month, that gap is usually the reason. Power BI also counts Warranty and Service ` +
                  `hours inside Engineering/Shop; this grid excludes them by design.`
                }
                className="underline decoration-dotted underline-offset-2"
              >
                Hours through {hoursActualFreshness.refreshedThrough.toISOString().slice(0, 10)}
              </span>
            </>
          )}
          {/* Same figure as the report's Working Days card — weekday count
              for the selected work month. */}
          <> · {`Working Days: ${workingDaysInMonth(month)}`}</>
          {distinctMonths.length === 0 && <> · no ETC history yet</>}
        </span>
      </div>

      {/* ── The four banners and the instruction paragraph are gone (§44) ──────
          They stacked above the table and, on a month with a failed sync and bad job
          numbers, pushed the first row of the grid most of the way down a laptop
          screen. Two of them restated KPI blocks that were already on this page WITH
          drill-throughs — the comment on EtcMonthKpiCards below still records that they
          were built from the same rows precisely so the two could not disagree.

          Nothing was dropped. Every issue is now an entry in `etcIssues`, rendered as
          one compact chip in the header row above ("2 data issues"), and the two that
          have a drill-through OPEN it rather than describing it in prose. The queries,
          the validation and the submission gate are untouched — this changed how the
          findings are PRESENTED, not what is checked.

          The instruction paragraph went with them. It explained Refresh Data, yellow
          cells and submission on every single visit, forever, to people who had read it
          the first time; the StatusBadge already names the state and each control
          already carries its own tooltip. */}

      {/* KPI strip. Computed from the same rows the grid's grand-total row sums
          (see getEtcMonthKpis), so the cards and the bottom of the table can't
          disagree. "Detail" opens the punch-level drill: who booked what, on
          which date, against which job. */}
      {started && (
        <EtcMonthKpiCards
          month={month}
          kpis={monthKpis}
          detailJobIds={detailJobIds}
          // Same rows the amber banner below is built from, so the card and the
          // banner state one number rather than two that could drift.
          importIssues={undefinedHoursTotals.issues.map((i) => ({ label: i.label, rows: i.rows, hours: i.hours }))}
          // Same rows the red banner below is built from — one query, one number.
          offGridJobs={hiddenJobHours}
        />
      )}

      {started && (
        /* key={month}: the month picker soft-navigates (router.push), which
           reconciles this subtree in place — rows are keyed by job/section, so
           without a remount every client cell (EtcSectionCells, the Standard
           rate inputs) keeps the PREVIOUS month's typed state and renders it
           under the new month's numbers. Remounting per month guarantees each
           month's grid seeds fresh from its own server data. */
        <StandardRatesProvider
          key={month}
          jobs={[...standardByJob.values()]}
          rates={standardRates}
          poolRows={poolRowsForProvider}
          contingencyRate={contingencyRate}
          frozenRows={frozenStandardRows}
          editable={showStandards && !standardSheetSubmitted}
        >
        <div className="flex items-start gap-3">
          {/* The ETC month form wraps ONLY the grid — the pool panel has its own
              Save/Refresh/Submit forms and must not be nested inside it. The
              provider wraps both so the panel's live pulled/rate edits flow into
              the grid's job Standard Fees. */}
          {/* Not a submitting form any more (§15): it exists so the autosave can read
              its fields by name (changedEtcFormData) and so the browser groups the
              inputs. The month is finalised by SubmitMonthReportButton, which reads the
              database rather than this DOM. */}
          <form key={month} id="etc-month-form" className="min-w-0 flex-1">
          {/* 215px -> 183px (§44). This is a FIXED subtraction, so removing the
              instruction paragraph above would otherwise have moved the grid up and left
              32px of dead space at the bottom rather than giving the table the room —
              the height would not have changed, only its position. The paragraph was
              unconditional (`text-xs` + `mb-4`, one line at its shortest), so that is
              the constant recovered. The four banners were conditional and never part of
              this figure. */}
          <DragScroll scrollKey="etc-grid" className={`max-h-[calc(var(--app-vh)_-_183px)] ${GRID_SCROLLER}`}>
            <table data-grid="etc" className={`w-full text-sm ${TABLE_GRID} ${CELL_PADDING}`}>
              <thead className="sticky top-0 z-20 bg-sdc-gray-100">
                <tr className={TABLE_HEADER_ROW}>
                  <th rowSpan={5} className="sticky left-0 z-10 w-10 min-w-10 bg-sdc-gray-100 px-2 py-3 text-center align-bottom">
                    #
                  </th>
                  {/* When Job Name is hidden, the heavy grey divider before
                      the section blocks moves onto Job Id instead. */}
                  {/* text-left overrides TABLE_HEADER_ROW's text-center on the
                      <tr>, so these two headers line up with their now
                      left-aligned values. */}
                  {/* data-etc-jobid: when Job Name is hidden the heavy grey divider
                      moves onto this cell, as a CSS rule rather than a className that
                      would need all 49 rows re-rendered. See etcViewExtraRules. */}
                  <th data-etc-jobid rowSpan={5} className="sticky left-10 z-10 w-20 min-w-20 bg-sdc-gray-100 px-3 py-3 text-left align-bottom">
                    Job Id
                  </th>
                  <th
                    data-col="jobname"
                    rowSpan={5}
                    style={{ width: "var(--etc-job-col-width, 260px)", minWidth: "var(--etc-job-col-width, 260px)" }}
                    className="sticky left-[7.5rem] z-10 border-r-8 border-[#808080] bg-sdc-gray-100 px-3 py-3 text-left align-bottom"
                  >
                    Job Name
                    <div
                      className="col-resize-handle absolute right-0 inset-y-0 z-10 w-3"
                      data-resize-var="--etc-job-col-width"
                      data-resize-min="150"
                      data-resize-max="600"
                      title="Drag to resize"
                      style={{ touchAction: "none" }}
                    />
                  </th>
                  {headerRuns(visibleCols, (c) => c.phaseLabel, (c) => c.phaseLabel).map((p, i) => (
                    <th
                      key={p.key + i}
                      {...bandProps(p.codes, SUB_COLUMNS.length)}
                      className={`${i === 0 ? "border-l border-sdc-border" : PHASE_EDGE} px-3 py-1.5 text-center`}
                    >
                      {p.label}
                    </th>
                  ))}
                  {/* The Total (New ETC) band spans one block per billing group, so its
                      leaf keys are the GROUP names rather than section codes — the same
                      keys the group filter hides. */}
                  <th
                    {...bandProps(visibleGroups, TOTAL_SUB_COLUMNS.length)}
                    className={`${PHASE_EDGE} bg-sdc-yellow-bg px-3 py-1.5 text-center text-sdc-navy`}
                  >
                    Total (New ETC)
                  </th>
                  <th colSpan={partsCostCols.length} className={`${PHASE_EDGE} bg-sdc-gray-100 px-3 py-1.5 text-center text-sdc-gray-700`}>
                    Parts Cost
                  </th>
                  {showStandards && (
                    <StandardHeaderVisible>
                      <th
                        rowSpan={4}
                        colSpan={STANDARD_LEAF_COLUMNS.length}
                        className={`${STD_EDGE} bg-sdc-blue-light px-3 py-1.5 text-center align-middle text-sdc-blue-dark`}
                      >
                        Standard Sheet
                      </th>
                    </StandardHeaderVisible>
                  )}
                </tr>
                {/* Billing-group row: Engineering / Shop per phase, like the sheet. */}
                <tr className={TABLE_HEADER_ROW}>
                  {(() => {
                    let colIdx = 0;
                    return headerRuns(visibleCols, (c) => `${c.phaseLabel}|${c.groupLabel}`, (c) => c.groupLabel).map((g, i) => {
                      const startCode = visibleCols[colIdx].code;
                      colIdx += g.count;
                      return (
                        <th
                          key={g.key + i}
                          {...bandProps(g.codes, SUB_COLUMNS.length)}
                          className={`${edgeFor(startCode, i)} px-2 py-1 text-center font-medium`}
                        >
                          {abbreviateLabel(g.label)}
                        </th>
                      );
                    });
                  })()}
                  {visibleGroups.map((group, i) => (
                    <th key={group} data-col={group} colSpan={TOTAL_SUB_COLUMNS.length} className={`${i === 0 ? PHASE_EDGE : "border-l border-sdc-border"} bg-sdc-yellow-bg px-2 py-1 text-center font-medium text-sdc-navy`}>
                      {abbreviateLabel(group)}
                    </th>
                  ))}
                  {/* Parts Cost has no Engineering/Shop split — one green Total
                      block spanning down to the column-label row, as printed. */}
                  <th rowSpan={3} colSpan={partsCostCols.length} className={`${PHASE_EDGE} bg-sdc-green px-2 py-1 text-center text-white`}>
                    Total
                  </th>
                </tr>
                {/* Sub-group row: ME / CE / General Engineering / dept abbreviations. */}
                <tr className={TABLE_HEADER_ROW}>
                  {(() => {
                    let colIdx = 0;
                    return headerRuns(
                      visibleCols,
                      (c) => `${c.phaseLabel}|${c.groupLabel}|${c.subgroupLabel}`,
                      (c) => c.subgroupLabel,
                    ).map((g, i) => {
                      const startCode = visibleCols[colIdx].code;
                      colIdx += g.count;
                      return (
                        <th
                          key={g.key + i}
                          title={SUBGROUP_FULL_NAME[g.label]}
                          {...bandProps(g.codes, SUB_COLUMNS.length)}
                          className={`${edgeFor(startCode, i)} px-2 py-1 text-center font-medium`}
                        >
                          {abbreviateLabel(g.label)}
                        </th>
                      );
                    });
                  })()}
                  {visibleGroups.map((group, i) => {
                    // "ME & CE & GE" -> "ME & CE" (2026-08-20, same fix as SUBGROUP_DISPLAY
                    // above): General Engineering's codes never merge into this column.
                    const label = group === "Engineering" ? "ME & CE" : "MB & EB";
                    return (
                      <th
                        key={group}
                        data-col={group}
                        title={SUBGROUP_FULL_NAME[label]}
                        colSpan={TOTAL_SUB_COLUMNS.length}
                        className={`${i === 0 ? PHASE_EDGE : "border-l border-sdc-border"} bg-sdc-yellow-bg px-2 py-1 text-center font-medium text-sdc-navy`}
                      >
                        {label}
                      </th>
                    );
                  })}
                </tr>
                {/* Colored section row, labels exactly as the sheet prints them. */}
                <tr className={TABLE_HEADER_ROW}>
                  {visibleCols.map((s, i) => {
                    const color = SECTION_HEADER_COLOR[s.code];
                    return (
                      <th
                        key={s.code}
                        data-col={`${s.code} ${s.billingGroup}`}
                        title={`${s.name} (${s.code})`}
                        colSpan={SUB_COLUMNS.length}
                        className={`${edgeFor(s.code, i)} break-normal px-2 py-1 text-center ${color ?? ""}`}
                      >
                        {s.sectionDisplay}
                      </th>
                    );
                  })}
                  {visibleGroups.map((group, i) => (
                    <th
                      key={group}
                      data-col={group}
                      colSpan={TOTAL_SUB_COLUMNS.length}
                      className={`${i === 0 ? PHASE_EDGE : "border-l border-sdc-border"} px-2 py-1 text-center text-sdc-navy ${group === "Engineering" ? "bg-sdc-blue-100" : "bg-sdc-yellow-bg"}`}
                    >
                      All
                    </th>
                  ))}
                </tr>
                <tr className={TABLE_HEADER_ROW}>
                  {visibleCols.map((s, i) =>
                    SUB_COLUMNS.map((col, ci) => (
                      <th
                        key={`${s.code}-${col}`}
                        data-col={`${s.code} ${s.billingGroup}`}
                        className={`${ci === 0 ? edgeFor(s.code, i) : "border-l border-sdc-border"} ${ETC_COL_W} break-normal px-1 py-1.5 text-center text-label ${
                          subColHeaderBg(col) || SECTION_HEADER_COLOR_LIGHT[s.code] || ""
                        }`}
                      >
                        {colHeaderLabel(col)}
                      </th>
                    ))
                  )}
                  {visibleGroups.map((group, gi) =>
                    TOTAL_SUB_COLUMNS.map((col, ci) => (
                      <th
                        key={`${group}-${col}`}
                        data-col={group}
                        className={`${ci === 0 && gi === 0 ? PHASE_EDGE : "border-l border-sdc-border"} ${ETC_COL_W} break-normal px-1 py-1.5 text-center text-label ${
                          subColHeaderBg(col) || "bg-sdc-yellow-bg text-sdc-navy"
                        }`}
                      >
                        {col}
                      </th>
                    ))
                  )}
                  {partsCostCols.map((col, i) => (
                    <th
                      key={`parts-cost-${col}`}
                      className={`${i === 0 ? PHASE_EDGE : "border-l border-sdc-border"} px-1 py-1.5 text-center text-label ${
                        subColHeaderBg(col) || "bg-sdc-gray-100 text-sdc-gray-700"
                      }`}
                    >
                      {/* New ETC is CALCULATED in this section whenever the breakout
                          columns are present, so it must not wear the "editable"
                          pencil there — the two cells it is calculated from do. The
                          hours sections' own New ETC header is untouched. */}
                      {showBreakout && col === "New ETC" ? col : colHeaderLabel(col)}
                    </th>
                  ))}
                  {showStandards && (
                    <StandardHeaderVisible>
                      {STANDARD_LEAF_COLUMNS.map((col) => (
                        <th
                          key={`std-${col}`}
                          // Heavy divider before each Standard block; "% Total"
                          // stays thin as it shares the Total ETC block.
                          className={`${col === "% Total" ? "border-l border-sdc-border" : STD_EDGE} bg-sdc-blue-light/60 px-1 py-1.5 text-center text-label text-sdc-blue-dark`}
                        >
                          {col}
                        </th>
                      ))}
                    </StandardHeaderVisible>
                  )}
                </tr>
              </thead>
              <tbody>
                {visibleJobs.map((job, jobIndex) => {
                  const entryByCode = new Map(job.etcEntries.map((e) => [e.section, e]));
                  // ── The two row-category highlights ───────────────────────
                  //
                  // Both mark a property of the JOB, so as of 2026-08-03 they colour ONLY
                  // the three frozen identity columns (#, Job ID, Job Name) — see
                  // zebraSticky below. They were swapped that same day, by request:
                  // started-this-month is the yellow, active T&M the lavender.
                  //
                  // Jobs that STARTED this month are the rows whose Prior ETC came from
                  // the quote rather than from a carried balance (see the startsThisMonth
                  // rule in seedMonth), so "no history, opening at quote" is worth being
                  // able to see rather than infer from a Start Date column that isn't on
                  // this grid.
                  //
                  // It wears the deeper #fbe79c yellow rather than anything nearer the
                  // New ETC cell's #FAFAC4: that one means "this cell needs a decision",
                  // and two near-identical shades meaning different things is how a
                  // legend stops being read at all. Confining the category tints to the
                  // identity columns removes the collision entirely — inside the grid,
                  // yellow now only ever means "decide this".
                  const startsThisMonth =
                    job.startDate != null &&
                    `${job.startDate.getUTCFullYear()}-${String(job.startDate.getUTCMonth() + 1).padStart(2, "0")}` === month;
                  // Active T&M, lavender, sorted to the bottom of the grid (see the
                  // sort above). Still WINS over the started-this-month tint: T&M is
                  // what the row IS, where "started this month" is only where it is
                  // in its life, and a row can be both.
                  //
                  // Lavender reads cleanly here because every other colour on this
                  // grid already means something — blue is Prior ETC, yellow is
                  // "needs a decision", red/green are over/under — so it can't be
                  // misread as a status.
                  const tmRow = isActiveTm(job);
                  // The <tr> carries ONLY the plain alternating stripe. The category
                  // colours were removed from it on 2026-08-03, by request: they now
                  // mark just the three frozen identity columns (#, Job ID, Job Name)
                  // rather than washing across the whole row.
                  //
                  // Restricting it is the right call — those tints say something about
                  // the JOB, not about any individual figure, and every data column
                  // already uses colour for its own meaning (blue Prior ETC, yellow
                  // "needs a decision", the red/green Diff gradient). A row-wide wash
                  // sat underneath all of that and showed through wherever a cell had no
                  // fill of its own, so the same yellow meant "started this month" in one
                  // column and "decide this" in the next.
                  const zebra = jobIndex % 2 === 1 ? "bg-sdc-gray-50/60" : "";
                  // The frozen columns, where the category colour now lives exclusively.
                  // They need a fully OPAQUE background regardless: they sit above the
                  // scrolling body, and a translucent fill lets the columns passing
                  // underneath bleed through them.
                  const zebraSticky = tmRow
                    ? "bg-[#e5d9f7]"
                    : startsThisMonth
                      ? "bg-[#fbe79c]"
                      : jobIndex % 2 === 1
                        ? "bg-sdc-gray-50"
                        : "bg-white";

                  // "Total (New ETC)" — a pure rollup, confirmed from the real sheet's
                  // formulas (SUM of the Engineering blocks' Prior/Worked/New ETC,
                  // separately for Shop) — not a manager-entered value.
                  //
                  // ── All-or-nothing since §51 ──────────────────────────────
                  //
                  // Prior and Worked are synced facts and always print. Total New ETC
                  // and Diff print ONLY when every section in the group that needs an
                  // answer has one — see rollupNewEtc in lib/etc.ts for what "needs an
                  // answer" means and why a partial figure was unreadable.
                  //
                  // `decided` is judged from the text the CELL WOULD SHOW, not from the
                  // stored draft: newEtcSeedText is what EtcSectionCells seeds its input
                  // with, so the server's answer here and the browser's answer a frame
                  // later are the same function of the same state. Anything else and the
                  // block would flicker between two figures on every page load.
                  const totals = {
                    Engineering: { prior: 0, worked: 0 },
                    Shop: { prior: 0, worked: 0 },
                  };
                  const rollupCells: Record<"Engineering" | "Shop", NewEtcRollupCell[]> = {
                    Engineering: [],
                    Shop: [],
                  };
                  // The sections still waiting, by name, for the blank cell's tooltip.
                  // A blank with no explanation reads as missing data; "waiting on
                  // Software and Robot" reads as a list of things to go and do.
                  const pending: Record<"Engineering" | "Shop", string[]> = { Engineering: [], Shop: [] };
                  for (const s of ETC_SECTIONS) {
                    const entry = entryByCode.get(s.code);
                    // No row means the job was never quoted for this section: Prior 0,
                    // Worked 0, nothing to decide. The client renders an editable cell
                    // for it that publishes as decided, so both sides agree it does not
                    // block.
                    if (!entry) continue;
                    const prior = Number(entry.priorEtc);
                    const worked = Number(entry.hoursWorked);
                    const t = totals[s.billingGroup];
                    t.prior += prior;
                    t.worked += worked;
                    const state = {
                      priorEtc: prior,
                      hoursWorked: worked,
                      draft: entry.newEtcDraft != null ? Number(entry.newEtcDraft) : null,
                      confirmed: entry.submittedAt != null ? round2(Number(entry.newEtc)) : null,
                      cleared: entry.newEtcClearedAt != null,
                      locked: cellsReadOnly,
                      monthComplete,
                      precision: "whole",
                    } satisfies NewEtcCellState;
                    const decided = isNewEtcCellDecided(state, newEtcSeedText(state));
                    if (!decided) pending[s.billingGroup].push(s.name);
                    rollupCells[s.billingGroup].push({
                      decided,
                      hoursLeft: calcHoursLeft(prior, worked),
                      newEtc: effectiveNewEtc(entry),
                    });
                  }
                  const rollup = {
                    Engineering: rollupNewEtc(rollupCells.Engineering),
                    Shop: rollupNewEtc(rollupCells.Shop),
                  };

                  // No row-level hover:bg on the <tr> below — the hover wash is
                  // the `tbody tr:hover > td` rule in globals.css, which paints
                  // an inset shadow OVER each cell's own fill. A background on
                  // the <tr> paints BEHIND the cells, so it only ever showed on
                  // the handful of plain-white ones, tinting those twice while
                  // the coloured cells (Prior ETC, Diff, New ETC) got nothing.
                  return (
                    <tr key={job.id} className={zebra}>
                      <td className={`sticky left-0 z-10 w-10 min-w-10 overflow-hidden px-2 py-1 text-center align-middle text-label leading-none whitespace-nowrap text-sdc-gray-400 ${zebraSticky}`}>{jobIndex + 1}</td>
                      {/* Job Id and Job Name both carry the right-click menu
                          (Job Hour Details / Project Schedule) — the same one the
                          Projects grid uses. It replaced the inline Scheduler
                          gantt icon that used to sit beside the job name. */}
                      {/* Plain <td>; the menu is one delegated listener. */}
                      <td
                        {...jobCellMenuProps({
                          jobId: job.jobId,
                          jobName: job.jobName,
                          schedulerUrl: schedulerJobNumbers.has(job.jobId) ? schedulerScheduleUrl(schedulerBaseUrl, job.jobId, schedulerSsoEmail) : null,
                        })}
                        title={`${job.jobId} — right-click for options`}
                        data-etc-jobid
                        className={`sticky left-10 z-10 w-20 min-w-20 overflow-hidden px-3 py-1 text-left align-middle font-mono text-label leading-none whitespace-nowrap text-sdc-gray-400 ${zebraSticky}`}
                      >
                        {job.jobId}
                      </td>
                      <td
                        {...jobCellMenuProps({
                          jobId: job.jobId,
                          jobName: job.jobName,
                          schedulerUrl: schedulerJobNumbers.has(job.jobId) ? schedulerScheduleUrl(schedulerBaseUrl, job.jobId, schedulerSsoEmail) : null,
                        })}
                        data-col="jobname"
                        title={`${job.jobName} — right-click for options`}
                        style={{ width: "var(--etc-job-col-width, 260px)", minWidth: "var(--etc-job-col-width, 260px)" }}
                        className={`sticky left-[7.5rem] z-10 overflow-hidden border-r-8 border-[#808080] px-3 py-1 text-left align-middle text-label font-medium leading-none whitespace-nowrap text-sdc-navy ${zebraSticky}`}
                      >
                        {/* min-h keeps row heights identical to the Projects
                            grid now that no icon pads this cell (c51cd42).
                            justify-start so the truncated name starts at the
                            cell's left edge, matching text-left above. */}
                        <div className="flex min-h-[14px] min-w-0 items-center justify-start gap-1.5">
                          <span className="min-w-0 truncate">{job.jobName}</span>
                        </div>
                      </td>
                      {visibleCols.map((s, sIdx) => {
                        const edge = edgeFor(s.code, sIdx);
                        const entry = entryByCode.get(s.code);
                        // No EtcEntry for this job/section — the job was never
                        // quoted for it, so startMonth seeded no row.
                        //
                        // These printed a dead "—" across all five columns until
                        // 2026-08-03; 357 of July's 754 cells were like that, so
                        // roughly half the grid could not be planned at all. They
                        // are now the SAME editable cell as any other, at Prior 0 /
                        // Worked 0 — which is what they are — and the row is
                        // created on save if a value is typed. See EtcSectionCells.
                        if (!entry) {
                          return (
                            <Fragment key={s.code}>
                              <EtcSectionCells
                                entryId={null}
                                month={month}
                                jobId={job.id}
                                sectionCode={s.code}
                                billingGroup={s.billingGroup}
                                edge={edge}
                                jobName={job.jobName}
                                sectionName={s.name}
                                priorEtc={0}
                                initialWorked={0}
                                initialDraft={null}
                                initialConfirmed={null}
                                locked={cellsReadOnly}
                                monthComplete={monthComplete}
                              />
                            </Fragment>
                          );
                        }
                        const prior = Number(entry.priorEtc);
                        const worked = Number(entry.hoursWorked);
                        const draft = entry.newEtcDraft != null ? Number(entry.newEtcDraft) : null;
                        const effective = effectiveNewEtc(entry);

                        const sectionTotal = sectionGrandTotals.get(s.code)!;
                        sectionTotal.prior += prior;
                        sectionTotal.worked += worked;
                        sectionTotal.newEtc += effective;
                        sectionTotal.diff += newEtcDiff(entry);

                        return (
                          <Fragment key={s.code}>
                            <EtcSectionCells
                              entryId={entry.id}
                              month={month}
                              // Lets the cell publish its live figures to the
                              // totals that sum it (lib/etc-live-totals.ts).
                              jobId={job.id}
                              sectionCode={s.code}
                              billingGroup={s.billingGroup}
                              edge={edge}
                              jobName={job.jobName}
                              sectionName={s.name}
                              priorEtc={prior}
                              initialWorked={round2(worked)}
                              initialDraft={draft}
                              initialConfirmed={isHistoricalMonth || entry.submittedAt != null ? round2(Number(entry.newEtc)) : null}
                              // This cell was emptied on purpose — without this it
                              // would seed straight back from the confirmed value
                              // above. See newEtcSeedText / DEVLOG §16.
                              cleared={entry.newEtcClearedAt != null}
                              locked={cellsReadOnly}
                              monthComplete={monthComplete}
                            />
                          </Fragment>
                        );
                      })}
                      {visibleGroups.map((group, gi) => {
                        // Printed from the printed inputs, for the same reason as
                        // the section cells (see EtcSectionCells): Prior is whole
                        // and Worked is not, so rounding the subtraction
                        // independently makes the visible arithmetic fail. The
                        // exact value still drives the tooltip.
                        const hoursLeftExact = totals[group].prior - totals[group].worked;
                        const hoursLeft = Math.round(totals[group].prior) - Math.round(totals[group].worked);
                        // Hours Left − Total New ETC, plainly, now that the block only
                        // prints when every cell contributes to both (§51). null while
                        // the group is incomplete — see rollupNewEtc.
                        const diff = rollup[group].diff;
                        const groupNewEtc = rollup[group].newEtc;
                        groupGrandTotals[group].prior += totals[group].prior;
                        groupGrandTotals[group].worked += totals[group].worked;
                        // §51: the bottom totals sum only the rows that HAVE a figure.
                        // An incomplete row contributes nothing — not zero, not its
                        // Hours Left, not a fallback of any kind (§51 #7, #8).
                        if (groupNewEtc != null) groupGrandTotals[group].newEtc += groupNewEtc;
                        if (diff != null) groupGrandTotals[group].diff += diff;
                        return (
                          <Fragment key={group}>
                            <td data-col={group} className={`${gi === 0 ? PHASE_EDGE : "border-l border-sdc-border"} ${ETC_COL_W} overflow-hidden bg-[#5E91D3] px-1 py-1 text-center align-middle text-label whitespace-nowrap text-sdc-gray-700`} title={String(round2(totals[group].prior))}>
                              {wholeNum(totals[group].prior)}
                            </td>
                            <td data-col={group} className={`border-l border-sdc-border ${ETC_COL_W} ${HOURS_WORKED_BG} overflow-hidden px-1 py-1 text-center align-middle text-label whitespace-nowrap text-sdc-muted`} title={String(round2(totals[group].worked))}>
                              {wholeNum(totals[group].worked)}
                            </td>
                            <td
                              data-col={group}
                              className={`border-l border-sdc-border ${ETC_COL_W} ${HOURS_LEFT_BG} overflow-hidden px-1 py-1 text-center align-middle text-label whitespace-nowrap text-sdc-muted`}
                              title={`${round2(hoursLeftExact)} = Prior ETC (${round2(totals[group].prior)}) − Hours Worked (${round2(totals[group].worked)})`}
                            >
                              {wholeNum(hoursLeft)}
                            </td>
                            {/* These two are the only cells in the block that move
                                as a manager types: Prior ETC and Hours Worked
                                aren't editable, and Hours Left derives from them.
                                EtcLiveTotals repaints them through these hooks —
                                see lib/etc-live-totals.ts for why they can't just
                                wait for a save. */}
                            {/* Blank until the whole group is answered (§51). The
                                tooltip is what stops a blank cell reading as broken
                                data — it names how many sections are still waiting. */}
                            <td
                              data-live="newEtc"
                              data-group={group}
                              data-col={group}
                              data-job={job.id}
                              className={`border-l border-sdc-border ${ETC_COL_W} ${newEtcBg(true)} overflow-hidden px-1 py-1 text-center align-middle text-label font-bold whitespace-nowrap text-sdc-navy`}
                              title={
                                groupNewEtc != null
                                  ? String(round2(groupNewEtc))
                                  : rollupPendingTitle(pending[group])
                              }
                            >
                              {groupNewEtc != null ? wholeNum(groupNewEtc) : ""}
                            </td>
                            <td
                              data-live="diff"
                              data-group={group}
                              data-col={group}
                              data-job={job.id}
                              className={`border-l border-sdc-border ${ETC_COL_W} overflow-hidden px-1 py-1 text-center align-middle text-label whitespace-nowrap text-sdc-gray-700`}
                              // A rollup of one billing group for one job, so it
                              // scales against the hours-TOTAL ceiling rather than a
                              // single cell's. No tint at all while it is blank —
                              // colouring an absent figure would imply one.
                              style={diff != null ? diffCellStyle(diff, DIFF_CEILING.hoursTotal) : undefined}
                              title={
                                diff != null
                                  ? `${round2(diff)} = Hours Left (${round2(hoursLeftExact)}) − Total New ETC (${round2(groupNewEtc ?? 0)})`
                                  : rollupPendingTitle(pending[group])
                              }
                            >
                              {diff != null ? wholeNum(diff) : ""}
                            </td>
                          </Fragment>
                        );
                      })}
                      {(() => {
                        const partsCostEntry = entryByCode.get(PARTS_COST_SECTION);
                        if (!partsCostEntry) {
                          return partsCostCols.map((col, ci) => (
                            <td
                              key={`parts-cost-${col}`}
                              className={`${ci === 0 ? PHASE_EDGE : "border-l border-sdc-border"} overflow-hidden px-2 py-1 text-center align-middle whitespace-nowrap text-sdc-gray-400 ${
                                col === "Prior ETC" ? "bg-[#5E91D3] text-sdc-gray-700" : subColBodyBg(col) || "bg-sdc-gray-50"
                              }`}
                            >
                              —
                            </td>
                          ));
                        }
                        const prior = Number(partsCostEntry.priorEtc);
                        const spent = Number(partsCostEntry.hoursWorked);
                        const moneyLeft = calcHoursLeft(prior, spent);
                        const suggestedCost = suggestNewEtc(prior, spent);
                        const draftCost = partsCostEntry.newEtcDraft != null ? Number(partsCostEntry.newEtcDraft) : null;
                        // ── What the two editable breakout cells start with ─────────
                        //
                        // What is STORED, or nothing. Neither column is populated with a
                        // figure nobody typed — Left to Purchase by explicit request, and
                        // Left to Invoice for a reason worth writing down, because it did
                        // start out seeded from Total ETO.
                        //
                        // A seed cannot survive New ETC becoming their sum. The seed is a
                        // LIVE figure and it is not stored, so the box showed $59,205
                        // while the database held null — and a save carrying only the
                        // other half derived New ETC from 0 + that half, storing $2,500
                        // under a cell reading $61,705. Making the save store the seed
                        // too would mean freezing a live upstream number as though a
                        // manager had entered it, and marking the cell dirty on arrival
                        // would put the "unsaved changes" warning on a month nobody had
                        // touched — the exact failure lib/etc-dirty-tracker.ts exists to
                        // prevent.
                        //
                        // So the upstream figure moves to the TOOLTIP, which is what this
                        // grid already does with New ETC's own suggestion, and for the
                        // same stated reason: a cell nobody has answered has to read as
                        // unanswered, and a suggestion in the box is indistinguishable
                        // from a decision.
                        //
                        // round2 because this column is money and keeps two decimals: the
                        // Total ETO sum arrives as a raw float (59205.01999499999 on the
                        // first August job) under a cell that displays "$59,205".
                        const suggestion = partsBreakout?.byJobPk.get(job.id) ?? null;
                        // ── The one way this figure is not the whole story ───────────
                        //
                        // The FLOOR caveat is gone with the change below: the cell now
                        // shows the signed figure, so an over-invoiced job reads negative
                        // here exactly as it does in the Parts List, and there is nothing
                        // left to explain away.
                        //
                        // DRIFT is real and stays: a GL posting dated after the cutoff
                        // still reduces this month, because the Parts List’s rule pairs a
                        // purchase-date cutoff with lifetime invoicing. 31 of 49 jobs in
                        // August 2026. It does NOT make the two surfaces disagree — they
                        // drift together — but a month whose number keeps moving should
                        // say so.
                        const suggestionLatePostings = round2(suggestion?.postedAfterCutoff ?? 0);
                        // ── Left to Invoice is COMPUTED, not entered (2026-09-04) ───
                        //
                        // "Monthly ETC Left to Invoice = Parts List Left to Invoice …
                        // exact reconciliation every time." So the cell renders the
                        // upstream figure at this month's cutoff rather than anything a
                        // manager typed, and lib/left-to-invoice.ts decides which figure
                        // that is — computed on an open row, frozen on a submitted one.
                        //
                        // `rawLeftToInvoice`, deliberately, not the floored figure: the
                        // Parts List's column is a signed sum, and flooring at zero was
                        // the one place the two legitimately disagreed. "Exact" leaves
                        // no room for it, so an over-invoiced job reads negative here too.
                        // Still manager-entered, and always was the half nobody can
                        // compute: a BOM part with no purchase line does not appear in
                        // the parts rows at all.
                        const leftToPurchaseValue =
                          partsCostEntry.leftToPurchase != null ? round2(Number(partsCostEntry.leftToPurchase)) : null;
                        const resolvedInvoice = resolveLeftToInvoice({
                          computed: suggestion?.rawLeftToInvoice == null ? null : round2(suggestion.rawLeftToInvoice),
                          stored:
                            partsCostEntry.leftToInvoice != null ? round2(Number(partsCostEntry.leftToInvoice)) : null,
                        });
                        const leftToInvoiceValue = resolvedInvoice.value;
                        // A New ETC typed before these columns existed. No longer shown
                        // as Left to Invoice — that cell is computed now — but not thrown
                        // away either: it moves to New ETC’s tooltip, so a manager can see
                        // the figure their row used to carry and re-enter the part of it
                        // that was still to buy.
                        const supersededNewEtc =
                          partsCostEntry.leftToInvoice == null &&
                          partsCostEntry.leftToPurchase == null &&
                          partsCostEntry.newEtcDraft != null
                            ? round2(Number(partsCostEntry.newEtcDraft))
                            : null;
                        // ── New ETC, calculated (2026-09-03, by request) ────────────
                        //
                        // The sum of the two cells above, with a blank half counting as
                        // 0 — null only when NEITHER has been answered, which is the one
                        // state that renders blank. This is the figure the whole rest of
                        // this block is built from: the seed the cell displays, whether
                        // the row counts as decided, its Diff, its risk flag and its
                        // contribution to the footer.
                        //
                        // Computed from the SAME two values the cells are rendered with,
                        // including the Left to Invoice seed. Deriving it from the stored
                        // newEtcDraft instead would make the server's first paint
                        // disagree with the sum the cells add up to the moment they
                        // hydrate — and, worse, leave the cell permanently dirty: its
                        // value would differ from its baseline with no edit behind it and
                        // nothing a save could do about it.
                        // BOTH, or blank. `partsNewEtc` is the one rule — the grid, the
                        // save, the submission and the live client sum all ask it, because
                        // a blank that means 0 in one of them and blank in another is the
                        // shape of bug this replaces.
                        const breakoutSum = partsNewEtc(leftToInvoiceValue, leftToPurchaseValue);
                        // Undecided still falls back to the carry-forward suggestion,
                        // exactly as it does on a month without these columns — that is
                        // what Submit would write, and next month's Prior ETC depends on
                        // it. See effectiveNewEtc.
                        const effectiveNewEtcCost =
                          showBreakout && breakoutSum !== null ? breakoutSum : effectiveNewEtc(partsCostEntry);
                        // The SAME rule as the per-section-hours cells, with no
                        // exceptions left (lib/etc.ts): Parts Cost New ETC needs manager
                        // attention (yellow) exactly when money was spent this month
                        // (spent > 0) and no value has been entered yet. Nothing is
                        // auto-filled into a cell in that state — the figure is a
                        // judgement call, and the suggestion stays on the tooltip.
                        //
                        // No spend, no question: the balance carries forward on its own
                        // and the cell reads as neutral.
                        const partsCostState = {
                          priorEtc: prior,
                          hoursWorked: spent,
                          draft: draftCost,
                          confirmed: isHistoricalMonth || partsCostEntry.submittedAt != null ? round2(Number(partsCostEntry.newEtc)) : null,
                          cleared: partsCostEntry.newEtcClearedAt != null,
                          locked: cellsReadOnly,
                          monthComplete,
                          // MONEY — keeps its cents. See NewEtcCellState.precision.
                          precision: "exact",
                          // A month with NO spend still carries the balance forward
                          // automatically and reads as neutral (isNewEtcCellDecided
                          // returns true on hoursWorked 0). Money spent with an empty
                          // box is yellow, exactly like an hours cell.
                        } satisfies NewEtcCellState;
                        // The calculated sum on a breakout month; the stored draft /
                        // confirmed / carry-forward seed on every earlier one.
                        const partsCostSeed = showBreakout
                          ? breakoutSum === null
                            ? ""
                            : String(breakoutSum)
                          : newEtcSeedText(partsCostState);
                        const decidedCost = isNewEtcCellDecided(partsCostState, partsCostSeed);
                        // Diff = Money Left − New ETC, where New ETC is the figure IN THE CELL:
                        // a blank box counts as 0, so Diff reads as the money nobody has planned
                        // yet (2026-08-04, by request — see the Diff cell below).
                        //
                        // Deliberately NOT effectiveNewEtc, which returns the SUGGESTION for an
                        // undecided cell and would make Diff 0 on every unplanned row. That
                        // function answers a different question — "what will this month be if
                        // submitted as-is" — and next month's Prior ETC depends on its answer, so
                        // it stays as it is. Only Diff reads a blank as zero.
                        // §29.2/§29.3 — undecided contributes NOTHING, like every hours
                        // Diff beside it. See the note on the cell below and the matching
                        // change in PartsCostNewEtcCell (the client half of this cell).
                        const diffCost = decidedCost ? moneyLeft - Math.max(effectiveNewEtcCost, 0) : 0;
                        partsCostGrandTotal.prior += prior;
                        partsCostGrandTotal.worked += spent;
                        partsCostGrandTotal.newEtc += effectiveNewEtcCost;
                        // A blank cell contributes nothing — the same rule the column
                        // itself uses, so entering $1 moves the footer by $1 and a footer
                        // total is never made partly of figures nobody can see.
                        partsCostGrandTotal.leftToInvoice += leftToInvoiceValue ?? 0;
                        partsCostGrandTotal.leftToPurchase += leftToPurchaseValue ?? 0;

                        return (
                          <Fragment key="parts-cost">
                            {/* PARTS_COL_W on every cell in this block: these are seven-figure
                                money columns and the hours width clipped them ("$1,065,7…").
                                See components/ui/classnames.ts. */}
                            {/* The row-wide red wash these three carried is gone (2026-09-04,
                                by request): "do not use row-level red backgrounds for Parts
                                Cost validation/differences. Any status/difference indication
                                should stay at the specific cell level only." So no
                                `data-parts-risk`, no injected style, and no live repaint —
                                Diff still carries the same information in its own cell, and
                                Left to Invoice carries its own override highlight. */}
                            <td
                              className={`${PHASE_EDGE} ${PARTS_COL_W} overflow-hidden bg-[#5E91D3] px-1 py-1 text-center align-middle text-label whitespace-nowrap text-sdc-gray-700`}
                              title={currencyExact(prior)}
                            >
                              {currency(prior)}
                            </td>
                            <td
                              className={`border-l border-sdc-border ${HOURS_WORKED_BG} ${PARTS_COL_W} overflow-hidden px-1 py-1 text-center align-middle whitespace-nowrap`}
                            >
                              {/* Not manager-editable — always Power BI's actual, passed through as a
                                  hidden field so submitMonth's generic per-entry loop still works. */}
                              <input type="hidden" name={`hoursWorked__${partsCostEntry.id}`} value={spent} />
                              {/* w-full, not a fixed w-16 with `truncate`: the cell now sizes the
                                  column, so the figure should use all of it rather than being cut
                                  to 64px inside a wider box. */}
                              <span
                                className="block w-full text-center text-label text-sdc-gray-600"
                                title={currencyExact(spent)}
                              >
                                {currency(spent)}
                              </span>
                            </td>
                            <td
                              className={`border-l border-sdc-border ${HOURS_LEFT_BG} ${PARTS_COL_W} overflow-hidden px-1 py-1 text-center align-middle text-label whitespace-nowrap text-sdc-muted`}
                              title={`${currencyExact(moneyLeft)} = Prior ETC (${currencyExact(prior)}) − Money Spent (${currencyExact(spent)})`}
                            >
                              {currency(moneyLeft)}
                            </td>
                            {/* ── The two editable cells New ETC is made of ─────
                                Both are typed, both wear New ETC's grey, and their
                                sum IS the New ETC cell to their right — which is why
                                that cell no longer takes a caret.

                                Absent entirely before August 2026, matching the
                                header — see lib/parts-breakout-scope.ts. */}
                            {showBreakout && (
                            <>
                            <PartsBreakoutCell
                              which="invoice"
                              // EDITABLE again (2026-09-04, by request), and the computed
                              // Parts List figure is its DEFAULT rather than a suggestion
                              // on a tooltip. `overridden` is what draws the
                              // manually-adjusted highlight — see lib/left-to-invoice.ts
                              // for why that is derived from stored-vs-default rather than
                              // stored as a flag (it makes "put it back" reversible with no
                              // second write).
                              overridden={resolvedInvoice.overridden}
                              name={`partsLeftToInvoice__${partsCostEntry.id}`}
                              initialValue={leftToInvoiceValue == null ? "" : String(leftToInvoiceValue)}
                              jobId={job.id}
                              jobName={job.jobName}
                              seedHint={
                                // Explains a figure that is ON SCREEN and editable. What a
                                // manager needs to trust it: where it came from, that it
                                // matches the Parts List filtered to the same day, that
                                // typing over it is allowed, and — once they have — what
                                // the number they replaced was.
                                leftToInvoiceValue == null
                                  ? `Total ETO could not be reached for this job, so there is no default here. Type what is on order and not yet invoiced — New ETC stays blank until both this and Left to Purchase have a value.`
                                  : resolvedInvoice.overridden
                                  ? `Manually adjusted. Total ETO’s figure as of ${cutoffLabel} is ${currencyExact(resolvedInvoice.defaultValue ?? 0)}; this cell has been set to ${currencyExact(leftToInvoiceValue)} instead. Clear it or type the original figure back to remove the highlight.`
                                  : `${currencyExact(leftToInvoiceValue)} on purchase orders and not yet invoiced as of ${cutoffLabel} — the same figure this job’s Parts List shows filtered through that date. This is the default and you can type over it; an adjusted cell is highlighted.` +
                                    (suggestionLatePostings > 0
                                      ? ` ${currencyExact(suggestionLatePostings)} has posted after ${cutoffLabel} against orders placed on or before it, and is already deducted — so this figure keeps falling as later invoices post. The Parts List moves with it.`
                                      : "") +
                                    (supersededNewEtc != null
                                      ? ` This row previously carried a hand-typed New ETC of ${currencyExact(supersededNewEtc)}; New ETC is now this figure plus Left to Purchase.`
                                      : "")
                              }
                              bg={newEtcBg(true)}
                              locked={cellsReadOnly}
                            />
                            <PartsBreakoutCell
                              which="purchase"
                              name={`partsLeftToPurchase__${partsCostEntry.id}`}
                              initialValue={leftToPurchaseValue == null ? "" : String(leftToPurchaseValue)}
                              jobId={job.id}
                              jobName={job.jobName}
                              seedHint="Nothing is filled in here automatically — type what is still to be bought."
                              bg={newEtcBg(true)}
                              locked={cellsReadOnly}
                            />
                            </>
                            )}
                            <PartsCostNewEtcCell
                              name={`newEtcOverride__${partsCostEntry.id}`}
                              // For the live Total ETC $ chain — see
                              // lib/etc-live-totals.ts.
                              jobId={job.id}
                              priorEtc={prior}
                              spent={spent}
                              suggested={suggestedCost}
                              jobName={job.jobName}
                              // Same seed as before — a draft, else the confirmed
                              // value on a reopened month (so a no-changes resubmit
                              // can't replace it with the suggestion), else the
                              // carry-forward once actuals are complete — but via the
                              // shared rule, which additionally honours a deliberate
                              // blanking. Cents preserved (precision "exact").
                              initialValue={partsCostSeed}
                              // Deliberately NOT `!decidedCost`: that counts a
                              // saved draft as decided forever, so clearing a
                              // drafted cell would leave it neutral. The cell
                              // judges presence from its own value.
                              //
                              // A reopened month now qualifies: its cells hold last
                              // submission's figure and nobody has confirmed it this
                              // pass, so it is genuinely awaiting an answer.
                              cellState={partsCostState}
                              // NO placeholder hint, matching the per-section
                              // hours cells (see EtcSectionCells). It used to
                              // show the suggestion — and the placeholder is
                              // styled bold in the same grey as a real value, so
                              // a cell nobody had touched was indistinguishable
                              // from a decided one. Every Parts Cost row with
                              // money spent this month looked filled in when in
                              // fact none of them were. Money spent means the
                              // new figure is a manager's judgment call, so the
                              // cell now reads as genuinely blank until one is
                              // typed; the suggestion stays on the tooltip.
                              hint={
                                spent === 0 || draftCost != null
                                  ? undefined
                                  : `Nothing decided yet. Money Left is ${currencyExact(moneyLeft)} — carrying that forward would give ${currencyExact(suggestedCost)}.`
                              }
                              // Calculated from the two cells to its left on every month
                              // that has them; typed, exactly as before, on every month
                              // that does not.
                              derived={showBreakout}
                              locked={cellsReadOnly}
                            />
                            <td
                              // LIVE (2026-08-04). This cell was the one dependent figure
                              // on the grid that did not move: typing a Parts Cost New ETC
                              // updated the footer totals correctly but left the row's own
                              // Diff at its server-rendered value, because the input is a
                              // client component (PartsCostNewEtcCell) while this <td> is
                              // rendered here. The hours columns don't have the problem —
                              // EtcSectionCells renders the input AND its Diff together, so
                              // local state covers both. Found by predicting the value and
                              // checking: $8,600 Money Left, typed $5,000, footer moved to
                              // -$386,377 as expected while this stayed $8,600 instead of
                              // $3,600.
                              data-live="partsRowDiff"
                              data-job={job.id}
                              className={`border-l border-sdc-border ${PARTS_COL_W} overflow-hidden px-1 py-1 text-center align-middle text-label whitespace-nowrap text-sdc-gray-700`}
                              // ── BLANK until a New ETC is entered (§29.2) ──────────────
                              //
                              // Third and final position on this cell, so both predecessors
                              // are worth recording. It printed "—" for an undecided cell;
                              // that was replaced on 2026-08-04 by ALWAYS printing a figure,
                              // on the reasoning that the hours columns treat a blank New ETC
                              // as 0 and so read as Money Left until somebody plans the row.
                              //
                              // That premise was wrong about the hours columns. newEtcDiff
                              // returns 0 for an undecided cell — it does NOT report Money
                              // Left — and the hours Diff cell prints nothing, judged by
                              // isNewEtcDecided. So "uniform with hours" actually means what
                              // §29 asks for: blank New ETC ⇒ blank Diff, contributing
                              // nothing to any total.
                              //
                              // It summed, too: this expression is what put $1,085,685 of
                              // "variance" in July's Parts footer when the real figure across
                              // decided cells was $0.
                              style={decidedCost ? diffCellStyle(diffCost, DIFF_CEILING.moneyCell) : undefined}
                              title={
                                decidedCost
                                  ? `${currencyExact(diffCost)} = Money Left (${currencyExact(moneyLeft)}) − New ETC (${currencyExact(effectiveNewEtcCost)})`
                                  : "No New ETC entered yet, so there is no variance to report."
                              }
                            >
                              {decidedCost ? currency(diffCost) : ""}
                            </td>
                          </Fragment>
                        );
                      })()}
                      {showStandards &&
                        (() => {
                          const std = standardByJob.get(job.id);
                          if (!std) return null;
                          return (
                            <Fragment key="standards">
                              {/* SuppressToasts: these ARE the "Standard Sheet" columns the
                                  task names. No toast() call exists in EtcStandardCells today
                                  (its Contingency/Notes autosave is silent by design), but the
                                  wrap is here so a future one added to this cell defaults to
                                  suppressed rather than leaking a global toast per keystroke
                                  across an 1,100+-cell grid. */}
                              <SuppressToasts>
                                <EtcStandardCells job={std} />
                              </SuppressToasts>
                            </Fragment>
                          );
                        })()}
                    </tr>
                  );
                })}
                {visibleJobs.length === 0 && (
                  <NoJobsMessageRow
                    baseColSpan={3 + (visibleCols.length + visibleGroups.length) * SUB_COLUMNS.length + partsCostCols.length}
                    standardsColumnCount={showStandards ? STANDARD_LEAF_COLUMNS.length : 0}
                    message={jobs.length === 0 ? "No active jobs found." : "No jobs match the Billable filter."}
                  />
                )}
              </tbody>
              {/* tfoot, not the last row of tbody: it's what takes the totals out
                  of the body-row padding rule's reach (see CELL_PADDING), and it
                  lets the row pin to the bottom of the scroller so the grand
                  totals stay on screen while scrolling a 59-job month. */}
              <tfoot className="sticky bottom-0 z-20">
                {visibleJobs.length > 0 && (
                  <tr className="etc-total-row border-t-2 border-sdc-navy font-medium">
                    {/* Mirror the body's THREE separate frozen cells (same widths
                        + sticky offsets) rather than one colSpan cell, so the
                        section totals after them line up exactly with the rows. */}
                    <td className="sticky left-0 z-10 w-10 min-w-10 overflow-hidden bg-sdc-gray-100 px-2 py-2.5 text-center align-middle whitespace-nowrap" />
                    <td data-etc-jobid className="sticky left-10 z-10 w-20 min-w-20 overflow-hidden bg-sdc-gray-100 px-3 py-2.5 text-right align-middle font-bold whitespace-nowrap text-sdc-navy">
                      {/* The "Total" label belongs against the heavy divider, so it sits
                          on whichever of these two cells is last. Both are printed and
                          CSS picks — see etcViewExtraRules. `invisible` is a Tailwind
                          utility, so it is in a CSS layer; the generated stylesheet is
                          unlayered and therefore wins when it reveals this, with no
                          !important needed. */}
                      <span data-etc-total-fallback className="invisible">Total</span>
                    </td>
                    <td
                      data-col="jobname"
                      style={{ width: "var(--etc-job-col-width, 260px)", minWidth: "var(--etc-job-col-width, 260px)" }}
                      className="sticky left-[7.5rem] z-10 overflow-hidden border-r-8 border-[#808080] bg-sdc-gray-100 px-3 py-2.5 text-right align-middle font-bold whitespace-nowrap text-sdc-navy"
                    >
                      Total
                    </td>
                    {visibleCols.map((s, sIdx) => {
                      const t = sectionGrandTotals.get(s.code)!;
                      // Same rounded-chain rule as every other Hours Left on this
                      // page — see EtcSectionCells for why.
                      const hoursLeftExact = t.prior - t.worked;
                      const hoursLeft = Math.round(t.prior) - Math.round(t.worked);
                      const diff = t.diff;
                      return (
                        <Fragment key={s.code}>
                          <td data-col={`${s.code} ${s.billingGroup}`} className={`${edgeFor(s.code, sIdx)} ${ETC_COL_W} overflow-hidden bg-[#5E91D3] px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-gray-700`} title={String(round2(t.prior))}>{wholeNum(t.prior)}</td>
                          <td data-col={`${s.code} ${s.billingGroup}`} className={`border-l border-sdc-border ${ETC_COL_W} ${HOURS_WORKED_BG} overflow-hidden px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-navy`} title={String(round2(t.worked))}>{wholeNum(t.worked)}</td>
                          <td
                            data-col={`${s.code} ${s.billingGroup}`}
                            className={`border-l border-sdc-border ${ETC_COL_W} ${HOURS_LEFT_BG} overflow-hidden px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-navy`}
                            title={`${round2(hoursLeftExact)} = Prior ETC (${round2(t.prior)}) − Hours Worked (${round2(t.worked)})`}
                          >
                            {wholeNum(hoursLeft)}
                          </td>
                          {/* The two totals that move as a manager types, at the
                              foot of the very column they're typing in — the most
                              watched pair of numbers on the page. EtcLiveTotals
                              repaints them through these hooks; without them the
                              column total sat frozen until a save, which read as
                              the edit (and then Save itself) not working at all.

                              ── Total New ETC is no longer gated on monthComplete
                              (2026-08-04). It used to print "—" until the month's
                              actuals were complete, which is the answer to "why are
                              the bottom totals not updating": on an in-progress
                              month it WAS a dash, and no amount of typing could move
                              a dash. That gate belongs on the CELLS, where it stops a
                              partial figure looking final; a total's contract is to
                              equal the sum of the values displayed above it. */}
                          <td
                            data-live="newEtc"
                            data-section={s.code}
                            data-col={`${s.code} ${s.billingGroup}`}
                            className={`border-l border-sdc-border ${ETC_COL_W} ${newEtcBg(true)} overflow-hidden px-1 py-2.5 text-center align-middle text-label font-bold whitespace-nowrap text-sdc-navy`}
                            title={String(round2(t.newEtc))}
                          >
                            {wholeNum(t.newEtc)}
                          </td>
                          <td
                            data-live="diff"
                            data-section={s.code}
                            data-col={`${s.code} ${s.billingGroup}`}
                            className={`border-l border-sdc-border ${ETC_COL_W} overflow-hidden px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-gray-700`}
                            style={diffTotalStyle(diff, DIFF_CEILING.hoursTotal)}
                            title={`${round2(diff)} = the sum of (Hours Left − New ETC) down this column. Cells with no New ETC typed compare against the suggestion, so they read 0 unless already overspent.`}
                          >
                            {wholeNum(diff)}
                          </td>
                        </Fragment>
                      );
                    })}
                    {visibleGroups.map((group, gi) => {
                      const t = groupGrandTotals[group];
                      // Same rounded-chain rule as the rows above it.
                      const hoursLeftExact = t.prior - t.worked;
                      const hoursLeft = Math.round(t.prior) - Math.round(t.worked);
                      const diff = t.diff;
                      return (
                        <Fragment key={group}>
                          <td data-col={group} className={`${gi === 0 ? PHASE_EDGE : "border-l border-sdc-border"} ${ETC_COL_W} overflow-hidden bg-[#5E91D3] px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-gray-700`} title={String(round2(t.prior))}>{wholeNum(t.prior)}</td>
                          <td data-col={group} className={`border-l border-sdc-border ${ETC_COL_W} ${HOURS_WORKED_BG} overflow-hidden px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-blue-dark`} title={String(round2(t.worked))}>{wholeNum(t.worked)}</td>
                          <td
                            data-col={group}
                            className={`border-l border-sdc-border ${ETC_COL_W} ${HOURS_LEFT_BG} overflow-hidden px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-blue-dark`}
                            title={`${round2(hoursLeftExact)} = Prior ETC (${round2(t.prior)}) − Hours Worked (${round2(t.worked)})`}
                          >
                            {wholeNum(hoursLeft)}
                          </td>
                          {/* Same two live cells as the body rows, at the grand
                              total. `data-job="all"` marks the footer. */}
                          <td
                            data-live="newEtc"
                            data-group={group}
                            data-col={group}
                            data-job="all"
                            className={`border-l border-sdc-border ${ETC_COL_W} ${newEtcBg(true)} overflow-hidden px-1 py-2.5 text-center align-middle text-label font-bold whitespace-nowrap text-sdc-blue-dark`}
                            title={String(round2(t.newEtc))}
                          >
                            {wholeNum(t.newEtc)}
                          </td>
                          <td
                            data-live="diff"
                            data-group={group}
                            data-col={group}
                            data-job="all"
                            className={`border-l border-sdc-border ${ETC_COL_W} overflow-hidden px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-gray-700`}
                            style={diffTotalStyle(diff, DIFF_CEILING.hoursTotal)}
                            title={`${round2(diff)} = the sum of (Hours Left − New ETC) down this column. A cell with no New ETC typed compares against the suggestion, so it reads 0 unless that section is already overspent.`}
                          >
                            {wholeNum(diff)}
                          </td>
                        </Fragment>
                      );
                    })}
                    {(() => {
                      const t = partsCostGrandTotal;
                      const moneyLeft = t.prior - t.worked;
                      const diffCost = moneyLeft - t.newEtc;
                      return (
                        <Fragment key="parts-cost-total">
                          <td className={`${PHASE_EDGE} overflow-hidden bg-[#5E91D3] px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-gray-700`} title={currencyExact(t.prior)}>{currency(t.prior)}</td>
                          {/* Total Money Spent is ALWAYS the live month-to-date
                              total, even while per-job cells are blanked pending
                              month completion. */}
                          <td className={`border-l border-sdc-border ${HOURS_WORKED_BG} overflow-hidden px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-navy`} title={`${currencyExact(t.worked)} — live month-to-date total`}>{currency(t.worked)}</td>
                          <td
                            className={`border-l border-sdc-border ${HOURS_LEFT_BG} overflow-hidden px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-navy`}
                            title={`${currencyExact(moneyLeft)} = Prior ETC (${currencyExact(t.prior)}) − Money Spent (${currencyExact(t.worked)})`}
                          >
                            {currency(moneyLeft)}
                          </td>
                          {showBreakout && (
                          <>
                          {/* Both are typed columns now, so their totals move as they
                              are typed — the same data-live hook the New ETC and Diff
                              totals beside them already use (EtcLiveTotals). Without
                              it these two would be the only Parts Cost totals that
                              sat still while the column above them changed. */}
                          <td
                            data-live="partsLeftToInvoice"
                            className={`border-l border-sdc-border ${newEtcBg(true)} overflow-hidden px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-navy`}
                            title={`${currencyExact(t.leftToInvoice)} on purchase orders, not yet invoiced, across every job shown`}
                          >
                            {currency(t.leftToInvoice)}
                          </td>
                          <td
                            data-live="partsLeftToPurchase"
                            className={`border-l border-sdc-border ${newEtcBg(true)} overflow-hidden px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-navy`}
                            title={`${currencyExact(t.leftToPurchase)} still to be bought, across every job shown`}
                          >
                            {currency(t.leftToPurchase)}
                          </td>
                          </>
                          )}
                          {/* Parts Cost New ETC is manager-editable
                              (PartsCostNewEtcCell), so its grand total has to move
                              with it the same way the hours columns do. */}
                          <td
                            data-live="partsNewEtc"
                            className={`border-l border-sdc-border ${newEtcBg(true)} overflow-hidden px-1 py-2.5 text-center align-middle text-label font-bold whitespace-nowrap text-sdc-navy`}
                            title={currencyExact(t.newEtc)}
                          >
                            {currency(t.newEtc)}
                          </td>
                          <td
                            data-live="partsDiff"
                            className={`border-l border-sdc-border overflow-hidden px-1 py-2.5 text-center align-middle text-label whitespace-nowrap text-sdc-gray-700`}
                            style={diffTotalStyle(diffCost, DIFF_CEILING.moneyTotal)}
                            title={`${currencyExact(diffCost)} = Money Left (${currencyExact(moneyLeft)}) − New ETC (${currencyExact(t.newEtc)})`}
                          >
                            {currency(diffCost)}
                          </td>
                        </Fragment>
                      );
                    })()}
                    {showStandards && (
                      <Fragment key="standards-total">
                        <SuppressToasts>
                          <StandardGrandCells />
                        </SuppressToasts>
                      </Fragment>
                    )}
                  </tr>
                )}
              </tfoot>
            </table>
          </DragScroll>
          </form>
          {/* ── The Standard Fees card (§48) ─────────────────────────────────────
              Rendered ALWAYS, and it decides for itself whether to show anything. That
              is the whole point: revealing it used to require a server render of this
              page (2,911ms / 190KB, measured), and now the reveal is a boolean in
              lib/standards-reveal.ts.

              `initialData` is the figures the server already computed — non-null only
              when THIS request carried the unlock cookie, so an already-unlocked visitor
              gets the card with no action call and no spinner, and a locked one is sent
              nothing at all. When the password is accepted mid-session the card shows its
              shell immediately and fetches only its own inputs. */}
          {/* SuppressToasts: this is the "Standard Card" / Standard Fees panel the task
              names — including SubmitReportAction, which has no useToast() call of its
              own (its readiness line, dialog and receipt are all inline by design; see
              its own header comment) and so is unaffected either way. Wrapped for the
              same future-proofing as the Standard Sheet cells above. */}
          <SuppressToasts>
          <StandardFeesCard
            month={month}
            initialData={
              showStandards
                ? {
                    month,
                    monthName: monthNameOnly,
                    carriedFrom: poolsCarriedFrom,
                    upstreamNote: poolsUpstreamNote,
                    rows: poolPanelRows,
                    newProjects: poolNewProjects,
                    isSubmitted: standardSheetSubmitted,
                    poolsEditable: !standardSheetSubmitted && !poolsCarriedFrom,
                    initialStatus: reportReadiness,
                  }
                : null
            }
            savePoolsAction={savePools.bind(null, month)}
          />
          </SuppressToasts>
        </div>
        </StandardRatesProvider>
      )}
    </div>
    </EtcGridView>
  );
}


// -- Route entry point --
//
// The page's body lives in `MonthlyEtcView` above so that BOTH this route and the split
// view can render it. Split view renders two views in ONE document (see
// lib/split-view.ts for why one document rather than two frames), which means a
// pane cannot be a route and therefore cannot read `searchParams` - there is only
// one URL, and two panes reading it would collide. So the body takes its context as
// a plain argument, and the two callers differ only in where they read that context
// from: this wrapper reads the URL, a pane reads its own `l.`/`r.` namespace.
//
// Nothing about this route's behaviour changes: same URL, same params, same server
// render. `searchParams` is still awaited HERE, which is what keeps this route
// dynamic exactly as before.
export default async function MonthlyEtcPage({ searchParams }: { searchParams: Promise<{ month?: string; dept?: string; jobname?: string; billables?: string }> }) {
  return <MonthlyEtcView params={await searchParams} />;
}
