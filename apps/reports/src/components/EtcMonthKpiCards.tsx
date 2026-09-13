"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { usd, hours as fmtHours } from "@/components/ui/format";
import { HoursDetailPanel } from "@/components/HoursDetailPanel";
import { UndefinedHoursPanel } from "@/components/UndefinedHoursPanel";
// The KPI row itself — extracted (unchanged) so the T&M tab's own summary can use the
// identical row instead of a second, driftable copy. See that file's header note.
import { MemoKpiRow } from "@/components/ui/KpiRow";
// The drill card's height ceiling and its one scrolling region (§49). The two panels
// below are hand-rolled rather than DrillPanel, so they read the same two classes the
// shared panel does — the alternative is four opinions about how tall a drill may be.
import { DRILL_BODY, DRILL_CAP, DrillControls, DrillFilterRow, DrillGroupOption, DrillGroupTray } from "@/components/ui/Drill";
// The shared filter model (§73). These two drills had NO filters — the requirement is
// filters "beside the existing Group By options" in every Monthly ETC drill-through, and
// these are the two that had neither.
import { matchesDrillFilters } from "@/lib/drill-filters";
import { useDrillFilters } from "@/components/useDrillFilters";
import { useColumnSort } from "@/components/useColumnSort";
import { SortableTh } from "@/components/ui/SortableHeader";
import { sortRows, type SortColumns } from "@/lib/table-sort";
import { ETC_SECTIONS } from "@/lib/sections";
import { compareSections, offGridBySection, sectionName, type OffGridJob, type OffGridSection } from "@/lib/off-grid-hours";
import type { EtcMonthKpis } from "@/lib/etc-month-kpis";
// The strip's CONTENT — which blocks exist, what each one says, which drill it opens —
// is a pure function of the reconciled figures (§37). See the header note there for why
// it is not inline JSX any more.
import {
  buildKpiBlocks,
  kpiDetailState,
  offGridTotalHours,
  KPI_GRID_CLASS,
  type DrillScope,
} from "@/lib/etc-kpi-strip";
import type { JobHoursDetail } from "@/lib/job-hours-detail";
import type { UnattributedDetail } from "@/lib/unattributed-hours";
import { loadUnattributedDetail } from "@/lib/unattributed-actions";
import { loadEtcMonthHoursDetail, loadPartsSpentDetail, loadJobPartsLines } from "@/lib/hours-detail-actions";
import type { PartsSpentDetail, PartsSpentRow } from "@/lib/parts-spent";
import type { JobPartsCost, PartsCostLine } from "@/lib/sync-totaleto";
import { readKpiStripOpen, writeKpiStripOpen, subscribeKpiStrip } from "@/lib/kpi-strip-pref";
import { subscribeKpiDrillRequest, readKpiDrillRequest, serverKpiDrillRequest } from "@/lib/etc-drill-request";
// Newest-wins ordering and in-flight de-duplication for every drill fetch below
// (§32.2). Replaces four hand-rolled request-id refs that each got the ordering
// right and the DUPLICATION wrong — see the note on the fetch effects.
import { sequenced } from "@/lib/request-sequence";
import { useEtcLiveTotals } from "@/lib/etc-live-totals";
// varianceTooltip is no longer imported here: the Parts tooltip is built where the block
// is built (lib/etc-kpi-strip.ts), which is what stops this component from having an
// opinion about which figures the sentence should quote.
import { reconcileEtcKpis, rollupLiveTotals } from "@/lib/etc-kpi-live";
// A completed refresh publishes through this feed, which is how the drill caches below
// learn that their sources have moved — including when somebody else started it.
import { useRealtimeChanges } from "@/components/RealtimeProvider";

// Section code -> billing group, so the drill can be narrowed to the card that
// opened it. Same mapping the grid's column bands and the KPI totals use, from
// the same source, so "Engineering" means the identical set of sections in the
// card, the grid and the drill.
const SECTION_GROUP = new Map(ETC_SECTIONS.map((s) => [s.code, s.billingGroup]));

// The formatters the blocks are built with. Module-level and frozen, so building the
// strip cannot depend on anything that changes per render.
const KPI_FORMAT = { hours: fmtHours, usd } as const;

// ── Column maps for the four sortable regions on this page ──────────────────
//
// Module-level constants: every accessor closes over nothing but the row itself, so
// there is nothing to recompute per render. See table-sort.ts for the mechanism these
// feed — one shared sort, applied here exactly as it is in HoursDetailPanel/
// UndefinedHoursPanel.

const PARTS_ROW_COLUMNS: SortColumns<PartsSpentRow, "job" | "spent"> = {
  job: { type: "id", value: (r) => r.jobId },
  spent: { type: "currency", value: (r) => r.spent },
};

const PARTS_LINE_COLUMNS: SortColumns<PartsCostLine, "po" | "invoiced" | "supplier" | "part" | "qty" | "unit" | "amount"> = {
  po: { type: "id", value: (l) => l.poNumber },
  invoiced: { type: "date", value: (l) => l.invoicedDate },
  supplier: { type: "text", value: (l) => l.supplier },
  part: { type: "text", value: (l) => l.partNumber ?? l.description },
  qty: { type: "number", value: (l) => l.quantity },
  unit: { type: "currency", value: (l) => l.unitPrice },
  amount: { type: "currency", value: (l) => l.invoicedAmount },
};

// The "Sections" (by-job) and "Jobs" (by-section) columns are deliberately left out —
// each cell holds a variable-length LIST with no single scalar to compare, unlike every
// other column here.
const OFF_GRID_JOB_COLUMNS: SortColumns<OffGridJob, "job" | "status" | "hours"> = {
  job: { type: "id", value: (j) => j.jobId },
  status: { type: "status", value: (j) => j.status },
  hours: { type: "hours", value: (j) => j.hours },
};

const OFF_GRID_SECTION_COLUMNS: SortColumns<OffGridSection, "section" | "hours"> = {
  section: { type: "text", value: (s) => s.name ?? s.section },
  hours: { type: "hours", value: (s) => s.hours },
};

// ── How a parts row answers the two filter dimensions (§73) ──────────────────
//
// Module-level, so the option list and the predicate are guaranteed to produce the same
// string for the same row. A filter whose menu says "1105 — Foo" and whose predicate
// compares against "1105" matches nothing and looks like an empty month.
function partsJobLabel(r: { jobId: string; jobName: string }): string {
  return `${r.jobId} — ${r.jobName}`;
}
// "Status" for a parts row is whether anybody has actually decided its New ETC — the
// `decided` flag PartsSpentRow already carries for the same reason (an undecided cell
// contributes 0 to the variance, and the panel must not print a figure nobody chose).
function partsStatus(decided: boolean): string {
  return decided ? "Entered" : "Not entered";
}

// Re-exported so the page's existing `import type { OffGridJob }` keeps working; the
// type and the rollup both live in lib/off-grid-hours.ts now, where a plain test can
// reach them (this component imports a "use server" action, which one cannot).
export type { OffGridJob };

// KPI strip at the top of the Monthly ETC page: hours worked and variance for
// Engineering and Shop, parts money spent, and how many people booked time —
// with a drill-through to the punch detail behind the headcount.
//
// Every hours figure comes from the SAME EtcEntry rows the grid's grand-total row
// sums, with the same effective-New-ETC rule (see getEtcMonthKpis), so a card can
// never contradict the total at the bottom of the table. The people counts and
// the drill come from the punch-level rows, which is the same source those totals
// were built from.
//
// Diff keeps the grid's sign convention: Hours Left − New ETC, so POSITIVE means
// the New ETC is under what's left (green) and negative means over (red). Getting
// that backwards here while the grid had it right would be worse than not showing
// it at all.

// ── The summary's expand/collapse control (2026-09-02) ──────────────────────
//
// Was the words "Hide summary" / "Show summary", set in the app's muted label size
// with a dotted underline. It worked, and nobody could find it: at 10px in the same
// grey as every other caption on the page, beside a month title in the same grey, it
// read as part of the card's chrome rather than as the one thing in that header you
// can press.
//
// A chevron instead — up when the summary is open, down when it is away, which is the
// one collapse idiom nobody has to learn. The glyph is this codebase's own: the same
// `M4 9 L8 5 L12 9` path SortableHeader and the drill caret already use, rotated
// rather than swapped for the other direction, per drill-design.test.ts's rule that
// "the caret rotates rather than swapping glyph". A second chevron drawn a second way
// would be one more thing to keep in step.
//
// ── An icon alone is not an affordance ─────────────────────────────────────
//
// So it gets all three: a hover tooltip (`title`), a real accessible name that states
// the ACTION and changes with state ("Hide summary" open, "Show summary" collapsed —
// not "summary", which tells a screen-reader user nothing about what pressing it
// does), and a bordered ghost button that reads as pressable at rest. It is a real
// <button>, so Enter and Space work and the focus ring is the browser's own — nothing
// here reimplements either.
//
// Fixed square geometry, which also retires a workaround: the old control reserved
// `min-w-[6.5rem]` because "Hide summary" and "Show summary" are different widths and
// it walked left and right as you used it (§36.14). An icon that only rotates cannot
// change width, so there is nothing left to reserve.
//
// 1.6rem, the same size the zoom stepper in the sidebar settled on and for the same
// reason: this sits inside the zoomed subtree (§45), so at the 50% floor it renders
// 12 device px. Measured at 1.4rem first — 13.4px at the default 0.8 zoom — which is
// under any reasonable target size for something people are meant to find easily.
function SummaryToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const label = open ? "Hide summary" : "Show summary";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={label}
      title={label}
      className="motion-interactive inline-flex h-[1.6rem] w-[1.6rem] shrink-0 items-center justify-center rounded-md border border-sdc-border bg-white text-sdc-muted shadow-sm hover:bg-sdc-blue-light hover:text-sdc-blue-dark"
    >
      <svg
        viewBox="0 0 16 16"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden
        className={`motion-interactive ${open ? "" : "rotate-180"}`}
      >
        <path d="M4 9 L8 5 L12 9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export function EtcMonthKpiCards({
  month,
  kpis,
  detailJobIds,
  importIssues,
  offGridJobs,
}: {
  month: string;
  kpis: EtcMonthKpis;
  // The jobs the grid is rendering, so the drill can be scoped to the card that
  // opened it. IDs only, not the punch rows themselves (2026-08-04, performance
  // pass): the rows are fetched when a drill is opened, by lib/hours-detail-actions.
  // Shipping them with the page cost 1,092 rows and 46ms of database time on EVERY
  // render of the heaviest route in the app — background refreshes, filter changes
  // and colleagues' saves included — for a panel that starts closed. The
  // undefined-hours drill beside it already worked this way.
  detailJobIds: number[];
  // Time booked to something that isn't a job number. Passed in from the page,
  // which already loads it for the amber banner — one query, one number, so the
  // card and the banner cannot disagree.
  importIssues: { label: string; rows: number; hours: number }[];
  // Hours sitting in this month's EtcEntry rows against jobs the grid does not
  // render — jobs whose status moved off Active after the month was seeded. Same
  // data as the red banner above the grid; see where hiddenJobHours is built in
  // etc/page.tsx for why this is a business call rather than a bug to auto-fix.
  offGridJobs: OffGridJob[];
}) {
  // ── Live Diff (2026-08-03) ─────────────────────────────────────────────────
  //
  // Of everything on this strip, only the three Diffs depend on a cell anyone can
  // edit: Hours Worked, the people counts and Parts spent all come from booked
  // time and purchase data, so they are properties of the month, not of the draft
  // on screen. The Diffs are Hours Left − New ETC, and New ETC is exactly what a
  // manager is typing — so they were the one set of figures here that could sit
  // contradicting the grid three rows below them.
  //
  // Summed from the same published cells the grid's own totals use
  // (lib/etc-live-totals.ts), so a card cannot disagree with the total at the
  // bottom of the table — which is the property the comment above promises.
  //
  // Falls back to the server figure when nothing has published yet (the strip can
  // be open on a month whose grid rows haven't mounted), rather than showing a
  // confident zero.
  // ── ONE reconciled set of figures (§28, 2026-08-04) ────────────────────────
  //
  // This used to sum only the three DIFFS out of the live store and leave everything
  // else on the server's page-load values — including `newEtc`, which is what the
  // diffs are computed FROM. So a card could show a live variance beside a stale New
  // ETC, and the Parts tooltip printed both in one sentence: "Money Left (X) − New
  // ETC (Y)" where X − Y was not the number above it.
  //
  // Now the whole strip comes from lib/etc-kpi-live.ts, which is the single place
  // that says which fields are editable-derived (newEtc, diff, diffUnplanned) and
  // which are synced (worked, spent, people, prior, hoursLeft). There is no arithmetic
  // left in this component, so no card can pick a different vintage from its neighbour.
  //
  // `live` is the ONLY set of figures the summary blocks are built from (§37.3): every
  // block reads it through buildKpiBlocks, so there is no longer a per-card choice
  // between `live.x` and `kpis.x` to get wrong — which is how the Parts tooltip came to
  // quote a page-load operand beside a live variance.
  const live = reconcileEtcKpis(kpis, rollupLiveTotals(useEtcLiveTotals()));

  // Summed through the same helpers the summary blocks use (lib/etc-kpi-strip.ts), so a
  // block and the drill panel that opens from it cannot disagree about the figure
  // (§37.13 #6). Both are cheap reductions over data already in props.
  // "By job" is the default because the ACTION lives on the job — setting it back to
  // Active is what saves the hours. "By section" answers the other question: what kind
  // of work is about to be lost.
  const [offGridView, setOffGridView] = useState<"job" | "section">("job");
  // Independent per view — switching Job/Section split does not disturb either's own
  // sort preference, matching how switching filters never disturbs sort either.
  const offGridJobSort = useColumnSort<"job" | "status" | "hours">();
  const offGridSectionSort = useColumnSort<"section" | "hours">();

  // ── Off-grid filters (§73) ──────────────────────────────────────────────────
  //
  // Job, status and section, all multi-select, keyed on the month so switching the report
  // month drops them (this component stays mounted across one — see useDrillFilters).
  //
  // Section is the one that cannot go through matchesDrillFilters: an off-grid job carries
  // SEVERAL sections, so "is this row's section selected" is the wrong question. Filtering
  // by section narrows each job's section list and re-sums its hours from what survives —
  // which is what makes the two views and the footer still total the same figure as each
  // other after a filter, exactly as they had to before one existed.
  const offGridFilters = useDrillFilters(month);
  const filteredOffGridJobs = useMemo(() => {
    const sel = offGridFilters.filters.values.section ?? [];
    const out: OffGridJob[] = [];
    for (const j of offGridJobs) {
      if (!matchesDrillFilters({ job: `${j.jobId} — ${j.jobName}`, status: j.status }, offGridFilters.filters)) continue;
      if (sel.length === 0) {
        out.push(j);
        continue;
      }
      const sections = j.sections.filter((s) => sel.includes(s.section));
      if (sections.length === 0) continue;
      out.push({ ...j, sections, hours: sections.reduce((t, s) => t + s.hours, 0) });
    }
    return out;
  }, [offGridJobs, offGridFilters.filters]);
  const offGridTotal = offGridTotalHours(filteredOffGridJobs);
  const offGridSections = useMemo(() => offGridBySection(filteredOffGridJobs), [filteredOffGridJobs]);
  // Options from the UNFILTERED jobs, so ticking one section does not remove the boxes
  // that would let you widen the selection again.
  const offGridMenus = useMemo(
    () => [
      {
        key: "job" as const,
        options: offGridJobs
          .map((j) => ({ value: `${j.jobId} — ${j.jobName}`, label: `${j.jobId} — ${j.jobName}` }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        searchable: true,
      },
      {
        key: "status" as const,
        options: [...new Set(offGridJobs.map((j) => j.status ?? "—"))]
          .sort((a, b) => a.localeCompare(b))
          .map((s) => ({ value: s, label: s })),
      },
      {
        key: "section" as const,
        options: [...new Set(offGridJobs.flatMap((j) => j.sections.map((s) => s.section)))]
          .sort(compareSections)
          .map((code) => ({ value: code, label: sectionName(code) ?? code, suffix: code })),
      },
    ],
    [offGridJobs],
  );

  const [drill, setDrill] = useState<DrillScope | null>(null); // null = closed
  // The punch rows behind the Engineering / Shop / People cards, fetched on first
  // open rather than shipped with the page — see the `detailJobIds` note above.
  // Kept for the life of the component once loaded: the punches only change on a
  // sync, and re-fetching on every open would make the panel feel slow for no
  // fresher an answer. Exactly the treatment the unattributed drill already had.
  const [detail, setDetail] = useState<JobHoursDetail | null>(null);
  const [loadingDetail, startDetail] = useTransition();
  const [detailError, setDetailError] = useState<string | null>(null);
  // Whether the summary strip is showing. Read through useSyncExternalStore for the
  // same reason as the other client prefs: reading localStorage during render
  // hydrates differently from the server.
  const stripOpen = useSyncExternalStore(subscribeKpiStrip, readKpiStripOpen, () => true);
  // "2026-07" -> "JULY 2026" for the card header. Parsed as local parts rather than
  // `new Date("2026-07")`, which is parsed as UTC midnight and prints as the PREVIOUS
  // month for anybody west of Greenwich — this server is UTC-4, so every card would have
  // been titled a month early.
  const monthTitle = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
    .toLocaleString("en-US", { month: "long", year: "numeric" })
    .toUpperCase();
  const setStripOpen = writeKpiStripOpen;
  // The unattributed drill is fetched on click, not with the page: it re-parses
  // the hours export, which nobody should pay for unless they open it.
  const [unattributed, setUnattributed] = useState<UnattributedDetail | null>(null);
  // The Parts spent drill: same treatment as the two beside it — fetched when opened,
  // cached, and dropped when a refresh lands (see the invalidation effect below).
  const [parts, setParts] = useState<PartsSpentDetail | null>(null);
  const [loadingParts, startParts] = useTransition();
  const [partsError, setPartsError] = useState<string | null>(null);
  const [loadingUnattributed, startUnattributed] = useTransition();
  const [unattributedError, setUnattributedError] = useState<string | null>(null);

  // ── Parts filters (§73) ─────────────────────────────────────────────────────
  //
  // Job, and whether a New ETC has been entered — which is the "status, where applicable"
  // for this table, and the one that answers "which jobs still have no parts plan". The
  // other columns on a parts row are money, and a money filter is a different control from
  // the ones this row holds.
  //
  // Keyed on the month, like the off-grid filters above: this component survives a month
  // change, so without that a job filter set on July would narrow August to a job that may
  // not be in it.
  const partsFilters = useDrillFilters(month);
  const partsSort = useColumnSort<"job" | "spent">();
  const partsRows = useMemo(
    () =>
      (parts?.rows ?? []).filter((r) =>
        matchesDrillFilters({ job: partsJobLabel(r), status: partsStatus(r.decided) }, partsFilters.filters),
      ),
    [parts, partsFilters.filters],
  );
  // Summed from the FILTERED rows, so the figure under the table is the figure in it. The
  // card's own total stays where it is and the footer's label says which of the two this
  // is — a filtered subtotal must never be readable as the KPI.
  const partsShown = partsRows.reduce((t, r) => t + r.spent, 0);
  // Options from the UNFILTERED rows — see the same note on the off-grid menus.
  const partsMenus = useMemo(
    () => [
      {
        key: "job" as const,
        options: (parts?.rows ?? [])
          .map((r) => ({ value: partsJobLabel(r), label: partsJobLabel(r) }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        searchable: true,
      },
      {
        key: "status" as const,
        label: "New ETC",
        options: [true, false].map((d) => ({ value: partsStatus(d), label: partsStatus(d) })),
      },
    ],
    [parts],
  );

  // The drill shows ONLY the sections belonging to the card that opened it —
  // Engineering from the Engineering card, Shop from Shop. It used to hand the
  // panel every punch in the month regardless, so a drill "opened from Shop"
  // listed ME Gen and Software rows and totalled the whole month, which made the
  // card and its own detail disagree.
  //
  // Narrowed here rather than in the panel: the panel's section dropdown and its
  // footer total both read off `detail`, so filtering the data is what keeps the
  // dropdown offering only this group's sections and the total matching the card.
  const scopedDetail = useMemo<JobHoursDetail | null>(() => {
    if (!detail) return null;
    // Every remaining drill scope narrows to one section group — the unscoped "All"
    // People Booked drill retired with its block (§64).
    if (!drill) return detail;
    const rows = detail.rows.filter((r) => SECTION_GROUP.get(r.section) === drill);
    // Section totals recomputed from the kept rows, so the dropdown's per-section
    // figures still add up to the footer.
    const bySection = new Map<string, number>();
    for (const r of rows) bySection.set(r.section, (bySection.get(r.section) ?? 0) + r.hours);
    return {
      rows,
      total: rows.reduce((s, r) => s + r.hours, 0),
      sections: detail.sections.filter((s) => bySection.has(s.code)).map((s) => ({ ...s, hours: bySection.get(s.code)! })),
      truncated: detail.truncated,
    };
  }, [detail, drill]);

  // The card and its drill come from two different tables: the card sums
  // EtcEntry.hoursWorked (written by the hours sync), the drill sums the punch
  // rows in JobHoursDetail. They agree to within a couple of hours but not
  // exactly, because the two were last written at different times — measured
  // 2026-07-30, Engineering was 2086.54 on the card against 2078.52 in the
  // punches. Small, real, and guaranteed to look like a bug if left unexplained,
  // so say it out loud whenever the gap would be visible.
  const cardWorked = drill === "Engineering" ? kpis.engineering.worked : drill === "Shop" ? kpis.shop.worked : null;
  const gap = cardWorked == null || scopedDetail == null ? 0 : scopedDetail.total - cardWorked;
  const scopeNote =
    Math.abs(gap) >= 1 && cardWorked != null && scopedDetail != null
      ? `The card reads ${fmtHours(cardWorked)} — these punch rows total ${fmtHours(scopedDetail.total)}. ` +
        `The card comes from the ETC grid's Hours Worked; these rows are the Paylocity punches behind it, and the two were last synced at different times.`
      : undefined;

  // Clicking a card's Detail link a second time CLOSES its panel — it's a
  // disclosure, and a control that opens something should put it away again
  // rather than leaving the only exit at the panel's far corner. Clicking a
  // DIFFERENT card still switches scope instead of closing, which is what
  // someone comparing Engineering against Shop is actually asking for.
  //
  // ── Opening a drill only OPENS it; the fetch is the effect's job ───────────
  //
  // This used to start the fetch itself, on the reasoning that "the click is the
  // event that means I want this data, and an effect would also fire on a
  // re-render, which is how duplicate requests start". The self-healing effects
  // below were added later for first-open and cache-invalidation, and once they
  // existed this handler became the duplicate it was written to prevent: the
  // click issued one request, then the re-render with `drill` set and `detail`
  // still null satisfied the effect's `if (detail) return` guard and issued a
  // SECOND identical one. Two requests for one click (§32.3 forbids exactly this).
  //
  // One fetch path now, and it is the effect. `sequenced` makes that safe on its
  // own terms rather than by argument: an identical request already in flight is
  // joined, not repeated.
  //
  // useCallback with no dependencies, so its identity never changes: it is passed to
  // every memoised MetricBlock, and a fresh function each render would defeat the
  // memoisation §37.4 and §37.11 ask for (only the affected block re-renders).
  const toggleDrill = useCallback((scope: DrillScope) => {
    setDrill((current) => (current === scope ? null : scope));
  }, []);

  // ── Opening a drill from outside this card (§44) ────────────────────────────
  //
  // The issues indicator in the page header replaced the full-width banners, and two of
  // those banners described figures that already have a drill here. Rather than
  // restating them in prose a second time, that indicator ASKS for the drill.
  //
  // Not a toggle: a request must always open. Someone clicking "Undefined hours" in the
  // issues list means "show me", never "hide it if it happens to be showing" — and it
  // opens the summary strip too, because a drill rendered inside a collapsed strip is a
  // click that appears to do nothing.
  const drillRequest = useSyncExternalStore(subscribeKpiDrillRequest, readKpiDrillRequest, serverKpiDrillRequest);
  const lastHandledRequest = useRef(0);
  useEffect(() => {
    if (!drillRequest || drillRequest.n === lastHandledRequest.current) return;
    lastHandledRequest.current = drillRequest.n;
    setDrill(drillRequest.scope);
    if (!readKpiStripOpen()) writeKpiStripOpen(true);
  }, [drillRequest]);

  // ── Retry, per KPI (§37.9) ──────────────────────────────────────────────────
  //
  // Drops the cache and the error for the ONE lane that failed, which is enough: the
  // effect that owns that lane sees its data missing while its drill is open and
  // refetches. Nothing else is touched, so a failed Parts fetch cannot clear the punch
  // detail somebody else is reading.
  //
  // Stable identity for the same reason as toggleDrill — hence the scope argument
  // rather than a read of the `drill` state.
  const retryDrill = useCallback((scope: DrillScope) => {
    if (scope === "Parts") {
      setParts(null);
      setPartsError(null);
    } else if (scope === "Unattributed") {
      setUnattributed(null);
      setUnattributedError(null);
    } else {
      setDetail(null);
      setDetailError(null);
    }
  }, []);

  // ── Drill caches are dropped when the data underneath them moves (§30) ─────
  //
  // Both drills cache for the life of the component, on the reasoning that their
  // sources "only change on a sync". Refresh Data IS a sync, and this component never
  // unmounts across one — router.refresh() preserves state deliberately — so the cards
  // updated from the fresh server props while their own detail panels kept serving
  // rows from before the refresh. A card and its drill-through disagreeing is exactly
  // what §28.15 forbids, and the drill is the thing people open to check the card.
  //
  // Keyed on the realtime change feed, which a completed refresh publishes (see
  // recordChanges in lib/refresh-service.ts), so this also covers a refresh started by
  // somebody else. Dropping the cache is enough for a closed drill; an OPEN one is
  // refetched below, because leaving it blank would read as the data having vanished.
  const changes = useRealtimeChanges();
  const drillChangeSeen = useRef(changes.length);
  useEffect(() => {
    if (changes.length === drillChangeSeen.current) return;
    drillChangeSeen.current = changes.length;
    setDetail(null);
    setUnattributed(null);
    setParts(null);
  }, [changes.length]);

  // ── Ordering and de-duplication now come from lib/request-sequence ─────────
  //
  // There were three request-id refs here (plus a fourth for the per-job parts
  // lines), each doing `const req = ++ref.current` and checking it again on the
  // way out. That is the right idea — it is what stops a response the user has
  // moved on from landing late — but four copies of it meant four chances to get
  // it subtly wrong, and none of them de-duplicated a request already in flight.
  //
  // `sequenced(lane, key, work)` is the one implementation: the lane is the thing
  // being kept current, the key is the question being asked, and a result comes
  // back `ok` only if it is still the newest answer for that lane. The trap the
  // old comment warned about still applies and is still avoided — the
  // transition's pending flag must never be an effect dependency, because
  // starting the transition flips it and re-runs the effect.

  // ── The second level of the parts drill ───────────────────────────────────
  //
  // Which job's purchase lines are expanded, and the lines themselves, cached per
  // job so collapsing and reopening a row is instant. Each job is a separate
  // TotalETO round trip, so they are fetched one at a time, on demand — never
  // all 45 up front.
  //
  // Keyed on `${jobNumber}::${month}`, not just the job (2026-08-07): the lines are
  // now windowed to `month` (see loadJobPartsLines), so a cache keyed on the job
  // alone would keep serving July's lines under a job row after the picker moved to
  // June. The check below also drops both caches outright on a month change, in
  // case this component is ever reused across a month switch without remounting —
  // adjusted during RENDER (React's "resetting state when a prop changes" idiom,
  // already used elsewhere in this file for the same reason: an effect that always
  // fires on a prop change costs an extra commit-then-rerender the render-time
  // adjustment does not).
  const [openJob, setOpenJob] = useState<string | null>(null);
  // One sort state shared across whichever job is currently expanded — not reset when a
  // different job opens, since carrying "newest invoice first" between jobs is plausibly
  // wanted rather than surprising.
  const poLineSort = useColumnSort<"po" | "invoiced" | "supplier" | "part" | "qty" | "unit" | "amount">();
  const [jobLines, setJobLines] = useState<Record<string, JobPartsCost>>({});
  const [loadingJobLines, startJobLines] = useTransition();
  const [jobLinesError, setJobLinesError] = useState<string | null>(null);
  const [jobLinesMonth, setJobLinesMonth] = useState(month);
  if (jobLinesMonth !== month) {
    setJobLinesMonth(month);
    setOpenJob(null);
    setJobLines({});
    setJobLinesError(null);
  }

  function toggleJobLines(jobNumber: string) {
    if (openJob === jobNumber) {
      setOpenJob(null);
      return;
    }
    setOpenJob(jobNumber);
    setJobLinesError(null);
    const cacheKey = `${jobNumber}::${month}`;
    if (jobLines[cacheKey]) return; // already fetched
    startJobLines(async () => {
      // Keyed on the job (and month), so expanding a second row does not invalidate
      // the first — each row's lines are a separate answer that stays valid once
      // fetched.
      const out = await sequenced(`parts-lines:${cacheKey}`, cacheKey, () => loadJobPartsLines(jobNumber, month));
      if (out.ok) setJobLines((m) => ({ ...m, [cacheKey]: out.value }));
      else if (out.reason === "error") {
        setJobLinesError(out.error instanceof Error ? out.error.message : "Could not load the purchase lines.");
      }
    });
  }
  useEffect(() => {
    if (drill !== "Parts" || parts) return;
    // No synchronous clear of the error here: setting state during an effect cascades a
    // render, and the branches below already replace it with whatever this attempt
    // produces.
    startParts(async () => {
      const out = await sequenced("kpi-parts", month, () => loadPartsSpentDetail(month, detailJobIds));
      if (out.ok) setParts(out.value);
      else if (out.reason === "error") {
        setPartsError(out.error instanceof Error ? out.error.message : "Could not load the parts detail.");
      }
    });
    // detailJobIds is a new array each render; its CONTENT only moves with the month or
    // the Billable filter, both of which re-render the page and null this cache anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drill, parts, month]);

  // Self-healing refetch: whenever a drill is open and its data is missing — first
  // open, or the invalidation above — fetch it. Guarded on the loading flag so a
  // re-render cannot start a second request, which is the duplicate-call hazard the
  // click-driven fetch above was written to avoid.
  useEffect(() => {
    // Same shape as the Parts effect above, and the same trap avoided: the transition's
    // pending flag must not be a dependency, or starting the request re-runs the effect
    // and cancels it.
    if (drill !== "Unattributed" || unattributed) return;
    startUnattributed(async () => {
      const out = await sequenced("kpi-unattributed", month, () => loadUnattributedDetail(month));
      if (out.ok) setUnattributed(out.value);
      else if (out.reason === "error") {
        setUnattributedError(out.error instanceof Error ? out.error.message : "Could not read the hours export.");
      }
    });
  }, [drill, unattributed, month]);

  useEffect(() => {
    if (drill === null || drill === "OffGrid" || drill === "Unattributed" || drill === "Parts") return;
    if (detail) return;
    startDetail(async () => {
      // Keyed on the month alone: the punch detail is the same answer whichever of
      // the Engineering / Shop / All cards opened it (the panel narrows it
      // client-side), so switching cards must not refetch — and with a shared key
      // it cannot, because the second open joins the first request.
      const out = await sequenced("kpi-detail", month, () => loadEtcMonthHoursDetail(month, detailJobIds));
      if (out.ok) setDetail(out.value);
      else if (out.reason === "error") {
        setDetailError(out.error instanceof Error ? out.error.message : "Could not load the punch detail.");
      }
    });
    // detailJobIds is a fresh array every render; its CONTENT is what matters, and it
    // only changes with the month or the Billable filter — both of which re-render the
    // page and null the cache anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drill, detail, loadingDetail, month]);

  // ── The blocks (§37.1) ──────────────────────────────────────────────────────
  //
  // Six blocks' worth of labels, values, statuses and tones, from the reconciled
  // figures. Deliberately NOT memoised: `live` is a fresh object whenever a cell
  // publishes (that is what makes the strip live), so a useMemo keyed on it would
  // recompute every time anyway while implying it did not. What actually keeps the work
  // down is MetricBlock being memo'd on primitives — building six small objects costs
  // nothing, re-rendering six subtrees on every keystroke was the cost worth removing.
  const blocks = buildKpiBlocks({ kpis: live, importIssues, offGridJobs }, KPI_FORMAT);

  // The three fetch lanes behind the six blocks, in the shape kpiDetailState reads
  // (§37.9). Which block shows an updating or failed marker is decided there, so the
  // property that matters — a slow or failed KPI leaves the other five alone — is a test
  // rather than a chain of ternaries nobody can check.
  const lanes = {
    punches: { loading: loadingDetail, error: detailError, loaded: detail != null },
    parts: { loading: loadingParts, error: partsError, loaded: parts != null },
    undefinedHours: { loading: loadingUnattributed, error: unattributedError, loaded: unattributed != null },
  };

  return (
    <div className="mb-4">
      {/* Collapsible, and remembered. Six boxes three lines tall pushed the grid —
          the thing people came for — below the fold on a laptop. Compact by
          default now, and hideable outright for anyone who never wants them. */}
      {/* Collapsed, the toggle has no card to sit in, so it keeps its own row. Open, it
          moves INTO the card header beside the month (see below) — which is where the
          stacked layout wants it: a floating "Hide summary" above a bordered card reads
          as belonging to the page rather than to the thing it hides. */}
      <div className={`mb-1.5 flex items-center justify-end ${stripOpen ? "hidden" : ""}`}>
        {/* Collapsed, the control has no card header to belong to, so the button's
            own border is what keeps it from reading as a stray mark on the page. */}
        <SummaryToggle open={stripOpen} onToggle={() => setStripOpen(!stripOpen)} />
      </div>
      {/* ── ONE summary card (§37.1) ─────────────────────────────────────────
          Six separate bordered cards became one: one outer border, one background,
          one shadow, and the metric blocks inside separated by hairline dividers
          rather than by six more borders (§37.7).
          The dividers are the grid's `gap-px` showing this container's background
          through — see KPI_GRID_CLASS for why that beats a per-block border (it
          survives wrapping, which a left border does not).
          motion-fade on the CARD, not on the blocks: revealing the summary is one
          deliberate action, so it is one transition. Animating each block separately
          would stagger six things the user asked for at once (§36.1).
          Labelled, so a screen reader announces what the region is before reading six
          figures out of it (§37.10). */}
      {/* ── Card and drill SIDE BY SIDE (2026-08-05, by request) ────────────
          The drill used to render BELOW the card, which pushed the grid down by the
          height of a whole panel every time somebody looked at a figure — the same
          complaint the banners caused, arriving by a different route. */}
      {/* ── Two independent heights, aligned at the TOP (§49, by request) ────
          This briefly ran on flex's default `stretch` — "the two cards must line up at
          the top and at the bottom" — which is the same instruction read the other way,
          and it made the summary card the loser: stretch gives a card the ROW's height
          without giving it any more content, so five KPI rows sat above ~200px of empty
          grey whenever a drill was open beside them. A card cannot be equal-height with
          a table of forty-five jobs and still be a card.
          So `items-start`, each card its own height, and the drill takes a ceiling of its
          own instead (DRILL_CAP) — which is what stops "as tall as its content" from
          meaning "as tall as it likes".

          ── Wrapping, not a breakpoint ───────────────────────────────────────
          `flex-wrap` with a flex-basis on the drill column, rather than `xl:flex-row`.
          §26.2 is the reason: Tailwind's breakpoints measure the VIEWPORT and this row is
          not the viewport — it is inset by a sidebar that is ~276px expanded, so `xl`
          (1280px) fires on a card that is only ~1000px wide and the drill would be
          squeezed to ~490px on exactly the "normal desktop" width the requirement is
          about. Wrapping measures the actual box: the two sit side by side while both
          fit, and the drill drops to its own full-width line when they do not. Browser
          zoom needs no separate handling for the same reason. */}
      <div className="flex flex-wrap items-start gap-3">
      {stripOpen && (
      <section
        aria-label={`${month} summary`}
        // @container: the block layout inside responds to THIS card's width rather than
        // the viewport's — see KPI_GRID_CLASS for why the viewport was the wrong box.
        // ── The card no longer spans the page (2026-08-05, by request) ──────
        //
        // Full width was right when this was six blocks in a row; stacked, it left a
        // label at the far left and its figure ~1,200px away at the far right, which is
        // a long way to travel to read one line. Capped at 34rem, which fits the widest
        // label and the widest figure with room to spare, and the space it gives back is
        // exactly where the drill now opens.
        //
        // shrink-0 so a wide drill table beside it cannot squeeze the card; the drill
        // column takes the pressure instead (it has min-w-0 and scrolls).
        className="@container motion-fade w-full max-w-[34rem] shrink-0 overflow-hidden rounded-xl border border-sdc-border bg-sdc-border-soft shadow-sm"
      >
      {/* The card's own header: which month these figures are for, and the control that
          puts them away. The month was previously nowhere on the card — the strip sat
          under a month picker and inherited its meaning from position alone, which is
          fine until somebody screenshots it. */}
      {/* items-center, not items-baseline: the toggle is an icon button with no text
          baseline of its own, so baseline alignment hung it below the month title. */}
      <div className="flex items-center justify-between gap-3 border-b border-sdc-border bg-white px-3 py-2">
        <h2 className="text-label font-semibold uppercase tracking-wide text-sdc-muted">{monthTitle}</h2>
        <SummaryToggle open onToggle={() => setStripOpen(false)} />
      </div>
      <div className={KPI_GRID_CLASS}>
        {/* Every block, from the one place that decides what the blocks are. The
            labels, tones, drill scopes and the conditional off-grid block all live in
            lib/etc-kpi-strip.ts — see its header for why the six hand-written cards
            that used to sit here became data.
            Keyed on the block's own id, not the index: `id` is stable across renders
            and across the off-grid block appearing or disappearing, so React updates a
            block in place rather than remounting the ones after it (§37.11). */}
        {blocks.map((block) => (
          <MemoKpiRow
            key={block.id}
            {...block}
            drillOpen={block.drill != null && drill === block.drill}
            detailState={kpiDetailState(block.drill, drill, lanes)}
            onDrill={toggleDrill}
            onRetry={retryDrill}
          />
        ))}
      </div>
      </section>
      )}
      {/* The drill column. min-w-0 is load-bearing: without it a flex child refuses to
          shrink below its content, and one wide punch table would push the card off the
          left edge instead of scrolling inside its own container. */}
      {/* `basis-[28rem]` is what decides side-by-side against stacked, and it is a
          BASIS rather than a min-width on purpose: the basis is the hypothetical size the
          wrap decision is made on, so the drill drops to its own line once the summary
          card no longer leaves it 28rem — but a min-width would also refuse to shrink
          after wrapping, and on a genuinely narrow window that is horizontal page scroll
          rather than a stacked layout.
          No `[&>*]:h-full` any more (§49): that existed only to push the drill panel out
          to the equal height stretch had given this column, and with `items-start` above
          there is no row height to fill. It is what made a capped, internally scrolling
          drill impossible — h-full overrode the ceiling with the row's height.

          Rendered only when a drill is OPEN, which it did not need to be while it was
          `flex-1`: an empty column simply took the slack. With a flex-basis it is 28rem
          of hypothetical width, so on a narrower row an EMPTY column wrapped to a second
          line and left a 12px row gap under the card — a phantom shift with nothing in
          it, on a layout whose whole job is not to shift (§49 acceptance 7). */}
      {drill != null && (
      <div className="min-w-0 shrink grow basis-[28rem]">
      {drill === "Parts" ? (
        // ── Where the parts money went, by job ──────────────────────────────
        //
        // Every figure here comes from the same EtcEntry rows and the same functions
        // (effectiveNewEtc / newEtcDiff / calcHoursLeft) that getEtcMonthKpis uses, so
        // the footer IS the card rather than a second opinion about it (§28.15).
        // Capped, with the table as its one scrolling region (§49). The heading and the
        // instruction above it stay put; forty-five job rows scroll underneath them.
        <div className={`motion-panel flex ${DRILL_CAP} flex-col rounded-xl border border-sdc-border bg-white p-4 shadow-sm`}>
          <p className="mb-1 text-xs font-semibold text-sdc-navy">Parts spent — {month}, by job</p>
          <p className="mb-3 text-xs leading-relaxed font-medium text-sdc-gray-700">
            Money invoiced against each job this month, biggest first. Click a row to see the purchase-order lines behind it.
          </p>

          {/* The filters (§73). This drill has no Group By tray — a parts row IS a job, so
              there is nothing to roll it up by — so the filter row sits on its own where a
              tray-and-filters row sits on every other drill. Rendered only once the rows
              are in: menus built from an empty list are five empty menus. */}
          {!partsError && parts && parts.rows.length > 0 && (
            <DrillControls className="mb-2">
              <DrillFilterRow
                filters={partsFilters.filters}
                menus={partsMenus}
                activeCount={partsFilters.count}
                onToggle={partsFilters.toggle}
                onSetAll={partsFilters.setAll}
                onRange={partsFilters.setRange}
                onClear={partsFilters.clear}
              />
            </DrillControls>
          )}

          {partsError && <p className="text-note font-medium text-sdc-red-text">{partsError}</p>}
          {!partsError && loadingParts && !parts && <p className="text-note text-sdc-gray-600">Loading the parts detail…</p>}
          {!partsError && parts && parts.rows.length === 0 && (
            <p className="text-note text-sdc-gray-600">No job in this month has a parts budget or any parts spend.</p>
          )}

          {!partsError && parts && parts.rows.length > 0 && (
            // Was a flat 420px; now it takes whatever the card's ceiling leaves it (§49),
            // so a tall window shows more rows and a short one shows fewer, rather than
            // both showing 420px and the tall one wasting the rest.
            <div className={DRILL_BODY}>
              {/* Two columns only, by request: the question this panel answers is
                  "where did the money go", and budget/plan columns were answering a
                  different one that the grid below already covers. */}
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b-2 border-sdc-border text-sdc-navy">
                    <SortableTh label="Job" sortKey="job" type="id" sort={partsSort.sort} onSort={partsSort.onSort} className="px-2 py-2 font-bold" />
                    <SortableTh label="Money spent" sortKey="spent" type="currency" sort={partsSort.sort} onSort={partsSort.onSort} className="px-2 py-2 font-bold" />
                  </tr>
                </thead>
                <tbody>
                  {sortRows(partsRows, partsSort.sort, PARTS_ROW_COLUMNS).map((r) => {
                    const open = openJob === r.jobId;
                    const lines = jobLines[`${r.jobId}::${month}`];
                    return (
                      <Fragment key={r.id}>
                        <tr
                          className={`cursor-pointer border-b border-sdc-border-soft/60 hover:bg-sdc-blue-light/40 ${open ? "bg-sdc-blue-light/50" : ""}`}
                          onClick={() => toggleJobLines(r.jobId)}
                        >
                          <td className="px-2 py-2 text-left">
                            <span className="mr-1.5 inline-block w-2 text-sdc-navy">{open ? "▾" : "▸"}</span>
                            <span className="font-mono font-bold text-sdc-navy">{r.jobId}</span>
                            <span className="ml-2 font-semibold text-sdc-navy">{r.jobName}</span>
                          </td>
                          <td className="px-2 py-2 text-right font-bold tabular-nums text-sdc-navy">{usd(r.spent)}</td>
                        </tr>
                        {open && (
                          <tr className="border-b border-sdc-border">
                            <td colSpan={2} className="bg-sdc-gray-50 px-3 py-2.5">
                              {jobLinesError && <p className="text-xs font-semibold text-sdc-red-text">{jobLinesError}</p>}
                              {!jobLinesError && !lines && loadingJobLines && (
                                <p className="text-xs font-medium text-sdc-gray-700">Loading purchase lines for {r.jobId}…</p>
                              )}
                              {!jobLinesError && lines && lines.lines.length === 0 && (
                                <p className="text-xs font-medium text-sdc-gray-700">
                                  {/* §77: no row here can mean "TotalETO has nothing for this
                                      job," "everything it has is still uninvoiced," or "what it
                                      has was invoiced in a different month" — the drill only
                                      shows THIS month's invoiced lines (fixed 2026-08-07), so the
                                      wording doesn't claim there is nothing at all, ever. */}
                                  No purchase-order lines for job {r.jobId} invoiced in {month}.
                                </p>
                              )}
                              {!jobLinesError && lines && lines.lines.length > 0 && (
                                <>
                                  {/* Windowed to THIS month by AP document date (fixed 2026-08-07) —
                                      the exact same field and job attribution
                                      (getPartsCostBookedByJob) the row's own "Money spent" figure
                                      above is computed from, down to a non-PO AP line (freight, a
                                      tariff, an expense reimbursement) counting the same on both
                                      sides. Verified live to match to the cent across every job
                                      checked. Any remaining gap is sync staleness, not a formula
                                      difference — same explanation as the card-vs-footer banner
                                      further down. */}
                                  <p className="mb-2 text-note leading-relaxed font-medium text-sdc-gray-700">
                                    Purchase lines for job {r.jobId} invoiced in {month} — <strong>{usd(lines.paid)} invoiced</strong>, {lines.lines.length}{" "}
                                    line{lines.lines.length === 1 ? "" : "s"}.
                                  </p>
                                  {Math.abs(lines.paid - r.spent) >= 0.5 && (
                                    <p className="mb-2 rounded border border-sdc-yellow bg-sdc-yellow-bg/60 px-2 py-1.5 text-label leading-relaxed text-sdc-gray-600">
                                      This sums to {usd(lines.paid)} against the {usd(r.spent)} above — both should read the same for {month}.
                                      If it doesn&apos;t, the figure above hasn&apos;t picked up a recent change yet; run &ldquo;Refresh Data&rdquo; and check again.
                                    </p>
                                  )}
                                  <div className="styled-scrollbar max-h-64 overflow-auto rounded border border-sdc-border bg-white">
                                    <table className="w-full border-collapse text-note">
                                      <thead className="sticky top-0 bg-sdc-gray-50">
                                        <tr className="border-b border-sdc-border text-sdc-navy">
                                          <SortableTh label="PO" sortKey="po" type="id" sort={poLineSort.sort} onSort={poLineSort.onSort} className="px-2 py-1.5 font-bold" />
                                          {/* The AP document date — every row is windowed on this field
                                              landing in {month}, the same field and window the row's own
                                              "Money spent" figure above is computed from. Always present:
                                              every row here IS an invoice event, unlike getJobPartsCost's
                                              whole-history view where an ordered-but-unbilled line has none. */}
                                          <SortableTh
                                            label="Invoiced on"
                                            sortKey="invoiced"
                                            type="date"
                                            sort={poLineSort.sort}
                                            onSort={poLineSort.onSort}
                                            className="px-2 py-1.5 font-bold whitespace-nowrap"
                                          />
                                          <SortableTh label="Supplier" sortKey="supplier" type="text" sort={poLineSort.sort} onSort={poLineSort.onSort} className="px-2 py-1.5 font-bold" />
                                          <SortableTh label="Part" sortKey="part" type="text" sort={poLineSort.sort} onSort={poLineSort.onSort} className="px-2 py-1.5 font-bold" />
                                          <SortableTh label="Qty" sortKey="qty" type="number" sort={poLineSort.sort} onSort={poLineSort.onSort} className="px-2 py-1.5 font-bold" />
                                          <SortableTh label="Unit" sortKey="unit" type="currency" sort={poLineSort.sort} onSort={poLineSort.onSort} className="px-2 py-1.5 font-bold" />
                                          {/* One dollar column, not two: at this grain (one row = one
                                              invoice event) "purchased" and "invoiced" are the same
                                              number by construction, unlike getJobPartsCost's lifetime
                                              view where an open PO's remaining balance makes them differ. */}
                                          <SortableTh label="Invoiced" sortKey="amount" type="currency" sort={poLineSort.sort} onSort={poLineSort.onSort} className="px-2 py-1.5 font-bold" />
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {/* No explicit sort chosen -> biggest invoiced amount first, not
                                            whatever order the source query returned. Clicking any header
                                            still overrides this exactly as it did before (§ column sort). */}
                                        {sortRows(lines.lines, poLineSort.sort ?? { key: "amount", direction: "desc" }, PARTS_LINE_COLUMNS).map((l, i) => (
                                          <tr key={i} className="border-b border-sdc-border-soft/50" title={l.description ?? undefined}>
                                            <td className="px-2 py-1.5 text-left font-mono font-semibold text-sdc-navy">{l.poNumber ?? "—"}</td>
                                            <td className="px-2 py-1.5 text-left font-medium whitespace-nowrap text-sdc-gray-700">
                                              {l.invoicedDate ?? "—"}
                                            </td>
                                            <td className="max-w-[150px] truncate px-2 py-1.5 text-left font-medium text-sdc-navy">
                                              {l.supplier ?? "—"}
                                            </td>
                                            <td className="max-w-[220px] truncate px-2 py-1.5 text-left font-medium text-sdc-navy">
                                              {l.partNumber ? `${l.partNumber} — ` : ""}
                                              {l.description ?? "—"}
                                            </td>
                                            <td className="px-2 py-1.5 text-right font-medium tabular-nums text-sdc-navy">{l.quantity}</td>
                                            <td className="px-2 py-1.5 text-right font-medium tabular-nums text-sdc-navy">{usd(l.unitPrice)}</td>
                                            <td className="px-2 py-1.5 text-right font-bold tabular-nums text-sdc-navy">{usd(l.invoicedAmount)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  {/* "Shown" the moment a filter is on, and the figure is the sum of the
                      rows above it rather than the month's total — the two must never be
                      confusable, because the unfiltered one is the KPI. */}
                  <tr className="border-t-2 border-sdc-border bg-sdc-gray-50 font-bold text-sdc-navy">
                    <td className="px-2 py-2 text-left">
                      {partsFilters.count > 0 ? "Shown" : "Total"} — {partsRows.length} jobs
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{usd(partsShown)}</td>
                  </tr>
                </tfoot>
              </table>
              {partsRows.length === 0 && (
                <p className="px-2 py-6 text-note text-sdc-muted">No job matches these filters.</p>
              )}
              {/* What the filtered subtotal is a subtotal OF, said out loud rather than
                  leaving the reader to wonder why the footer no longer matches the card. */}
              {partsFilters.count > 0 && (
                <p className="mt-2 text-label text-sdc-muted">
                  Filtered — {usd(partsShown)} of the {usd(parts.totals.spent)} spent this month. Clear the filters to
                  reconcile against the card.
                </p>
              )}
              {/* Says so out loud when the footer and the card differ, rather than
                  leaving somebody to spot it. They can legitimately differ by the
                  quiet jobs excluded above — nothing else should move them apart. */}
              {Math.abs(parts.totals.spent - live.parts.spent) >= 0.5 && (
                <p className="mt-2 rounded border border-sdc-yellow bg-sdc-yellow-bg/60 px-2 py-1.5 text-label leading-relaxed text-sdc-gray-600">
                  This totals {usd(parts.totals.spent)} against the card&apos;s {usd(live.parts.spent)}. Both read the same month; if the gap
                  is not the excluded jobs above, run &ldquo;Refresh Data&rdquo; and check again.
                </p>
              )}
            </div>
          )}
        </div>
      ) : drill === "OffGrid" ? (
        // Capped, with the table as its one scrolling region (§49). The explanatory
        // heading and its two paragraphs (why a job lands here, and why the figure
        // survives a refresh) were removed by request (§65) — the KPI row's own label
        // and hint already say "Hours off the grid" / "N jobs not listed", so the panel
        // opens straight onto the one control that changes what the table shows.
        <div className={`motion-panel flex ${DRILL_CAP} flex-col rounded-xl border border-sdc-red-border bg-white p-4 shadow-sm`}>
          {/* Two readings of the same 181 hours. Both total identically — they have to,
              since the card above shows that figure too. */}
          {/* ── Split by, and the filters beside it (§47, §73) ────────────────
              "Split by" IS this drill's Group By, so it now uses the shared tray rather
              than two solid-blue filled buttons — which read as two primary actions and
              matched neither the other drills' trays nor anything else in the app. The
              behaviour is unchanged: two readings of the same hours, one at a time.
              The filters sit beside it, and the two are independent — narrowing to a
              section does not change which split is showing, and switching the split does
              not touch the filters. */}
          <DrillControls className="mb-2">
            <DrillGroupTray label="Split by">
              {(["job", "section"] as const).map((v) => (
                <DrillGroupOption
                  key={v}
                  on={offGridView === v}
                  onClick={() => setOffGridView(v)}
                  title={
                    v === "job"
                      ? "One row per job — the job is where the fix is (set it back to Active)"
                      : "One row per section, summed across every off-grid job"
                  }
                >
                  {v === "job" ? "Job" : "Section"}
                </DrillGroupOption>
              ))}
            </DrillGroupTray>
            <DrillFilterRow
              filters={offGridFilters.filters}
              menus={offGridMenus}
              activeCount={offGridFilters.count}
              onToggle={offGridFilters.toggle}
              onSetAll={offGridFilters.setAll}
              onRange={offGridFilters.setRange}
              onClear={offGridFilters.clear}
            />
          </DrillControls>
          {/* Was a flat 18rem; now it takes whatever the card's ceiling leaves it (§49).
              The footnote below stays outside it, so it cannot be scrolled away. */}
          <div className={`${DRILL_BODY} rounded-lg border border-sdc-border`}>
            <table className="w-full border-collapse text-note">
              <thead className="sticky top-0 bg-sdc-gray-100">
                <tr className="text-left text-label font-semibold uppercase tracking-wide text-sdc-muted">
                  {offGridView === "job" ? (
                    <>
                      <SortableTh label="Job" sortKey="job" type="id" sort={offGridJobSort.sort} onSort={offGridJobSort.onSort} className="px-2 py-1.5" />
                      <SortableTh label="Status" sortKey="status" type="status" sort={offGridJobSort.sort} onSort={offGridJobSort.onSort} className="px-2 py-1.5" />
                      {/* Not sortable — this cell holds one line PER section, a list with
                          no single scalar to compare, unlike every other column here. */}
                      <th className="px-2 py-1.5">Sections</th>
                      <SortableTh label="Hours" sortKey="hours" type="hours" sort={offGridJobSort.sort} onSort={offGridJobSort.onSort} className="px-2 py-1.5" />
                    </>
                  ) : (
                    <>
                      <SortableTh label="Section" sortKey="section" type="text" sort={offGridSectionSort.sort} onSort={offGridSectionSort.onSort} className="px-2 py-1.5" />
                      {/* Not sortable — a comma-joined list of job ids, same reason as
                          "Sections" in the by-job view. */}
                      <th className="px-2 py-1.5">Jobs</th>
                      <SortableTh label="Hours" sortKey="hours" type="hours" sort={offGridSectionSort.sort} onSort={offGridSectionSort.onSort} className="px-2 py-1.5" />
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {offGridView === "job"
                  ? sortRows(filteredOffGridJobs, offGridJobSort.sort, OFF_GRID_JOB_COLUMNS).map((j) => (
                      <tr key={j.jobId} className="border-t border-sdc-border-soft align-top">
                        <td className="px-2 py-1.5">
                          <span className="font-mono font-semibold text-sdc-blue-dark">{j.jobId}</span>
                          <span className="ml-1.5 text-sdc-gray-600">{j.jobName}</span>
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-sdc-yellow-text">{j.status ?? "—"}</td>
                        {/* One section per LINE, named. It used to be a single
                            interpunct-joined string ("10-313 71 · 10-211 37 · …"),
                            which is unreadable past two sections and gave the codes no
                            names at all. */}
                        <td className="px-2 py-1.5 text-sdc-gray-600">
                          {/* A HeadStart job is listed even with nothing booked, so this
                              says so rather than leaving the cell blank and looking like
                              missing data. */}
                          {j.sections.length === 0 ? (
                            <span className="text-sdc-gray-400">No hours booked this month</span>
                          ) : (
                            // Name only — the code is dropped (2026-08-03, by request).
                            // It falls back to the code for anything the app does not
                            // model, so a row can never render as a bare number.
                            j.sections.map((s) => (
                              <span key={s.section} className="block whitespace-nowrap">
                                {sectionName(s.section) ?? s.section}
                                <span className="ml-1 font-semibold tabular-nums text-sdc-navy">{fmtHours(s.hours)}</span>
                              </span>
                            ))
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-sdc-navy">{fmtHours(j.hours)}</td>
                      </tr>
                    ))
                  : sortRows(offGridSections, offGridSectionSort.sort, OFF_GRID_SECTION_COLUMNS).map((s) => (
                      <tr key={s.section} className="border-t border-sdc-border-soft align-top">
                        <td className="px-2 py-1.5 whitespace-nowrap text-sdc-navy">
                          {/* Name only, matching the by-job view. Falls back to the code
                              for a section the app does not model. */}
                          {s.name ?? s.section}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-sdc-gray-600">{s.jobIds.join(", ")}</td>
                        <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-sdc-navy">{fmtHours(s.hours)}</td>
                      </tr>
                    ))}
              </tbody>
              <tfoot>
                {/* Both splits still total the same figure after a filter — the by-section
                    view is derived from the same filtered jobs (see filteredOffGridJobs),
                    so the two readings cannot disagree. "Shown" once a filter is on, so a
                    subtotal is not read as the card's figure. */}
                <tr className="border-t-2 border-sdc-navy bg-sdc-gray-50 font-semibold">
                  <td className="px-2 py-1.5" colSpan={offGridView === "job" ? 3 : 2}>
                    {offGridFilters.count > 0 ? "Shown" : "Total"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-sdc-navy">{fmtHours(offGridTotal)}</td>
                </tr>
              </tfoot>
            </table>
            {filteredOffGridJobs.length === 0 && (
              <p className="px-2 py-6 text-note text-sdc-muted">No job matches these filters.</p>
            )}
          </div>
          {offGridFilters.count > 0 && (
            <p className="mt-2 text-label text-sdc-muted">
              Filtered — {fmtHours(offGridTotal)} of the {fmtHours(offGridTotalHours(offGridJobs))} off the grid this
              month. Clear the filters to reconcile against the card.
            </p>
          )}
          {/* Parts Cost is excluded upstream: it stores DOLLARS in the same column
              these hours come from, so including it would put money in an hours
              total. Said here because a reader comparing this against the job's
              Parts row would otherwise think something was missing. */}
          <p className="mt-2 text-label text-sdc-gray-400">Hours only — Parts Cost is money and is not counted here.</p>
        </div>
      ) : drill === "Unattributed" ? (
        loadingUnattributed || (!unattributed && !unattributedError) ? (
          <p className="motion-panel rounded-xl border border-sdc-border bg-white p-4 text-xs text-sdc-muted shadow-sm">
            Reading the hours export…
          </p>
        ) : unattributedError ? (
          <p className="motion-panel rounded-xl border border-sdc-red-border bg-sdc-red-bg p-4 text-xs font-medium text-sdc-red-text shadow-sm">
            Could not load the undefined-hours detail — {unattributedError}
          </p>
        ) : (
          // Its own panel since 2026-08-05 (§42.27), not HoursDetailPanel. That one is
          // built for "who worked on this job" — a punch list grouped by
          // department/employee/section. These rows are FAULTS to be corrected, so the
          // panel leads with the reason breakdown and what to do about each, and states
          // its reconciliation against the KPI outright (§42.28).
          //
          // The `note` that used to be passed here explained that the card and the drill
          // might disagree, because they read two different sources. They no longer can:
          // both come from one pass over one import. See lib/unattributed-hours.ts.
          <UndefinedHoursPanel detail={unattributed!} month={month} onClose={() => setDrill(null)} />
        )
      ) : (
        drill &&
        // Three states now that the rows arrive on demand. The panel keeps its own
        // shape in all three so opening a drill never shifts the page under the
        // cursor: a one-line box while loading, the same box with the error, then
        // the table.
        (detailError ? (
          <p className="motion-panel rounded-xl border border-sdc-red-border bg-sdc-red-bg p-4 text-xs font-medium text-sdc-red-text shadow-sm">
            Could not load the punch detail — {detailError}{" "}
            <button
              type="button"
              // The same retry the block's own link offers (§37.9), which is now one
              // function rather than two. It used to close the drill and re-open it on a
              // setTimeout to force the fetch; clearing the lane is enough, because the
              // effect that owns it refetches whenever its drill is open and its data is
              // missing — and it keeps the panel on screen while it does.
              onClick={() => retryDrill(drill)}
              className="underline underline-offset-2 hover:no-underline"
            >
              Try again
            </button>
          </p>
        ) : scopedDetail == null ? (
          <p className="motion-panel rounded-xl border border-sdc-border bg-white p-4 text-xs text-sdc-muted shadow-sm">
            Loading the punch detail…
          </p>
        ) : (
          <HoursDetailPanel
            // Remounted per scope and per month (§73), which is how "reset the filters when
            // the report month changes" holds here. Closing the drill unmounts the panel and
            // takes its filters with it, but switching Engineering → Shop or July → August
            // does NOT: this component stays mounted deliberately, so without the key a
            // section filter set on Engineering would carry into Shop, where those sections
            // do not exist, and the table would open empty.
            key={`${drill}-${month}`}
            detail={scopedDetail}
            note={scopeNote}
            // Names the scope rather than where the click came from: "Engineering
            // hours" says what the table contains, where "(opened from
            // Engineering)" only said how you got here. This branch is reached only
            // for Engineering/Shop — Parts, Unattributed and OffGrid have their own
            // branches above, and the unscoped "All" (People Booked) retired with
            // its block (§64) — so the title is unconditional now.
            title={`${drill} hours — ${month}`}
            onClose={() => setDrill(null)}
          />
        ))
      )}
      </div>
      )}
      </div>
    </div>
  );
}

// The row itself (formerly this file's own `MetricBlock`) now lives in
// components/ui/KpiRow.tsx as `KpiRow`/`MemoKpiRow` — extracted so the T&M tab's
// summary can render the identical row instead of a second, driftable copy.
