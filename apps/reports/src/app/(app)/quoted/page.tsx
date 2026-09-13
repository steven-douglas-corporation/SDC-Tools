import { Fragment } from "react";
import { SourceStaleBanner } from "@/components/SourceStaleBanner";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { validJobTypeFilter, VALID_JOB_TYPES, JOB_STATUSES, DEFAULT_VISIBLE_STATUSES, compareJobIds, isSdcCustomer } from "@/lib/job-filters";
import { SECTIONS, PHASE_GROUPS, RESTRICTED_SECTION_CODES, restrictedSectionPermission } from "@/lib/sections";
import { hasPermission } from "@/lib/permissions";
import { abbreviateLabel } from "@/lib/abbrev";
import { DragScroll } from "@/components/DragScroll";
import { PageTitle } from "@/components/ui/Typography";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, GRID_SCROLLER, PAGE_SHELL, TABLE_GRID, TABLE_HEADER_ROW } from "@/components/ui/classnames";
import { ProjectViewsMenu } from "@/components/ProjectViewsMenu";
import { ExportMenu } from "@/components/ExportMenu";
import { listSharedViews } from "@/lib/saved-views-actions";
import { ProjectsFilterMenu } from "@/components/ProjectsFilterMenu";
import { ProjectsDateFilter } from "@/components/ProjectsDateFilter";
import { ProjectsAutosave } from "@/components/ProjectsAutosave";
import { ProjectsLiveTotals } from "@/components/ProjectsLiveTotals";
import { ProjectsRemoteCells } from "@/components/ProjectsRemoteCells";
import { ProjectsSectionsMenu } from "@/components/ProjectsSectionsMenu";
import { ProjectsGridView } from "@/components/ProjectsGridView";
import { PROJECTS_INFO_COLUMNS } from "@/lib/projects-view";
import { ProjectsShowActualsSwitch } from "@/components/ProjectsShowActualsSwitch";
import { SortButton } from "@/components/SortButton";
import { AddProjectButton } from "@/components/AddProjectButton";
import { NewProjectRows } from "@/components/NewProjectRows";
import { GridDateCells } from "@/components/GridDateCells";
import { dateCellProps } from "@/lib/date-cell";
import { MoneyCell } from "@/components/MoneyCell";
import { SaveQuotedHoursButton } from "@/components/SaveQuotedHoursButton";
import { JobCellMenuHost } from "@/components/JobCellMenuHost";
import { jobCellMenuProps } from "@/lib/job-cell-menu";
import { getSchedulerLinkContext, schedulerScheduleUrl } from "@/lib/scheduler-link";
import { saveQuotedHours } from "@/lib/quoted-actions";
import { QuotedSaveForm } from "@/components/QuotedSaveForm";
import { decodeParamList, isActualsOn } from "@/lib/quoted-display-prefs";
import { quotedCellTone } from "@/lib/quoted-tone";
import { loadActualHoursBySection } from "@/lib/actual-hours";
import {
  ProjectsEditModeProvider,
  ProjectsEditModeToggle,
  ProjectsEditFieldset,
  WhenEditing,
} from "@/components/ProjectsEditMode";
import { getProjectsEditState } from "@/lib/projects-edit-mode";
import { requirePagePermission } from "@/lib/require-permission";

// Header banding, matching the real "Estimated Hours" tab's column colors
// exactly (extracted from its theme + explicit fills) — phase row, then a
// department-band row (Function Group), then the section name.
// Re-themed to the SDC brand palette (see brand color sheet): phase banners
// use the bold brand *core* colors, group sub-bands below use lighter brand
// *tints* so the two-tier header hierarchy reads at a glance. Each value
// carries its own text color so it can win over the base cell class reliably.
const PHASE_HEADER_COLOR: Record<string, string> = {
  "Complete Design & Build": "bg-sdc-navy text-white", // #061D39 — anchor phase
  "Machine Testing": "bg-sdc-blue text-white", // #1574C4 — primary brand
  "Teardown & Install": "bg-sdc-green text-white", // #74C415
  Warranty: "bg-sdc-yellow text-sdc-navy", // #FFDE51 (dark text for contrast)
};
// ── The grid's cell padding, which used to be two user controls (§45) ───────
//
// These gave every body cell one uniform vertical padding and every repeated data
// column one uniform horizontal padding. They read --quoted-row-py /
// --quoted-col-px, which the Display menu's Row height and Column width steppers
// wrote (0–16px, persisted, this tab only) — and Monthly ETC had its own matching
// pair, so the two grids could sit at different densities in the same app. §45
// replaced all four with the one sidebar Zoom, which scales these paddings along
// with everything else, so what is left is the constants the steppers defaulted to:
// 6px and 4px at the 15px root, written in rem for the reason in §39.14.
//
// The horizontal rule still targets only cells marked "qc" ("quoted column") — the
// repeated per-section header/data columns, all at one padding — deliberately
// excluding the sticky #/Job Id/Job/Cost columns (own fixed widths), the optional
// metadata columns (Customer/Type/Status/Dates, px-2) and the phase/group banner
// headers, whose padding isn't a "column width" in the same sense.
const CELL_PADDING = "[&_td]:py-[0.4rem] [&_.qc]:px-[0.2667rem]";

// Every repeated data column — the per-section quoted/actual cells and the two
// grand-total columns — renders at ONE uniform width, so the grid reads as an
// even matrix instead of the ragged one auto-layout produced. The old
// `w-[40px] min-w-[40px]` only set a floor, so each column still stretched to
// its own content and no two matched; these three properties together pin it.
//
// The width is `content + padding` rather than a flat number, so the CONTENT box
// stays a constant 4.7rem: a flat width would let the horizontal padding eat into the
// words, and since the width is pinned with max-width the column could not grow to
// absorb it the way the old min-width-only rule did.
//
// 4.7rem is measured against the real font, which matters more than it sounds:
// the app renders in Montserrat, where the longest header word "SOFTWARE" is
// 69.2px at the grid's 0.68rem text — 23% wider than the same string in the
// -apple-system/Segoe fallback (56.3px). Measuring in the fallback is exactly
// how this column got sized too narrow the first time, so if these names ever
// change, re-measure in Montserrat.
//
// ── What the two odd-looking parts of this expression are for (§45) ─────────
//
// `max(4.7rem, 72px)` and the `+ 2 * …` both date from the old sidebar Text size
// control, which moved the ROOT FONT SIZE between 12 and 20px. That made the rem
// value and the fixed-10px header label shrink at DIFFERENT rates: at Text size 12 the
// column offered 56.4px of content while "SOFTWARE" needed 63.7px, so the word could
// not break and was simply clipped. The px floor was that longest word plus room to
// breathe. The padding term was the Column width stepper's 0–16px.
//
// §45 replaced both controls with `zoom`, which scales the column, the label and the
// padding by the same factor — so the rates can no longer diverge and the floor can
// never bind differently than it does at 100%. Both parts are kept anyway: at the 15px
// root `max()` resolves to the 72px floor (4.7rem = 70.5px) and the padding term to
// 8px, which is exactly the width this column has today. Rewriting it as the single
// number it now equals would change nothing on screen and lose the measurement.
const DATA_COL = "calc(max(4.7rem, 72px) + 2 * 0.2667rem)";
const DATA_COL_STYLE = { width: DATA_COL, minWidth: DATA_COL, maxWidth: DATA_COL } as const;

// The Parts Cost money cell. Left-aligned (2026-08-10, by request) like the
// rest of the grid — it used to be right-aligned and centred as a "$ number"
// unit inside the cell, which meant a SHORT figure ("$0") and a LONG one
// ("$1,406,923") centred at different offsets and neither edge lined up,
// reading as inconsistent padding rather than the intended "compare digits at
// a glance" effect. tabular-nums still keeps the digits themselves in
// fixed-width columns while editing.
//
// Fixed at 4.5rem, not `w-full` (2026-08-11) — Quoted and Actual used to be
// two separate columns, each free to fill its own column's full width; merged
// into one column, two `w-full` MoneyCells would each demand the ENTIRE cell
// width and fight over it. 4.5rem comfortably fits a 7-figure quote
// ("1,300,000") with room to spare. `.hide-actuals .parts-cost-quoted`
// (globals.css) widens the quoted half back to the cell's full width for the
// OFF state, when there's only one figure on screen and no sibling to share
// the cell with.
const EMPTY_ACTUALS: ReadonlyMap<string, number> = new Map();

const MONEY_INPUT_PAIRED = "w-[4.5rem] min-w-0 border-none bg-transparent text-left tabular-nums outline-none";

// Pinned — width AND max-width, not just min-width (2026-08-14) — because the
// bare `min-w-[170px]` this replaces was the one column with no upper bound
// in a `w-full` table where every other column (DATA_COL_STYLE, the frozen
// #/Job Id/Job columns, the var(--*-col-width) metadata columns) pins its own
// width. `table-layout: auto` hands unclaimed space to whichever column has
// none of its own, so Parts Cost stretched to soak up the rest of the scroll
// container — the large blank strip to the right of the figures.
//
// The actual width rule lives in globals.css, keyed off `.pc-col` (applied to
// the <th>/<td> below) and `.hide-actuals` — NOT a server-computed inline
// style. Show Actuals is a deliberately render-free switch (see
// ProjectsShowActualsSwitch's flip(): it only ever toggles the `hide-actuals`
// class client-side, `replaceState`s the URL, and never re-renders this
// server component) — a width baked in from `showActuals` at THIS render
// would match whichever state the page happened to load in and go stale the
// instant someone actually clicked the switch. CSS reacting to the same class
// the switch already flips is the only way the width tracks it live.
const PARTS_COST_COL_CLASS = "pc-col";

// Group sub-bands: lighter SDC brand tints, each distinct, all drawn from the
// brand palette (blue/green/yellow tints + light blue), with one bold brand
// blue for the large General Engineering block so it reads as its own zone.
//
// Keyed on `s.group`'s actual values — sections.ts's own canonical wording
// (2026-08-20; "PM"/"ME"/"CE" -> "Project Management (PM)"/"Mechanical Engineering"/
// "Controls Engineering") rather than a hand-typed abbreviation of it. This
// map going stale after that rename would have been silent: a color lookup
// miss falls back to `?? ""`, so the header would just lose its band color
// rather than error — exactly the kind of drift a shared vocabulary is
// supposed to make impossible.
const GROUP_HEADER_COLOR: Record<string, string> = {
  "Project Management (PM)": "bg-sdc-gray-100 text-sdc-navy", // neutral brand gray
  "Mechanical Engineering": "bg-sdc-blue-light text-sdc-navy", // #e6f0fa
  "Controls Engineering": "bg-sdc-green-bg text-sdc-navy", // #eef7de
  "General Engineering": "bg-sdc-blue text-white", // #1574C4
  Shop: "bg-sdc-yellow-bg text-sdc-navy", // #fff6d6
  Engineering: "bg-sdc-blue-100 text-sdc-navy", // #aacee8
};

// Consecutive runs of the same group within a phase's visible sections, for
// the group-band row's colSpans (mirrors PHASE_GROUPS but re-derived per
// request since visibility is filtered live via the `cols` param).
function groupRuns(sections: { code: string; group: string }[]) {
  const runs: { group: string; count: number }[] = [];
  for (const s of sections) {
    const last = runs[runs.length - 1];
    if (last && last.group === s.group) last.count += 1;
    else runs.push({ group: s.group, count: 1 });
  }
  return runs;
}

// Schedule state, called out on the two identity columns (Job Id and Job Name)
// so a scan down the frozen columns shows which projects need a date fixed and
// which are simply still running:
//
//   RED   — no Start Date at all. The date columns can be scrolled off or hidden
//           entirely (Sections ▾), so a missing start would otherwise be
//           invisible on most people's view of this grid.
//   GREEN — started and not finished: work in flight, which is the normal state
//           for most rows here and is NOT a problem to fix.
//
// A missing start wins over a missing end, because it's the one that needs
// action.
//
// Only RED is bolded. Green covers 36 of the 50 rows on the default view (and no
// job in the database currently has both dates), so bolding it too made bold the
// norm and cost it all its meaning — weight now marks the rows that need fixing,
// and colour alone says "running". Both states also carry a title, because colour
// carries no meaning at all for a colour-blind reader.
//
// Weight and colour are returned separately rather than as one class string:
// combining `font-bold` with the Job Id column's own `font-semibold` would leave
// two competing utilities whose winner depends on stylesheet order, not on intent.
function scheduleTone(job: { startDate: Date | null; completeDate: Date | null; status: string | null }): {
  weight: string;
  color: string;
  title?: string;
} {
  // A HeadStart job has no PO yet, so having no Start Date is the normal state
  // for it — flagging that red would be crying wolf on the one status where the
  // gap is expected.
  if (job.status === "HeadStart") {
    return { weight: "", color: "", title: "HeadStart — intended, no PO yet" };
  }
  if (!job.startDate) {
    return { weight: "font-bold", color: "text-sdc-red-text", title: "No Start Date set for this project" };
  }
  if (!job.completeDate) {
    return { weight: "", color: "text-sdc-green-text", title: "In progress — started, with no Complete Date yet" };
  }
  return { weight: "", color: "" };
}

// <input type="date"> wants "" or "YYYY-MM-DD" — never "—" (formatDate's
// display placeholder), which the browser would reject as an invalid date.
function dateInputValue(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

// Hours display everywhere on this page is whole numbers — no decimals,
// rounded rather than truncated. Use this for any hours value added later too.
function wholeHours(n: unknown): string {
  if (n == null) return "—";
  return Math.round(Number(n)).toString();
}
// Un-rounded counterpart to wholeHours() above, for tooltips — in case a
// stored hours value ever carries a fraction.
function exactHours(n: unknown): string | undefined {
  if (n == null) return undefined;
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

const SORT_KEYS = ["jobId", "status", "startDate", "completeDate"] as const;
type SortKey = (typeof SORT_KEYS)[number];

const BILLABLE_OPTIONS = ["Billable", "Non-Billable"];

// Info columns the "Columns" dropdown can show/hide. # and Job Id always
// show (row identity); phase section columns have their own phase pickers;
// the two Cost columns are the grid's whole point, so neither is toggleable.
//
// One definition, shared with the code that writes `?hide=` — the param's value is
// ORDERED by this list, so a second copy here could silently change the URL a given
// view produces and stop a saved View comparing equal. See lib/projects-view.ts.
const TOGGLE_COLUMNS = PROJECTS_INFO_COLUMNS;

export async function ProjectsView({ params }: { params: {
    cols?: string;
    sort?: string;
    dir?: string;
    customers?: string;
    types?: string;
    statuses?: string;
    billables?: string;
    hide?: string;
    view?: string;
    actuals?: string;
    // "Dates ▾" — which date column to filter on, and the range.
    dateField?: string;
    from?: string;
    to?: string;
  } }) {
  const pageSession = await requirePagePermission("projects:view");
  const sp = params;
  const { cols, sort, dir, customers, types, statuses, billables, hide } = sp;
  // Actual hours in the cells. A view param rather than a client-side flag, so
  // the markup below is already right on arrival — see quoted-display-prefs.ts.
  const showActuals = isActualsOn({ get: (k) => sp[k as keyof typeof sp] ?? null });

  // Read-only unless the signed-in user has explicitly switched Edit Mode on
  // (projects-edit-mode.ts). The cookie's value only SEEDS the switch — from
  // there it's client state, so flipping it doesn't re-run this whole page. And
  // it only shapes the UI either way: every write re-checks the cookie
  // server-side in saveQuotedHours, since a form post doesn't care what the
  // markup said.
  // ── Wave 1: everything that depends on nothing ─────────────────────────────
  //
  // These six were six SEPARATE awaits, run one after another, and one of them
  // (getSchedulerLinkContext) reaches a DIFFERENT MySQL server over the
  // network. That cost was invisible while nothing re-rendered this page on
  // demand; it stopped being invisible when the Edit Mode switch started
  // needing a server render to add or remove the restricted columns, and
  // "updating columns…" sat there for seconds.
  //
  // Nothing below reads one of these before the batch resolves, so the only
  // thing the sequence ever bought was the order they appear in the file.
  const [
    { editing: initialEditing, mayEdit },
    // Saved/published grid views ("Views ▾") — loaded for everyone; the team
    // default + shared list come from the DB, personal views live in the browser.
    { default: teamDefault, shared: sharedViews },
    distinctCustomers,
    distinctStatuses,
    // Which jobs have a schedule in the SDC Scheduler (+ its base URL), so each
    // row can show an "open in Scheduler" icon only where it leads somewhere.
    // Fail-soft: empty set when the Scheduler DB isn't configured. Independent
    // of the job query, so it has no business waiting for it.
    { baseUrl: schedulerBaseUrl, jobNumbers: schedulerJobNumbers, ssoEmail: schedulerSsoEmail },
  ] = await Promise.all([
    getProjectsEditState(),
    listSharedViews(),
    // Real job types are a fixed, known set (job-filters.ts) — no query needed.
    // Customers are open-ended, so pull the distinct list actually in use.
    prisma.job.findMany({ where: validJobTypeFilter, distinct: ["customer"], select: { customer: true } }),
    prisma.job.findMany({ where: validJobTypeFilter, distinct: ["status"], select: { status: true } }),
    getSchedulerLinkContext(),
  ]);
  // PM / Manufacturing / Warranty Engineering / Warranty Shop, shown only to a
  // role with the matching Standard Fees permission (lib/sections.ts's
  // POOL_PERMISSION) — independent of Edit Mode entirely as of 2026-08-18.
  // Standard Fees viewing and Projects editing are separate grants now (Sales
  // and ELT happen to hold both, but nothing here assumes that stays true),
  // and this can be decided once, from the role already resolved above by
  // requirePagePermission — no cookie, no server round trip when the toggle
  // flips.
  //
  // Filtered out of the columns, the phase pickers and the "Show all" switch,
  // so a hand-typed ?cols=10-111 has nothing to turn on either.
  const role = pageSession.user.role;
  const sectionAllowed = (code: string) => {
    const permission = restrictedSectionPermission(code);
    return permission === null || hasPermission(role, permission);
  };
  const visibleSections = SECTIONS.filter((s) => sectionAllowed(s.code));
  // Column show/hide — `hide` is a comma-separated list of hidden column
  // keys (absent = all shown). Drives the "Columns" dropdown.
  const hiddenCols = new Set(decodeParamList(hide ?? null));
  // ── Always true now (§40.2) ─────────────────────────────────────────────────
  // The info columns used to be dropped from the render, so toggling one was a route
  // navigation: measured at 3,330 DOM mutations and ~440ms of blocked main thread to
  // stop showing a column that was already on screen. They are always printed now and
  // hidden with one CSS rule by GridViewProvider (see lib/grid-view.ts).
  //
  // Kept as a function rather than deleted at 14 call sites: `hiddenCols` still decides
  // the SSR stylesheet and still travels in the URL for Export and saved Views, so the
  // set is load-bearing — it just no longer decides what is RENDERED. Nothing on this
  // grid derives a figure from an info column, which is why this one is safe; the
  // section-column picker (`cols`) is not and still navigates.
  const show = (_key: string) => true;
  // No `cols` param at all (first visit) defaults to every section EXCEPT the
  // ones below; an explicit (possibly empty) `cols` value means the user has
  // picked some via the phase pickers (which still list all sections).
  // Hidden by default: 10-111 (PM), 10-413 (Manufacturing), and the two
  // Warranty codes (70-211/70-411). A manager can re-enable any of them.
  // Same four codes as RESTRICTED_SECTION_CODES — a role without the matching
  // permission never sees them at all (sectionAllowed, above); a role that
  // does have it starts with them off by default, from the Sections picker.
  const DEFAULT_HIDDEN_CODES = RESTRICTED_SECTION_CODES;
  const visibleCodes = (
    cols === undefined
      ? visibleSections.filter((s) => !DEFAULT_HIDDEN_CODES.has(s.code)).map((s) => s.code)
      : decodeParamList(cols)
  ).filter(sectionAllowed); // a saved view or hand-typed ?cols= can't reopen them
  const visibleSet = new Set(visibleCodes);

  const sortKey: SortKey = SORT_KEYS.includes(sort as SortKey) ? (sort as SortKey) : "jobId";
  const sortDir = dir === "desc" ? "desc" : "asc";

  // Real job types are a fixed, known set (job-filters.ts) — no query needed.
  // The two distinct-value queries ran here; they moved into wave 1 above.
  const allTypes: string[] = [...VALID_JOB_TYPES];
  const allCustomers = distinctCustomers
    .map((j) => j.customer)
    .filter((c): c is string => Boolean(c))
    .sort((a, b) => a.localeCompare(b));

  // The canonical lifecycle first, then any legacy value still stored on a job so
  // nothing already in the data becomes unselectable. Ordered by JOB_STATUSES
  // rather than alphabetically — Active, HeadStart, Complete is the order the work
  // actually moves through, and it reads as a lifecycle instead of a word list.
  const storedStatuses = distinctStatuses.map((j) => j.status).filter((s): s is string => Boolean(s));
  const allStatuses = [
    ...JOB_STATUSES,
    ...storedStatuses.filter((s) => !JOB_STATUSES.includes(s as (typeof JOB_STATUSES)[number])).sort((a, b) => a.localeCompare(b)),
  ];

  // Same "undefined = everything, explicit (even empty) = user's picks" rule as `cols`.
  // decodeParamList, not split(",") — the writers escape commas inside each value
  // because customer names contain them; splitting raw would shred those names.
  const selectedTypes = types === undefined ? allTypes : decodeParamList(types);
  const selectedCustomers = customers === undefined ? allCustomers : decodeParamList(customers);
  // Default view (no explicit filter yet): only Active jobs and only Billable
  // work — the day-to-day view. The filter chips still list every option, so a
  // user can widen to Complete/Non-Billable any time.
  const selectedStatuses =
    statuses === undefined
      ? DEFAULT_VISIBLE_STATUSES.filter((s) => allStatuses.includes(s))
      : decodeParamList(statuses);
  const selectedBillables = billables === undefined ? ["Billable"] : decodeParamList(billables);
  const showBillable = selectedBillables.includes("Billable");
  const showNonBillable = selectedBillables.includes("Non-Billable");
  // Boolean columns have no Prisma `in` filter — translate the two checkboxes
  // into an equals/no-match condition instead (both checked = no filter at all).
  const billableWhere =
    showBillable && showNonBillable
      ? {}
      : showBillable
        ? { billable: true }
        : showNonBillable
          ? { billable: false }
          : { id: -1 }; // neither checked -> match nothing, same as an empty `in` elsewhere

  // Prisma `in` never matches NULL, so a plain customer `in` filter would
  // permanently hide any job with no Customer set — including one just added
  // on this very page (saveNewRows allows a blank Customer). With no filter
  // active, null-customer jobs must show; with a filter active they're
  // excluded like any other non-selected value.
  const customerWhere =
    customers === undefined
      ? {} // no filter -> all jobs, including customer = null
      : { customer: { in: selectedCustomers } };

  // "Dates ▾" — a range on ONE date column (ProjectsDateFilter).
  //
  // Validated, not trusted: these arrive from the query string, and an
  // unparseable value must not reach Prisma as an Invalid Date (which throws
  // and takes the whole page down with it). A bad bound is dropped, so a
  // mistyped URL narrows less rather than 500s.
  const dateColumn = sp.dateField === "complete" ? "completeDate" : "startDate";
  const parseBound = (v: string | undefined, endOfDay: boolean): Date | undefined => {
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
    const d = new Date(`${v}${endOfDay ? "T23:59:59.999" : "T00:00:00.000"}Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  // `to` covers the whole day it names — a range ending 2026-07-22 that
  // excluded jobs dated 2026-07-22 would be a trap.
  const dateFrom = parseBound(sp.from, false);
  const dateTo = parseBound(sp.to, true);
  // A job with no date in the chosen column can't satisfy a range. Prisma's
  // gte/lte already exclude NULL, so this needs no extra clause — the menu says
  // so out loud instead.
  const dateWhere =
    dateFrom || dateTo
      ? { [dateColumn]: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } }
      : {};

  const jobs = await prisma.job.findMany({
    where: {
      type: { in: selectedTypes },
      ...customerWhere,
      status: { in: selectedStatuses },
      ...billableWhere,
      ...dateWhere,
    },
    // estimatedHours carries the quoted figures this grid edits. Actual hours
    // are NOT built from the job's etcEntries any more — that join used to ride
    // along here, and it understated every closed month, because
    // EtcEntry.hoursWorked is frozen when a month closes while people keep
    // booking late time against it. actual-hours.ts owns that rule now, for this
    // grid and the Job Hour Details dashboard alike.
    include: { estimatedHours: true },
    orderBy: { [sortKey]: sortDir },
  });
  if (sortKey === "jobId") {
    // Job Id is a string column — re-sort numerically (979 before 1020 before 10000).
    jobs.sort((a, b) => (sortDir === "desc" ? -1 : 1) * compareJobIds(a.jobId, b.jobId));
  }
  // SDC's own internal projects (customer "SDC" / "Steven Douglas Corp.")
  // always sink to the very bottom, regardless of the chosen sort. This is
  // keyed on isSdcCustomer — the SAME predicate that gives them their
  // light-blue row highlight below — so ordering and highlight always agree,
  // even if a row's stored billable flag is momentarily stale. Array#sort is
  // stable, so this only reorders across the SDC / non-SDC boundary and leaves
  // each group's existing order untouched.
  jobs.sort((a, b) => Number(isSdcCustomer(a.customer)) - Number(isSdcCustomer(b.customer)));

  // Actual hours for every job on screen, in one pass rather than a join per
  // row. Keyed by internal job id.
  // Wave 3. The only query that genuinely has to wait for `jobs`.
  // getSchedulerLinkContext used to sit here too and did not — it is in wave 1
  // now, off the critical path, which matters because it crosses to another
  // MySQL server.
  const actualHours = await loadActualHoursBySection(jobs.map((j) => j.id));

  const visibleSectionsByPhase = new Map(
    PHASE_GROUPS.map((g) => [g.phase, SECTIONS.filter((s) => s.phase === g.phase && visibleSet.has(s.code))])
  );

  // Total visible data columns: for each phase, its visible sections (or just 1
  // collapsed column if every section in that phase is hidden), PLUS the two
  // grand-total columns (Engineering total + Shop total) that span all phases.
  const dataColumnCount =
    PHASE_GROUPS.reduce((sum, g) => {
      const visible = visibleSectionsByPhase.get(g.phase) ?? [];
      return sum + visible.length; // fully-hidden phases render no column
    }, 0) + 2;

  // Currently-visible section codes split by billing group — the two grand
  // totals sum exactly these, so they track the column pickers. Shop = the
  // sheet's "Shop" department band; everything else (PM/ME/CE/General
  // Engineering/Engineering) rolls into Engineering, matching the header bands.
  const visibleSectionsFlat = PHASE_GROUPS.flatMap((g) => visibleSectionsByPhase.get(g.phase) ?? []);
  const engCodes = visibleSectionsFlat.filter((s) => s.group !== "Shop").map((s) => s.code);
  const shopCodes = visibleSectionsFlat.filter((s) => s.group === "Shop").map((s) => s.code);

  return (
    // ProjectsGridView wraps the toolbar AND the grid: the info-column checkboxes read
    // the same store whose stylesheet hides the cells. Info columns only — the section
    // picker still navigates, because hiding a section changes the Eng/Shop totals.
    // See lib/projects-view.ts.
    <ProjectsGridView initialHidden={[...hiddenCols]}>
    {/* QuotedSaveForm (client) owns the <form> so the Save button can read what the
        action returned — counts on success, the message on failure. The grid below
        stays a server component, passed through as children. */}
    <QuotedSaveForm action={saveQuotedHours} className={PAGE_SHELL}>
      <SourceStaleBanner sources={["totaleto_jobs", "parts_cost_actual"]} what="The Parts Cost Actual column" />
      {/* Wraps the toolbar AND the grid: the switch, the Add/Save buttons and
          the fieldset that locks the cells all read the same client state, so
          they can never show three different opinions about the mode. */}
      <ProjectsEditModeProvider initialEditing={initialEditing} mayEdit={mayEdit}>
      <div className="mb-1 flex items-end justify-between gap-4">
        <PageTitle>Projects</PageTitle>
        <WhenEditing>
          <div className="flex items-center gap-2.5">
            {/* Edits commit on their own ~1.5s after you stop typing; Save
                stays for new rows (which autosave skips) and for anyone who
                wants to force it. */}
            <ProjectsAutosave />
            <AddProjectButton className={BUTTON_PRIMARY} />
            <SaveQuotedHoursButton />
          </div>
        </WhenEditing>
      </div>
      <p className="mb-2 text-sm text-sdc-gray-600">
        {jobs.length} jobs — quoted hours by section, quoted vs. actual cost. Click a phase to choose which section columns to show.
      </p>
      <p className="mb-5 flex items-center gap-4 text-xs text-sdc-muted">
        <span className="flex items-center gap-1.5">
          <span className="font-mono font-semibold text-sdc-blue-dark">000</span> = Quoted hours
        </span>
        <span className="text-sdc-gray-400">/</span>
        <span className="flex items-center gap-1.5">
          <span className="font-mono font-semibold text-sdc-green-text">000</span> = Actual hours
        </span>
      </p>

      {/* Toolbar, bucketed (2026-07-30). It had twelve buttons: four row
          filters, four phase pickers, Actuals, Columns, Grid Size, Views. They
          collapse into four by what they DO — filter rows, choose columns,
          change appearance, recall a saved view — with each button carrying the
          count the individual buttons used to show, so nothing became invisible.
          Filters and Sections apply on close; Display is instant (client-only). */}
      <div className="mb-5 flex flex-wrap gap-2.5">
        {/* First in the row: whether the grid is live is the one thing a user
            shouldn't have to discover by typing into it. */}
        {/* One control: Read-only <-> Editing, gated on the projects:edit
            permission (Sales/ELT) — no password. The Standard Fees columns'
            visibility is a separate, independent permission check above
            (sectionAllowed) and does not move with this switch. */}
        <ProjectsEditModeToggle />
        <ProjectsFilterMenu
          filters={[
            { key: "customers", label: "Customer", options: allCustomers, selected: selectedCustomers, searchable: true },
            { key: "types", label: "Type", options: allTypes, selected: selectedTypes },
            { key: "statuses", label: "Status", options: allStatuses, selected: selectedStatuses },
            { key: "billables", label: "Billable", options: BILLABLE_OPTIONS, selected: selectedBillables },
          ]}
        />
        {/* Next to Filters, since it narrows rows the same way — separate only
            because a date range isn't a pick-from-a-list value. */}
        <ProjectsDateFilter
          field={sp.dateField === "complete" ? "complete" : "start"}
          from={dateFrom ? sp.from! : ""}
          to={dateTo ? sp.to! : ""}
        />
        <ProjectsSectionsMenu
          phases={PHASE_GROUPS.map((g) => ({
            phase: g.phase,
            // visibleSections, not SECTIONS — the picker must not even list a
            // restricted section while locked, or the gate is only hiding
            // columns from people who don't open the menu.
            sections: visibleSections.filter((s) => s.phase === g.phase).map((s) => ({ code: s.code, name: s.name })),
          }))}
          visibleCodes={visibleCodes}
          infoColumns={[...TOGGLE_COLUMNS]}
        />
        {/* "Display ▾" is gone (§47.4). Its only remaining control was an "Actual hours
            in cells" checkbox writing the same `actuals` param the switch below now owns
            — two ways to the same view, one of them a navigation. Its density steppers
            had already gone with §45. */}
        <ProjectViewsMenu sharedViews={sharedViews} teamDefault={teamDefault} />
        {/* Downloads exactly this view — the menu forwards the page's own query string
            to /api/export/projects, which builds the WHERE clause with the same code
            this page does (lib/projects-query.ts). See §24. */}
        <ExportMenu report="projects" className={BUTTON_SECONDARY} />
        {/* Show Actuals — last, and visually a switch rather than another dropdown,
            because it is the only binary control here (§47.1).

            It replaced "Show all", which also rewrote customers/types/statuses/billables/
            cols and so quietly changed WHICH PROJECTS were listed on the way to showing
            actual hours. The rows now stay the page's default — Active + HeadStart,
            Billable — in both states (§47.3); changing scope is Filters ▾'s job, which
            offers statuses and billables explicitly. It takes no props at all now: it
            reads the one param it owns and writes it back without navigating. */}
        <ProjectsShowActualsSwitch />
      </div>

      {/* Keeps ENG/SHOP TOTAL in step with the section cells as they are typed —
          they are summed on the server, so nothing else would move them until a
          re-render. Renders nothing; it attaches one delegated listener. */}
      <ProjectsLiveTotals engCodes={engCodes} shopCodes={shopCodes} />
      {/* Puts a colleague's saved value into the one cell it belongs to, without a
          refetch and without disturbing anything the user is editing (§33.1). Until
          2026-08-04 this grid's saves announced nothing at all, and even a refetch
          could not update a cell that had ever been typed in — see
          ProjectsRemoteCells for both halves of that. */}
      <ProjectsRemoteCells />
      {/* ONE right-click menu for the whole grid — see JobCellMenuHost. It used
          to be a client component per Job cell, 2 per row. */}
      <JobCellMenuHost />
      {/* One delegated handler for every date cell — see GridDateCells. */}
      <GridDateCells />
      <ProjectsEditFieldset>
      <DragScroll scrollKey="projects-grid" className={`max-h-[calc(var(--app-vh)_-_170px)] min-w-[480px] ${GRID_SCROLLER}`}>
        {/* quiet-controls: hide the per-row dropdown chevrons (Type/Billable/
            Status) and date calendar icons until the cell is hovered/focused —
            see globals.css. Scoped to this table so other grids (Employees)
            keep their always-visible affordances. Also covers the NewProjectRows
            rows, which render into this same tbody. */}
        {/* hide-actuals: server-rendered from the `actuals` view param, so the
            grid arrives in the right state instead of painting the "/ actual"
            halves and hiding them a frame later (see globals.css). It also
            widens the quoted input back out — with the suffix gone, there's a
            whole cell for it. */}
        <table data-grid="projects" className={`quiet-controls w-full text-sm ${TABLE_GRID} ${CELL_PADDING} ${showActuals ? "" : "hide-actuals"}`}>
          <thead className="sticky top-0 z-20 bg-sdc-gray-100">
            <tr className={TABLE_HEADER_ROW}>
              <th rowSpan={3} className="frozen-col sticky left-0 z-10 w-8 min-w-8 bg-sdc-gray-100 px-1 py-2 text-center align-bottom">
                #
              </th>
              <th rowSpan={3} className="frozen-col sticky left-8 z-10 w-20 min-w-20 max-w-20 overflow-hidden truncate bg-sdc-gray-100 px-2 py-2 align-bottom">
                <SortButton sortKey="jobId" label="Job Id" currentSort={sortKey} currentDir={sortDir} />
              </th>
              {show("job") && (
                <th data-col="job"
                  rowSpan={3}
                  style={{ width: "var(--job-col-width, 280px)", minWidth: "var(--job-col-width, 280px)" }}
                  className="frozen-col frozen-col-last sticky left-[7rem] z-10 border-l border-r border-sdc-border bg-sdc-gray-100 px-2 py-2 align-bottom"
                >
                  Job
                  <div
                    className="col-resize-handle absolute right-0 inset-y-0 z-10 w-3"
                    data-resize-var="--job-col-width"
                    data-resize-min="160"
                    data-resize-max="640"
                    title="Drag to resize"
                    style={{ touchAction: "none" }}
                  />
                </th>
              )}
              {show("customer") && (
                <th data-col="customer"
                  rowSpan={3}
                  style={{ width: "var(--customer-col-width, 120px)", minWidth: "var(--customer-col-width, 120px)" }}
                  className="relative px-2 py-2 align-bottom"
                >
                  Customer
                  <div
                    className="col-resize-handle absolute right-0 inset-y-0 z-10 w-3"
                    data-resize-var="--customer-col-width"
                    data-resize-min="80"
                    data-resize-max="400"
                    title="Drag to resize"
                    style={{ touchAction: "none" }}
                  />
                </th>
              )}
              {show("type") && (
                <th data-col="type"
                  rowSpan={3}
                  style={{ width: "var(--type-col-width, 90px)", minWidth: "var(--type-col-width, 90px)" }}
                  className="relative px-1 py-2 align-bottom"
                >
                  Type
                  <div
                    className="col-resize-handle absolute right-0 inset-y-0 z-10 w-3"
                    data-resize-var="--type-col-width"
                    data-resize-min="60"
                    data-resize-max="300"
                    title="Drag to resize"
                    style={{ touchAction: "none" }}
                  />
                </th>
              )}
              {show("billable") && (
                <th data-col="billable"
                  rowSpan={3}
                  style={{ width: "var(--billable-col-width, 110px)", minWidth: "var(--billable-col-width, 110px)" }}
                  className="relative px-1 py-2 align-bottom"
                >
                  Billable
                  <div
                    className="col-resize-handle absolute right-0 inset-y-0 z-10 w-3"
                    data-resize-var="--billable-col-width"
                    data-resize-min="70"
                    data-resize-max="300"
                    title="Drag to resize"
                    style={{ touchAction: "none" }}
                  />
                </th>
              )}
              {show("status") && (
                <th data-col="status"
                  rowSpan={3}
                  style={{ width: "var(--status-col-width, 100px)", minWidth: "var(--status-col-width, 100px)" }}
                  className="relative px-1 py-2 align-bottom"
                >
                  <SortButton sortKey="status" label="Status" currentSort={sortKey} currentDir={sortDir} />
                  <div
                    className="col-resize-handle absolute right-0 inset-y-0 z-10 w-3"
                    data-resize-var="--status-col-width"
                    data-resize-min="70"
                    data-resize-max="300"
                    title="Drag to resize"
                    style={{ touchAction: "none" }}
                  />
                </th>
              )}
              {show("startDate") && (
                <th data-col="startDate"
                  rowSpan={3}
                  style={{ width: "var(--startdate-col-width, 92px)", minWidth: "var(--startdate-col-width, 92px)" }}
                  className="relative px-1 py-2 align-bottom"
                >
                  <SortButton sortKey="startDate" label={"Start\nDate"} currentSort={sortKey} currentDir={sortDir} />
                  <div
                    className="col-resize-handle absolute right-0 inset-y-0 z-10 w-3"
                    data-resize-var="--startdate-col-width"
                    data-resize-min="65"
                    data-resize-max="300"
                    title="Drag to resize"
                    style={{ touchAction: "none" }}
                  />
                </th>
              )}
              {show("completeDate") && (
                <th data-col="completeDate"
                  rowSpan={3}
                  style={{ width: "var(--completedate-col-width, 92px)", minWidth: "var(--completedate-col-width, 92px)" }}
                  className="relative px-1 py-2 align-bottom"
                >
                  <SortButton sortKey="completeDate" label={"Complete\nDate"} currentSort={sortKey} currentDir={sortDir} />
                  <div
                    className="col-resize-handle absolute right-0 inset-y-0 z-10 w-3"
                    data-resize-var="--completedate-col-width"
                    data-resize-min="65"
                    data-resize-max="300"
                    title="Drag to resize"
                    style={{ touchAction: "none" }}
                  />
                </th>
              )}
              {PHASE_GROUPS.map((g) => {
                const visible = visibleSectionsByPhase.get(g.phase) ?? [];
                const color = PHASE_HEADER_COLOR[g.phase] ?? "bg-sdc-blue-light";
                // A phase with no visible sections renders no column at all
                // (e.g. Warranty, hidden by default) — re-enable a section via
                // its phase picker to bring the column back.
                return visible.length ? (
                  <th
                    key={g.phase}
                    colSpan={visible.length}
                    className={`border-l border-sdc-border px-2 py-2 text-center italic ${color}`}
                  >
                    {g.phase}
                  </th>
                ) : null;
              })}
              <th
                rowSpan={3}
                style={DATA_COL_STYLE}
                className="border-l border-sdc-border bg-sdc-blue-light px-2 py-2 text-center align-bottom text-note leading-tight text-sdc-blue-dark"
              >
                ENG
                <span className="block font-semibold">TOTAL</span>
              </th>
              <th
                rowSpan={3}
                style={DATA_COL_STYLE}
                className="border-l border-sdc-border bg-sdc-blue-light px-2 py-2 text-center align-bottom text-note leading-tight text-sdc-blue-dark"
              >
                SHOP
                <span className="block font-semibold">TOTAL</span>
              </th>
              {/* ONE "Parts Cost" column (merged 2026-08-11 — used to be
                  "Parts Cost Quoted" / "Parts Cost Actual" as two separate
                  columns, renamed from "Cost Quoted" / "Actual Cost" on
                  2026-08-03). The pair now rides inside this one column the
                  same way the section-hours columns already do — quoted
                  first, "/ actual" second, the second half hidden by
                  `.hide-actuals` — instead of "Actual" being its own
                  always-there `<th>`/`<td>` pair. See the body cell below and
                  globals.css's `.parts-cost-quoted`/`.actual-suffix` rules.
                  The columns are still Job.costQuoted and
                  Job.costActualHistorical in the schema, in the TotalETO sync
                  and in the Power BI measures they come from, so don't rename
                  those chasing this merge either. */}
              <th rowSpan={3} className={`${PARTS_COST_COL_CLASS} border-l border-sdc-border bg-sdc-green-bg px-1 py-2 text-left align-bottom text-sdc-green-text`}>
                PARTS COST
              </th>
            </tr>
            <tr className={TABLE_HEADER_ROW}>
              {PHASE_GROUPS.flatMap((g) => {
                const sections = visibleSectionsByPhase.get(g.phase) ?? [];
                if (!sections.length) return [];
                const groupHeaders = groupRuns(sections).map((run, i) => (
                  <th
                    key={`${g.phase}-group-${i}`}
                    colSpan={run.count}
                    // The visible text below is abbreviateLabel(run.group); the tooltip
                    // is always the full canonical name it was abbreviated FROM, so
                    // there is no separate full-name table to keep in sync.
                    title={run.group}
                    className={`qc border-l border-sdc-border px-1 py-1.5 text-center text-label italic ${
                      GROUP_HEADER_COLOR[run.group] ?? ""
                    }`}
                  >
                    {abbreviateLabel(run.group)}
                  </th>
                ));
                return groupHeaders;
              })}
            </tr>
            <tr className={TABLE_HEADER_ROW}>
              {PHASE_GROUPS.flatMap((g) => {
                const sections = visibleSectionsByPhase.get(g.phase) ?? [];
                // `break-normal` here is not a leftover: globals.css sets exactly
                // that on every `th` on purpose ("the fix is always a wider column,
                // a shorter label or a smaller font, never a broken word"), and a
                // label that outgrows its column is meant to overflow visibly and
                // get reported rather than be silently mangled into "DR AWI NGS".
                //
                // 2026-08-24: it WAS reported. HMI/Robot/Vision/Device Programming
                // all overflowed into each other, because "PROGRAMMING" alone is
                // wider than the 72px content box and cannot break. Fixed the way
                // that comment prescribes — a shorter label — via abbreviateLabel,
                // the same render-time abbreviation the group band one row above
                // has always used (line ~835). The underlying s.name is untouched,
                // so every logic key, filter param and colour map still sees the
                // full string; only this cell renders short.
                //
                // Also shortens Mechanical/Electrical Build to Mech/Elec Build,
                // which now fit on one line instead of wrapping to two, and General
                // to Gen — matching the "MECH ENG"/"GEN ENG" bands above them.
                // The full name stays available in the tooltip.
                return sections.map((s) => (
                  <th key={s.code} title={`${s.name} · ${s.code}`} style={DATA_COL_STYLE} className="qc break-normal border-l border-sdc-border px-1 py-2 text-center text-label leading-tight">
                    {abbreviateLabel(s.name)}
                    <span className="block font-mono text-label font-normal normal-case tracking-normal text-sdc-gray-400">
                      {s.code}
                    </span>
                  </th>
                ));
              })}
            </tr>
          </thead>
          <tbody>
            <WhenEditing>
            <NewProjectRows
              hidden={[...hiddenCols]}
              phaseGroups={PHASE_GROUPS.map((g) => ({ phase: g.phase, sections: visibleSectionsByPhase.get(g.phase) ?? [] }))}
              allStatuses={allStatuses}
            />
            </WhenEditing>
            {jobs.length === 0 && (
              <tr>
                {/* 2 always-on (# + Job Id) + visible toggle columns + phase cols + 1 cost col (merged 2026-08-11) */}
                <td colSpan={2 + TOGGLE_COLUMNS.filter((c) => show(c.key)).length + dataColumnCount + 1} className="px-4 py-5 text-center text-sdc-gray-400">
                  No jobs found.
                </td>
              </tr>
            )}
            {jobs.map((job, i) => {
              const hoursBySection = new Map(job.estimatedHours.map((eh) => [eh.section, eh.quotedHours]));
              // Actual hours to date, per section — one shared definition, see
              // actual-hours.ts. Empty map for a job with no hours at all.
              const actualBySection = actualHours.get(job.id) ?? EMPTY_ACTUALS;
              // SDC's own internal projects are always non-billable and get a
              // permanent light-blue highlight so they stand out from customer
              // work at a glance — this is driven by Customer, not the stored
              // billable flag, so it's correct even before the next save.
              const isSdc = isSdcCustomer(job.customer);
              const tone = scheduleTone(job);
              const zebra = isSdc ? "bg-[#caedfb]" : i % 2 === 1 ? "bg-sdc-gray-50/60" : "";
              const zebraSticky = isSdc ? "bg-[#caedfb]" : i % 2 === 1 ? "bg-sdc-gray-50" : "bg-white";
              // Same over/under rule the section-hour cells use (lib/quoted-tone.ts),
              // reused rather than a threshold system of Parts Cost's own — "actual has
              // passed quoted" reads the same red/complete-green/running-yellow whether
              // the two numbers are hours or dollars. Like those cells (and unlike the
              // plain identity columns), this REPLACES the row's zebra stripe rather than
              // combining with it — see the merged Parts Cost <td> below.
              const partsCostTone = quotedCellTone({
                quoted: job.costQuoted != null ? Number(job.costQuoted) : 0,
                actual: job.costActualHistorical != null ? Number(job.costActualHistorical) : 0,
                jobComplete: job.status === "Complete",
              });
              // Hover comes from `tbody tr:hover > td` in globals.css, not a row
              // background — see the note on the ETC grid's <tr>. This grid has
              // the same per-cell fills (the SDC-customer blue, the schedule
              // tones), so a <tr> background painted behind them double-tinted
              // the plain cells and missed the rest.
              return (
                <tr key={job.id} className={zebra}>
                  <td className={`frozen-col sticky left-0 z-10 w-8 min-w-8 overflow-hidden px-1 py-1.5 text-center align-middle text-label whitespace-nowrap text-sdc-gray-400 ${zebraSticky}`}>
                    {i + 1}
                  </td>
                  {/* Left-click keeps its direct Job Hour Details link (this
                      column's long-standing behavior); right-click adds the same
                      menu the Job cell has, so the Scheduler is reachable here
                      too. */}
                  {/* A plain <td> now: the right-click menu is one delegated
                      listener (JobCellMenuHost) rather than a client component
                      per cell. */}
                  <td
                    {...jobCellMenuProps({
                      jobId: job.jobId,
                      jobName: job.jobName,
                      schedulerUrl: schedulerJobNumbers.has(job.jobId) ? schedulerScheduleUrl(schedulerBaseUrl, job.jobId, schedulerSsoEmail) : null,
                    })}
                    title={`Open ${job.jobId} in Job Details — right-click for more`}
                    className={`frozen-col sticky left-8 z-10 w-20 min-w-20 max-w-20 overflow-hidden truncate px-2 py-1.5 text-center font-mono text-label ${zebraSticky}`}
                  >
                    <Link
                      href={`/job-hours?jobs=${encodeURIComponent(job.jobId)}`}
                      title={tone.title}
                      className={`hover:underline ${tone.weight || "font-semibold"} ${tone.color || "text-sdc-blue-dark"}`}
                    >
                      {job.jobId}
                    </Link>
                  </td>
                  {show("job") && (
                    // The Job Hour Details / Scheduler icon-links that used to
                    // sit here moved into the right-click menu — same two
                    // destinations, without an icon pair on every row.
                    <td data-col="job"
                      {...jobCellMenuProps({
                        jobId: job.jobId,
                        jobName: job.jobName,
                        schedulerUrl: schedulerJobNumbers.has(job.jobId) ? schedulerScheduleUrl(schedulerBaseUrl, job.jobId, schedulerSsoEmail) : null,
                      })}
                      title={`${job.jobName} — right-click for options`}
                      style={{ width: "var(--job-col-width, 280px)", minWidth: "var(--job-col-width, 280px)" }}
                      className={`frozen-col frozen-col-last sticky left-[7rem] z-10 overflow-hidden border-l border-r border-sdc-border px-2 py-1.5 text-left align-middle text-label font-medium whitespace-nowrap text-sdc-navy ${zebraSticky}`}
                    >
                      <div className="flex min-h-[14px] min-w-0 items-center gap-1">
                        <input
                          type="text"
                          name={`jobField__${job.id}__jobName`}
                          data-remote-adopt=""
                          defaultValue={job.jobName}
                          data-baseline={job.jobName}
                          aria-label={`Job Name, ${job.jobName}`}
                          title={tone.title}
                          className={`w-full min-w-0 flex-1 text-left ${tone.weight} ${tone.color}`}
                        />
                      </div>
                    </td>
                  )}
                  {show("customer") && (
                    <td data-col="customer"
                      style={{ width: "var(--customer-col-width, 120px)", minWidth: "var(--customer-col-width, 120px)", maxWidth: "var(--customer-col-width, 120px)" }}
                      className="overflow-hidden whitespace-nowrap px-2 py-1.5 text-left align-middle text-label text-sdc-gray-600"
                      title={job.customer ?? ""}
                    >
                      <input
                        type="text"
                        name={`jobField__${job.id}__customer`}
                        data-remote-adopt=""
                        defaultValue={job.customer ?? ""}
                        data-baseline={job.customer ?? ""}
                        placeholder="—"
                        aria-label={`Customer, ${job.jobName}`}
                        className="w-full text-left"
                      />
                    </td>
                  )}
                  {show("type") && (
                    <td data-col="type"
                      style={{ width: "var(--type-col-width, 90px)", minWidth: "var(--type-col-width, 90px)", maxWidth: "var(--type-col-width, 90px)" }}
                      className="overflow-hidden whitespace-nowrap px-1 py-1.5 text-center align-middle text-label text-sdc-gray-600"
                    >
                      <select
                        name={`jobField__${job.id}__type`}
                        data-remote-adopt=""
                        defaultValue={job.type ?? ""}
                        data-baseline={job.type ?? ""}
                        aria-label={`Type, ${job.jobName}`}
                        className="text-center"
                      >
                        {job.type == null && <option value="">—</option>}
                        {VALID_JOB_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  {show("billable") && (
                    <td data-col="billable"
                      style={{ width: "var(--billable-col-width, 110px)", minWidth: "var(--billable-col-width, 110px)", maxWidth: "var(--billable-col-width, 110px)" }}
                      className="overflow-hidden whitespace-nowrap px-1 py-1.5 text-center align-middle text-label"
                    >
                      {isSdc ? (
                        <span className="text-sdc-muted" aria-label={`Billable, ${job.jobName}`} title="SDC's own projects are always non-billable">
                          Non-Billable
                        </span>
                      ) : (
                        <select
                          name={`jobField__${job.id}__billable`}
                          data-remote-adopt=""
                          defaultValue={job.billable ? "Billable" : "Non-Billable"}
                          data-baseline={job.billable ? "Billable" : "Non-Billable"}
                          aria-label={`Billable, ${job.jobName}`}
                          className={`text-center ${job.billable ? "text-sdc-green-text" : "text-sdc-muted"}`}
                        >
                          <option value="Billable">Billable</option>
                          <option value="Non-Billable">Non-Billable</option>
                        </select>
                      )}
                    </td>
                  )}
                  {show("status") && (
                    <td data-col="status"
                      style={{ width: "var(--status-col-width, 100px)", minWidth: "var(--status-col-width, 100px)", maxWidth: "var(--status-col-width, 100px)" }}
                      className={`overflow-hidden whitespace-nowrap px-1 py-1.5 text-center align-middle text-label font-medium ${
                        job.status === "Complete"
                          ? "text-sdc-green-text"
                          : job.status === "HeadStart"
                            ? // Amber: intent to start, nothing authorised yet.
                              "text-sdc-yellow-text"
                            : "text-sdc-blue-dark"
                      }`}
                    >
                      <select
                        name={`jobField__${job.id}__status`}
                        data-remote-adopt=""
                        defaultValue={job.status}
                        data-baseline={job.status}
                        aria-label={`Status, ${job.jobName}`}
                        className="text-center"
                      >
                        {allStatuses.map((st) => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  {show("startDate") && (
                    <td data-col="startDate"
                      style={{ width: "var(--startdate-col-width, 92px)", minWidth: "var(--startdate-col-width, 92px)", maxWidth: "var(--startdate-col-width, 92px)" }}
                      className="overflow-hidden whitespace-nowrap px-1 py-1.5 text-left align-middle text-label text-sdc-muted"
                    >
                      <input
                        {...dateCellProps({
                          name: `jobField__${job.id}__startDate`,
                          defaultValue: dateInputValue(job.startDate),
                          ariaLabel: `Start Date, ${job.jobName}`,
                        })}
                      />
                    </td>
                  )}
                  {show("completeDate") && (
                    <td data-col="completeDate"
                      style={{ width: "var(--completedate-col-width, 92px)", minWidth: "var(--completedate-col-width, 92px)", maxWidth: "var(--completedate-col-width, 92px)" }}
                      className="overflow-hidden whitespace-nowrap px-1 py-1.5 text-left align-middle text-label text-sdc-muted"
                    >
                      <input
                        {...dateCellProps({
                          name: `jobField__${job.id}__completeDate`,
                          defaultValue: dateInputValue(job.completeDate),
                          ariaLabel: `Complete Date, ${job.jobName}`,
                        })}
                      />
                    </td>
                  )}
                  {PHASE_GROUPS.map((g) => {
                    const visibleSections = visibleSectionsByPhase.get(g.phase) ?? [];
                    // Fully-hidden phase (e.g. Warranty) renders no column.
                    if (!visibleSections.length) return null;
                    return (
                      <Fragment key={g.phase}>
                        {visibleSections.map((s) => {
                          const hours = hoursBySection.get(s.code);
                          const actual = actualBySection.get(s.code) ?? 0;
                          // Over/under coloring vs quoted, gated by job status:
                          //  actual > quoted -> red (over); else completed -> green;
                          //  else (active, at/under quoted) -> yellow. Cells with
                          //  neither a quote nor an actual stay neutral.
                          const q = hours != null ? Number(hours) : 0;
                          // Shared with the live recompute in ProjectsLiveTotals —
                          // see lib/quoted-tone.ts.
                          const tone = quotedCellTone({ quoted: q, actual, jobComplete: job.status === "Complete" });
                          return (
                            <td
                              key={s.code}
                              // data-cell-actual lets ProjectsLiveTotals recompute
                              // this cell's over/under tone as the quoted number
                              // (or the row's Status) is edited. The rule lives in
                              // lib/quoted-tone.ts so the server class below and
                              // the live one can't drift.
                              data-cell-actual={actual}
                              style={DATA_COL_STYLE}
                              className={`qc quoted-actual-cell overflow-hidden border-l border-sdc-border px-1 py-1.5 text-center align-middle font-mono text-label whitespace-nowrap text-sdc-gray-600 ${tone}`}
                              title={`Quoted ${exactHours(hours) ?? "0"} / Actual ${exactHours(actual) ?? "0"}`}
                            >
                              <input
                                type="number"
                                step="1"
                                min="0"
                                name={`quoted__${job.id}__${s.code}`}
                                data-remote-adopt=""
                                defaultValue={hours != null ? Math.round(Number(hours)).toString() : ""}
                                data-baseline={hours != null ? Math.round(Number(hours)).toString() : ""}
                                placeholder="—"
                                aria-label={`Quoted hours, ${job.jobName}, ${s.name}`}
                                className="text-center font-semibold text-sdc-blue-dark"
                              />
                              {/* "quoted / actual" — the pair, whenever Show Actuals is on
                                  (§50). It rides INSIDE the quoted cell rather than in a
                                  column of its own, which is what keeps the grid's column
                                  count (and the phase header colSpans) identical in both
                                  states.
                                  The separator is its own element so `.hide-actuals` takes
                                  it away with the figure it belongs to; a bare "/" text
                                  node would be stranded there. */}
                              <span className="actual-suffix text-sdc-muted">
                                <span className="actual-sep">/</span>
                                <span className="font-semibold text-sdc-green-text">{wholeHours(actual)}</span>
                              </span>
                            </td>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                  {(() => {
                    // Two grand totals — Engineering and Shop — each summing the
                    // currently-visible sections in that billing group. The
                    // "/ actual" half uses the same .actual-suffix hook as the
                    // section cells, so it hides when Actuals is toggled off.
                    const sumQ = (codes: string[]) => codes.reduce((s, c) => s + Number(hoursBySection.get(c) ?? 0), 0);
                    const sumA = (codes: string[]) => codes.reduce((s, c) => s + (actualBySection.get(c) ?? 0), 0);
                    // data-total / data-job / data-total-quoted are the hooks
                    // ProjectsLiveTotals writes through: these two figures are
                    // summed here on the server, so without it the total would
                    // ignore the number you just typed into the cell beside it
                    // until something re-rendered the route. data-actual carries
                    // the un-editable half so the component can rebuild the
                    // tooltip without re-deriving it.
                    const cell = (label: string, kind: "eng" | "shop", codes: string[]) => {
                      const q = sumQ(codes);
                      const a = sumA(codes);
                      // Same rule as a section cell, over the billing group's SUMMED
                      // quoted/actual rather than one section's — no separate meaning
                      // for a total, just the same red/green/yellow/none over the
                      // bigger numbers. Kept in step live by ProjectsLiveTotals.
                      const tone = quotedCellTone({ quoted: q, actual: a, jobComplete: job.status === "Complete" });
                      return (
                        <td
                          data-total={kind}
                          data-job={job.id}
                          data-actual={exactHours(a) ?? "0"}
                          style={DATA_COL_STYLE}
                          className={`overflow-hidden whitespace-nowrap border-l border-sdc-border px-1 py-1.5 text-center align-middle font-mono text-label font-medium ${tone}`}
                          title={`${label} — Quoted ${exactHours(q) ?? "0"} / Actual ${exactHours(a) ?? "0"}`}
                        >
                          <span data-total-quoted className="font-semibold text-sdc-blue-dark">{wholeHours(q)}</span>
                          <span className="actual-suffix text-sdc-muted"><span className="actual-sep"> /</span><span className="font-semibold text-sdc-green-text"> {wholeHours(a)}</span></span>
                        </td>
                      );
                    };
                    return (
                      <>
                        {cell("Engineering", "eng", engCodes)}
                        {cell("Shop", "shop", shopCodes)}
                      </>
                    );
                  })()}
                  {/* "Parts Cost Quoted / Parts Cost Actual" — ONE cell, same
                      pattern as the section-hours cells above: quoted first
                      (blue, matching the hours input's text-sdc-blue-dark),
                      "/ actual" second inside `.actual-suffix` (green,
                      matching the hours span's text-sdc-green-text) —
                      `.hide-actuals` already hides that half generically
                      (globals.css) with no new rule needed. The background is
                      `partsCostTone`, the SAME quotedCellTone() call the
                      section-hour and ENG/SHOP-total cells use, over the
                      dollar figures instead of hours — so it REPLACES the
                      row's zebra stripe rather than combining with it, same
                      as those cells (an empty tone still lets zebra show
                      through, since the cell then has no bg class of its
                      own). What hours DIDN'T need and this does: both halves
                      are independently-editable MoneyCells (Parts Cost Actual
                      is a manager-typed figure, not a read-only computed span
                      like Actual Hours is), each pinned to a modest fixed
                      width via MONEY_INPUT_PAIRED so the two can sit side by
                      side without each fighting the other for the row's full
                      width — widened back to the cell's full width by
                      `.hide-actuals .parts-cost-quoted` when there's only one
                      figure to show. */}
                  <td className={`${PARTS_COST_COL_CLASS} overflow-hidden whitespace-nowrap border-l border-sdc-border px-1 py-1.5 text-left align-middle text-label font-medium ${partsCostTone}`}>
                    <span className="parts-cost-quoted inline-flex items-center gap-0.5 text-sdc-blue-dark">
                      <span>$</span>
                      <MoneyCell
                        name={`jobField__${job.id}__costQuoted`}
                        defaultValue={job.costQuoted != null ? Number(job.costQuoted).toString() : ""}
                        ariaLabel={`Parts Cost Quoted, ${job.jobName}`}
                        className={MONEY_INPUT_PAIRED}
                      />
                    </span>
                    <span className="actual-suffix inline-flex items-center gap-0.5 text-sdc-green-text">
                      <span className="actual-sep text-sdc-muted">/</span>
                      <span>$</span>
                      <MoneyCell
                        name={`jobField__${job.id}__costActualHistorical`}
                        defaultValue={job.costActualHistorical != null ? Number(job.costActualHistorical).toString() : ""}
                        ariaLabel={`Parts Cost Actual, ${job.jobName}`}
                        className={MONEY_INPUT_PAIRED}
                        maxFractionDigits={0}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DragScroll>
      </ProjectsEditFieldset>
      </ProjectsEditModeProvider>
    </QuotedSaveForm>
    </ProjectsGridView>
  );
}


// -- Route entry point --
//
// The page's body lives in `ProjectsView` above so that BOTH this route and the split
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
export default async function QuotedPage({ searchParams }: { searchParams: Promise<{
    cols?: string;
    sort?: string;
    dir?: string;
    customers?: string;
    types?: string;
    statuses?: string;
    billables?: string;
    hide?: string;
    view?: string;
    actuals?: string;
    // "Dates ▾" — which date column to filter on, and the range.
    dateField?: string;
    from?: string;
    to?: string;
  }> }) {
  return <ProjectsView params={await searchParams} />;
}
