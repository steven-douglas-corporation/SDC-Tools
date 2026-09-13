"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { card } from "@/components/ui/classnames";
import { abbreviateLabel } from "@/lib/abbrev";
import { SERIES } from "@/components/charts/theme";
import type { JobHoursDashboard as DashData, HoursType } from "@/lib/job-hours-dashboard";
import type { JobHoursDetail as JobHoursDetailData } from "@/lib/job-hours-detail";
import { POOL_QUOTED_SECTION, RESTRICTED_SECTION_CODES, WARRANTY_PHASE, OFF_GRID_PHASE, UNMAPPED_PHASE } from "@/lib/sections";
import { HoursDetailPanel } from "@/components/HoursDetailPanel";
import { PartsCostSummary } from "@/components/PartsCostSummary";
import { PartsCostDrill, type PartsDrillMode } from "@/components/PartsCostDrill";
import type { PartsCostFinancials } from "@/lib/parts-cost-financials-shared";
import { hours as fmtHours } from "@/components/ui/format";
import { barDomains, barHeightPct } from "@/lib/bar-scale";

// Project Management, the one section this chart never draws (see executionSections).
const PM_CODE = POOL_QUOTED_SECTION.ENGINEERING_PM;

// Warranty, Service & Spare Parts and Unmapped default OFF (2026-09-08, by
// request) — these three are "standard"/off-grid bands rather than the
// Complete Design & Build / Machine Testing work a job's hours are normally
// read against, and reference the same phase-name constants SECTIONS and
// job-hours-dashboard.ts define so a rename there can't silently desync this
// default from the chip it's meant to hide.
const DEFAULT_HIDDEN_PHASES = [WARRANTY_PHASE, OFF_GRID_PHASE, UNMAPPED_PHASE];

// The Parts Cost bullet bar (§52) joins the two hours charts in one row, so
// its inputs travel as one prop rather than a second top-level component the
// page has to lay out itself. Null when Parts Cost has nothing to show
// (Total ETO unreachable, or the selection is capped) — the row then falls
// back to its original two-column ratio instead of leaving an empty third cell.
export type JobHoursDashboardParts = {
  financials: PartsCostFinancials;
  jobCount: number;
};

// Web recreation of the Power BI "Job Detail" dashboard (hours half). The Hours
// Type toggle (Quoted / ETC) swaps the planned-basis series across the matrix
// and both charts, mirroring the report's field-parameter slicer.

// The section template the chart shows in full (even at zero hours) is no longer a
// constant here — it is derived from the payload, which is SECTIONS' own order. See the
// note on `phases` below for why the hardcoded two-phase list was a bug (§72).

// Divider color for the tiered category axis — darker than the default border
// so the dashed group dividers read clearly.
const TIER_DIVIDER = "#94a3b8";

// Synthetic final "phase" for the merged Engineering/Shop totals (formerly
// their own "{plannedLabel} and Actual by Billing Group" card) — not a real
// SECTIONS phase, so it can share the exact same pill-toggle mechanism
// (`phases`/`hiddenPhases`/`togglePhase`) as every other phase chip instead of
// a second on/off model to keep in sync with it.
const TOTAL_PHASE = "Total";

// Total section's own colors — grey, and ONLY for the Total section (by
// request, replacing the earlier green). Every other bar (Complete Design &
// Build, Machine Testing, Teardown & Install, any other real section) keeps
// the chart's original blue/navy SERIES pair from theme.ts; this pair exists
// so the Total section can stay visually distinct from the rest without
// recoloring them too. Both values are literal brand-guide neutrals, not
// invented greys: `--sdc-border` (the brand's own "Gray" swatch) and
// `--sdc-gray-600` — same ~15:1 contrast relationship the blue/navy pair
// gives every other section, so Quoted vs Actual reads just as clearly here.
const TOTAL_SERIES = {
  planned: "#d9d9d9", // light grey — Engineering/Shop Total, Quoted/ETC basis
  actual: "#2b2b2b", // dark grey — Engineering/Shop Total, Actual
} as const;

const fmt = fmtHours;

// ── Value-label collision avoidance for SectionHierarchyChart ───────────────
//
// Each bar's value label floats directly above that bar's own top edge
// (Bar, below), at whatever height its OWN value happens to scale to — there
// is no shared "label row". Two labels only ever collide when their bars
// land at nearly the same height right next to each other: the Quoted/Actual
// pair inside one section (tight `gap-1.5`, and a wide number like "1,234"
// is wider than the ~20px bar it sits over), or two ADJACENT sections whose
// bars are both near the chart's max — which is exactly what "Total" columns
// are, since a Total is a sum and so is usually the tallest bar(s) in the
// chart, sitting right next to each other.
//
// This runs as a post-layout DOM pass (measure, don't guess) rather than
// anything CSS-only, because whether two labels collide depends on live text
// width and live column width together — both vary with the data and with
// the card's own responsive width (§55's `minmax(0, 1fr)` columns
// deliberately shrink instead of forcing a horizontal scrollbar). It walks
// the labels in left-to-right visual/DOM order and only ever compares
// immediate neighbors — two non-adjacent labels that don't touch their
// shared neighbor can't be touching each other either. That's only true
// within ONE band of labels sharing a consistent left-to-right DOM order, so
// the bar value labels (`[data-value-label]`) and the diff badges sitting in
// their own row above them (`[data-diff-label]`) are resolved as two
// SEPARATE calls, not one merged list — the diff badges for columns N and
// N+1 are DOM-adjacent only to each other (every column's bars sit between
// them in the tree), and mixing the two bands would compare a diff badge
// against a bar label it never actually sits next to.
//
// Every pass starts by clearing prior offsets, so a resize or a data change
// that no longer collides never carries a stale nudge forward. Fixes escalate
// in the requested order and stop as soon as a pair clears:
//   1. (default) nothing — most labels never need help.
//   2. lift the right-hand label straight up, clamped to the chart's own top
//      edge so it can never poke out of the card.
//   3. nudge the pair apart horizontally, clamped to the chart's own left/right
//      edges.
//   4. shrink both labels one safe type-scale step at a time (never past
//      `--text-label`/10px — `--text-micro`/9px was tried for these exact
//      labels and rejected as unreadable, see the Bar comment below).
// Font-shrink steps as Tailwind classes, not `style.fontSize` — every other
// size change in this app goes through a class onto the type scale (never a
// hand-set style; see tests/typography.test.ts's guard against exactly that),
// and `text-xs` is already the label's own static className, so shrinking is
// just swapping it for a smaller step's class.
const FONT_SHRINK_CLASSES = ["text-note", "text-label"];

function resolveLabelOverlaps(container: HTMLElement, selector: string) {
  const labels = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter((el) => el.textContent);
  labels.forEach((el) => {
    el.style.transform = "";
    if (el.classList.contains("text-note") || el.classList.contains("text-label")) {
      el.classList.remove(...FONT_SHRINK_CLASSES);
      el.classList.add("text-xs");
    }
  });
  if (labels.length < 2) return;

  const bounds = container.getBoundingClientRect();
  const collide = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  let rects = labels.map((el) => el.getBoundingClientRect());

  const LIFT = 13; // px
  for (let i = 1; i < labels.length; i++) {
    if (!collide(rects[i - 1], rects[i])) continue;
    if (rects[i].top - LIFT < bounds.top) continue; // no headroom left — try the next fix instead
    labels[i].style.transform = `translateY(-${LIFT}px)`;
    rects[i] = labels[i].getBoundingClientRect();
  }

  const NUDGE = 5; // px, per side
  for (let i = 1; i < labels.length; i++) {
    if (!collide(rects[i - 1], rects[i])) continue;
    if (rects[i - 1].left - NUDGE >= bounds.left) {
      labels[i - 1].style.transform = `${labels[i - 1].style.transform} translateX(-${NUDGE}px)`.trim();
    }
    if (rects[i].right + NUDGE <= bounds.right) {
      labels[i].style.transform = `${labels[i].style.transform} translateX(${NUDGE}px)`.trim();
    }
    rects[i - 1] = labels[i - 1].getBoundingClientRect();
    rects[i] = labels[i].getBoundingClientRect();
  }

  // `text-xs` and the two shrink classes are all single-utility selectors of
  // equal specificity, so whichever one is LAST in the compiled stylesheet
  // wins regardless of classList order — always removing the others before
  // adding the active one keeps exactly one font-size class in play, rather
  // than leaving the result up to Tailwind's build-time class ordering.
  for (const step of FONT_SHRINK_CLASSES) {
    let anyLeft = false;
    for (let i = 1; i < labels.length; i++) {
      if (!collide(rects[i - 1], rects[i])) continue;
      anyLeft = true;
      labels[i - 1].classList.remove("text-xs", ...FONT_SHRINK_CLASSES);
      labels[i - 1].classList.add(step);
      labels[i].classList.remove("text-xs", ...FONT_SHRINK_CLASSES);
      labels[i].classList.add(step);
    }
    if (!anyLeft) break;
    rects = labels.map((el) => el.getBoundingClientRect());
  }
}

// Consecutive runs of a key, with counts — for the tiered dept/phase headers.
function groupRuns<T>(rows: T[], keyOf: (r: T) => string, labelOf: (r: T) => string) {
  const out: { label: string; count: number }[] = [];
  let lastKey: string | null = null;
  for (const r of rows) {
    const k = keyOf(r);
    if (k === lastKey) out[out.length - 1].count++;
    else { out.push({ label: labelOf(r), count: 1 }); lastKey = k; }
  }
  return out;
}

export function JobHoursDashboard({
  data,
  hoursDetail,
  parts = null,
  allowedPoolCodes = [],
}: {
  data: DashData;
  hoursDetail: JobHoursDetailData;
  parts?: JobHoursDashboardParts | null;
  /**
   * Standard Fees section codes the signed-in role may see, resolved server-side
   * from the same permission the Quoted page uses. Defaults to none, so a caller
   * that does not pass it gets the old behaviour rather than a silent widening.
   */
  allowedPoolCodes?: string[];
}) {
  const [hoursType, setHoursType] = useState<HoursType>("Quoted");
  const planned = (s: { quoted: number; etc: number }) => (hoursType === "Quoted" ? s.quoted : s.etc);
  const plannedLabel = hoursType === "Quoted" ? "Quoted" : "ETC";
  // ETC (unlike Quoted) is scoped to ONE month — `s.etc` above is already "effective
  // New ETC for latestEtcMonth only" (job-hours-dashboard.ts). Comparing that against
  // the section's lifetime Actual was comparing one month's plan to the whole job's
  // history; in ETC mode, Actual instead reads the same latestEtcMonth slice out of
  // `monthlyBySection` — the identical per-month figures the drill-through below
  // already shows, so the two can't disagree. Quoted has no month of its own, so its
  // Actual stays the lifetime figure it always was.
  const actualHours = (s: { code: string; actual: number }) =>
    hoursType === "Quoted"
      ? s.actual
      : data.monthlyBySection[s.code]?.find((m) => m.month === data.kpis.latestEtcMonth)?.worked ?? 0;

  // ── The Standard Fees pools, gated by PERMISSION not by default (2026-09-02) ─
  //
  // PM, Manufacturing and both Warranty sections are company-wide "Standard Fees"
  // pools — planned centrally rather than quoted per job — and the Projects/Quoted
  // pages gate them on the matching grant (restrictedSectionPermission).
  //
  // This chart excluded all four from EVERYONE: data, phase chips, tooltips,
  // drill-through and the billing-group totals. That hid real punched hours at
  // every permission level — 556h of Manufacturing on job 1131, 1,178h on 1104,
  // 1,027h on 1118 — hours that were in the payload, reconciled against the punch
  // table, and drawn nowhere. Hiding a number from everybody is not access
  // control; it is a figure nobody can audit.
  //
  // `allowedPoolCodes` is resolved on the server from the signed-in role (see
  // job-hours/page.tsx), so a role holding the grant now sees these sections and a
  // role without it sees exactly what it saw before. Everything downstream —
  // chips, bars, totals, drill — reads `executionSections`, so this one filter
  // governs all of them.
  const allowedPools = useMemo(() => new Set(allowedPoolCodes), [allowedPoolCodes]);
  // ── PM is off the chart entirely (2026-09-02) ─────────────────────────────
  //
  // Project Management (10-111) is not drawn here at ANY permission level, by
  // request: its quoted figure is a company-wide pool allocation rather than a
  // per-job estimate, so a "quoted vs actual" bar for it compares two things
  // that were never meant to line up, and it led the chart as the leftmost
  // section. Dropping it from `executionSections` — the one row set the bars,
  // the phase chips, the tooltips, the drill-through and the Engineering/Shop
  // totals all read — removes the bars, the labels and the PM tier header
  // together, and the totals stay the sum of the bars actually shown.
  //
  // Chart-only: the payload still carries 10-111, `jobActualTotal` below still
  // counts it against the punch table, and the Quoted/Projects pages and the
  // Standard Fees pools are untouched. Only this visualization omits it.
  const executionSections = useMemo(
    () =>
      data.sections.filter(
        (s) => s.code !== PM_CODE && (!RESTRICTED_SECTION_CODES.has(s.code) || allowedPools.has(s.code)),
      ),
    [data.sections, allowedPools],
  );

  // ── Every phase the section template defines, DERIVED (§72) ───────────────
  //
  // This was a hardcoded `TEMPLATE_PHASES = ["Complete Design & Build", "Machine
  // Testing"]`, which silently dropped Teardown & Install (50-211/50-411) and Warranty
  // (70-211/70-411) from the chart even though the backend returns them — `sections` is
  // `SECTIONS.map(...)`, so all 17 rows have always been in the payload. The old comment
  // claimed the list matched the Power BI report; the report shows those phases, so it
  // did not. Deriving it means adding a section to sections.ts is the whole change, and
  // the chart cannot fall behind that list again.
  //
  // Order comes from the payload, which is SECTIONS' own order — the canonical sheet
  // order the phase-header tiers already rely on, so the hierarchy is unchanged. Built
  // off `executionSections`, not `data.sections`, so Warranty — now entirely restricted
  // — has no chip left to toggle rather than one that does nothing.
  const phases = useMemo(() => {
    const seen: string[] = [];
    for (const s of executionSections) if (!seen.includes(s.phase)) seen.push(s.phase);
    // The merged Engineering/Shop totals get the same toggleable pill every
    // real phase does, appended last so it reads as the chart's final section.
    seen.push(TOTAL_PHASE);
    return seen;
  }, [executionSections]);

  // ── Hidden, not active (§72) ───────────────────────────────────────────────
  //
  // The filter tracks which phases are switched OFF rather than which are on, and that
  // is deliberate: "show everything except the defaults" is then just
  // DEFAULT_HIDDEN_PHASES, which stays correct however many phases the payload has —
  // a phase not in that list is on with no further bookkeeping. The previous
  // `useState(() => new Set(TEMPLATE_PHASES))` seeded itself once from a fixed
  // *allow*-list, so a phase that appeared later could never be active at all; this is
  // a fixed *default-off* list instead, which only ever suppresses phases named in it
  // and never hides one the payload adds. Seeded directly in the initializer (not via
  // an effect that re-seeds off `phases`) so there is no flicker and no
  // set-state-in-effect violation, the pattern this codebase has already been bitten
  // by (§36.4).
  const [hiddenPhases, setHiddenPhases] = useState<Set<string>>(() => new Set(DEFAULT_HIDDEN_PHASES));

  // Drill-through target: the section code whose monthly detail is open, or null.
  // Parts already had a drill (JobProcurement's drillToPart); the hours charts
  // had no click behaviour at all, so a section 680 hours over told you nothing
  // about WHEN that happened. Stored as a code rather than the row object so it
  // survives a Quoted/ETC toggle re-deriving `hierRows`.
  const [drillCode, setDrillCode] = useState<string | null>(null);

  // ── Parts Cost drill (2026-09-02) ─────────────────────────────────────────
  //
  // Which part of the Parts Cost bar is open, or null. Independent of `drillCode`
  // (the section-hours drill) on purpose: they answer different questions about the
  // same job and either can be open without disturbing the other. Held here rather
  // than inside the card because the panel renders full width below the charts row —
  // a part-level table cannot be read in the ~15% column the card occupies.
  //
  // No fetch and no loading state: the rows are already in `parts.financials.lines`,
  // fetched once for the card itself. Opening this cannot block the page because
  // there is nothing to wait for.
  const [partsDrill, setPartsDrill] = useState<PartsDrillMode | null>(null);

  // Every remaining execution section the backend sent, at zero hours or not — the
  // template is shown in full, which is what keeps a zero-value category visible
  // exactly as Power BI shows it.
  const visible = useMemo(
    () => executionSections.filter((s) => !hiddenPhases.has(s.phase)),
    [executionSections, hiddenPhases],
  );

  // Same shared `hiddenPhases` state the rest of the chart filters by, but over
  // `data.sections` rather than `visible` — the chart also drops PM/Mfg/Warranty
  // permanently (RESTRICTED_SECTION_CODES), and that exclusion is deliberately
  // scoped to the real section bars, not the Engineering/Shop totals merged in
  // below. Resummed client-side from the per-section `billingGroup` the payload
  // already carries, rather than read from the server's whole-job
  // `data.billingGroups`, so the totals answer to the one filter instead of
  // silently disagreeing about what's selected.
  // ── The totals are the sum of the BARS (2026-09-02) ───────────────────────
  //
  // This filtered `data.sections`, not `executionSections`, so the Standard Fees
  // pools were excluded from every bar and then added back into Engineering
  // Total and Shop Total. Measured on job 1131: the Shop bars summed to 904.23
  // while Shop Total read 1,104.77 — the 200.54h difference being Manufacturing
  // (10-413), a section the chart deliberately does not draw. A total that
  // exceeds the things it totals is unreconcilable by anyone reading the screen,
  // and it is the same class of mistake as computing bars and totals from two
  // datasets.
  //
  // Now derived from the identical row set the bars are, so Engineering Total is
  // by construction the sum of the Engineering bars and Shop Total the sum of the
  // Shop bars, under whatever phase filter is active.
  const bgSections = executionSections.filter((s) => !hiddenPhases.has(s.phase));
  const bgSums = new Map<string, { quoted: number; etc: number; actual: number }>();
  for (const s of bgSections) {
    const cur = bgSums.get(s.billingGroup) ?? { quoted: 0, etc: 0, actual: 0 };
    cur.quoted += s.quoted;
    cur.etc += s.etc;
    cur.actual += actualHours(s);
    bgSums.set(s.billingGroup, cur);
  }
  // The former "{plannedLabel} and Actual by Billing Group" card — same sums,
  // now the chart's own final "Total" section, gated by the "Total" pill above
  // instead of always shown in a second card.
  const totalRows: HierRow[] = hiddenPhases.has(TOTAL_PHASE)
    ? []
    : (["Engineering", "Shop"] as const)
        .map((g) => ({ group: g, ...(bgSums.get(g) ?? { quoted: 0, etc: 0, actual: 0 }) }))
        .filter((g) => g.quoted || g.etc || g.actual)
        .map((g) => ({
          code: `total-${g.group}`,
          name: `${g.group} Total`,
          group: g.group,
          phase: TOTAL_PHASE,
          planned: hoursType === "Quoted" ? g.quoted : g.etc,
          actual: g.actual,
          drillable: false,
        }));
  const hierRows = [
    ...visible.map((s) => ({ code: s.code, name: s.name, group: s.group, phase: s.phase, planned: planned(s), actual: actualHours(s) })),
    ...totalRows,
  ];

  // Resolved against the CURRENT rows, so hiding the drilled section's phase (or
  // it dropping out of the template) closes the panel rather than leaving it
  // showing a section that's no longer on the chart.
  const drillRow = drillCode ? (hierRows.find((r) => r.code === drillCode) ?? null) : null;
  // Every section, not just the visible ones: the punch table below is
  // unfiltered, so the figure it's compared against has to be too.
  const jobActualTotal = data.sections.reduce((sum, s) => sum + s.actual, 0);

  const togglePhase = (p: string) =>
    setHiddenPhases((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });

  return (
    <div className="space-y-5">
      {/* The KPI indicator cards (Active Jobs, Hours Refreshed Thru, Latest ETC
          Month) moved up into the page's header row (§57), where they sit
          beside the project-title card on one line. The "Eng Design-to-Debug
          Ratio" card was removed there. */}

      {/* Controls: Hours Type + phase filter */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="inline-flex rounded-lg bg-sdc-gray-100 p-1">
          {(["Quoted", "ETC"] as HoursType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setHoursType(t)}
              className={`rounded-md px-4 py-1.5 text-sm font-medium motion-interactive ${
                hoursType === t ? "bg-white text-sdc-blue-dark shadow-sm" : "text-sdc-gray-600 hover:text-sdc-navy"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        {/* One chip per phase the payload actually contains (§72) — so Teardown &
            Install and Warranty are filterable like the other two rather than absent. */}
        <div className="flex flex-wrap gap-1.5">
          {phases.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => togglePhase(p)}
              aria-pressed={!hiddenPhases.has(p)}
              className={`rounded-full border px-3 py-1 text-xs motion-interactive ${
                !hiddenPhases.has(p)
                  ? "border-sdc-blue bg-sdc-blue-light text-sdc-blue-dark"
                  : "border-sdc-border-soft text-sdc-muted hover:text-sdc-navy"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {hierRows.length === 0 ? (
        <div className={card("p-8")}>
          {/* Two different nothings, said differently: a job with no section template at
              all, versus every phase switched off by the chips above. The old copy
              claimed the former in both cases. */}
          <p className="text-center text-sdc-muted">
            {data.sections.length === 0
              ? "No hours recorded for this job yet."
              : "Every phase is hidden — switch one back on above to see the chart."}
          </p>
        </div>
      ) : (
      <>
      {/* Charts — Estimate to Complete vs Actual and Parts Cost, in one row on
          normal desktop screens, uniform height and aligned top/bottom
          (§54.3-54.5). The former "{plannedLabel} and Actual by Billing Group"
          card is gone — its Engineering/Shop totals are the chart's own final
          "Total" section now (see hierRows/totalRows above), toggled by the
          "Total" pill instead of living in a second card. Stretch is the
          DEFAULT — `items-stretch` — so idle, both cards match the taller one
          exactly. The one exception is while the chart's drill-through is
          open: that content is "absolutely required" per §54.5, so
          `items-start` takes over for that state only rather than stretching
          Parts Cost to match a much taller card and reopening the
          empty-space problem §33 fixed for the KPI summary card (see
          drill-cap-scroll-ceiling in the memory notes / DEVLOG §33).

          §55: the chart card is the WIDER of the two — it holds the most
          content, the tiered section chart, and the extra width plus the
          responsive chart (see SectionHierarchyChart) lets it show every
          section in full with no internal scroll. Falls back to full width
          when there's no Parts Cost to show, rather than leaving an empty
          cell.

          §81 (by request): 17fr/3fr, an explicit 85/15, up from §55's 2fr/1fr
          (67/33) — Parts Cost shrank to fit (see PartsCostSummary's own
          BAR_W/LEGEND_W comments), so the chart could take the rest. Plain
          `3fr`, not `minmax(0,3fr)`: a bare `<flex>` track is `minmax(auto,
          3fr)`, and PartsCostSummary's card deliberately carries no
          `min-w-0` of its own, so "auto" resolves to the card's real
          content-based minimum — the row renders at true 85/15 whenever a
          job's dollar amounts fit that (every job seen so far), and only
          ever gives the card more than 15% on a job whose own money text
          needs it, rather than forcing exactly 15% and letting the numbers
          overlap. See that card's own root-div comment. */}
      <div
        className={`grid grid-cols-1 gap-3 ${drillRow ? "items-start" : "items-stretch"} ${
          parts ? "lg:grid-cols-[17fr_3fr]" : ""
        }`}
      >
        <div className={`${card("p-4")} flex h-full min-w-0 flex-col`}>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3">
            <p className="font-heading text-base font-bold tracking-tight text-sdc-navy">Estimate to Complete vs Actual</p>
            <p className="text-note text-sdc-gray-400">Click a section for its month-by-month detail</p>
          </div>
          <SectionHierarchyChart rows={hierRows} plannedLabel={plannedLabel} onDrill={setDrillCode} drillCode={drillCode} />
          {drillRow && (
            <>
              <SectionDrill
                row={drillRow}
                plannedLabel={plannedLabel}
                monthly={data.monthlyBySection[drillRow.code] ?? []}
                onClose={() => setDrillCode(null)}
              />
              {/* The punch-level table, preselected to the section just clicked
                  — the report's drillthrough page, one level further down than
                  the monthly summary above it. */}
              <HoursDetailPanel
                detail={hoursDetail}
                // The panel's own `mt-4` moved out to its callers when the Monthly ETC
                // card started rendering it side by side. Here it still sits BELOW the
                // chart above it, so it still wants the gap.
                className="mt-4"
                initialSection={drillRow.code}
                // Arriving here from a section bar, "who worked it" is the useful
                // rollup — Department is one click away in the same tray if wanted.
                defaultGroupBy={["employee"]}
                // The section you clicked is already fixed above (initialSection) and
                // the punches are already scoped to one job; a Department/Employee
                // filter on top of that narrows a table that's already narrow, and
                // Employee grouping covers the "who" question the Employee filter
                // would otherwise answer.
                hideFilters={["department", "employee"]}
                // The Actual bar above covers the job's whole life; this table
                // only holds punches from the window the Paylocity export
                // reaches back to. On an older job the two legitimately differ,
                // and saying so beats leaving someone to find the gap and
                // conclude the page is broken — which is how this whole thread
                // started.
                // Whole-job figures on both sides: this table lists every
                // section, not just the one drilled into.
                note={
                  jobActualTotal - hoursDetail.total > 1
                    ? `Actual for this job is ${Math.round(jobActualTotal).toLocaleString()}h; the punch records below reach back only as far as the payroll export, so they total ${Math.round(hoursDetail.total).toLocaleString()}h. Earlier hours are carried as period totals.`
                    : undefined
                }
                onClose={() => setDrillCode(null)}
              />
            </>
          )}
        </div>
        {parts && (
          <PartsCostSummary
            financials={parts.financials}
            jobCount={parts.jobCount}
            onDrill={setPartsDrill}
            drillMode={partsDrill}
          />
        )}
      </div>
      {/* Full width, below the row — the detail table has eleven columns and the card
          that opens it is the narrow one. Rendered as a sibling of the row rather than
          inside the card, so opening it cannot resize either chart above it (§54.5's
          reason for `items-start` while a drill is open). */}
      {parts && partsDrill && (
        <PartsCostDrill
          financials={parts.financials}
          mode={partsDrill}
          // The same jobs the card's money covers, so the ETC history cannot be
          // scoped differently from the figure it explains.
          jobIds={data.jobRefs.map((j) => j.id)}
          jobLabel={
            parts.jobCount > 1
              ? `${parts.jobCount} selected jobs`
              : `${data.job.jobId} — ${data.job.jobName}`
          }
          onModeChange={setPartsDrill}
          onClose={() => setPartsDrill(null)}
          className="mt-3"
        />
      )}
      </>
      )}
    </div>
  );
}


type HierRow = {
  code: string;
  name: string;
  group: string;
  phase: string;
  planned: number;
  actual: number;
  /** false for the synthetic Total-section rows — they have no month-by-month
   *  data behind them to drill into, so the column stays a static bar. */
  drillable?: boolean;
};

// One Quoted/Actual bar, with its own value label above it. A MODULE-LEVEL
// component, not defined inline inside SectionHierarchyChart (found live,
// 2026-08-13): a component declared inside another function's body is a NEW
// function identity every render, so React treats `<Bar>` as a different
// component type each time and unmounts+remounts its DOM instead of just
// re-rendering it. That's invisible for ordinary declarative JSX (React
// recreates the exact same markup either way) — but resolveLabelOverlaps
// mutates these spans' `style` directly, OUTSIDE React's render cycle, and a
// remount silently wipes that out. It reproduced as: the fix visibly running
// (confirmed by instrumenting the resolve pass itself, which fired and chose
// to apply a lift) with nothing observable in the DOM moments later — the
// entrance animation's `grown` state flip (a re-render `resolveLabelOverlaps`
// has no reason to depend on) was remounting the bar right out from under it.
function Bar({ value, color, heightPct, grown }: { value: number; color: string; heightPct: number; grown: boolean }) {
  return (
    // §55: `flex-1 min-w-0 max-w-5` — the bar fills the space its column gives
    // it, up to its old 20px width, and shrinks below that on a narrow column
    // rather than overflowing. `w-5` was a fixed width that forced the 640px
    // chart floor; the cap keeps wide columns looking exactly as before.
    <div className="flex h-full min-w-0 max-w-5 flex-1 flex-col items-center justify-end">
      {/* text-xs/font-bold/sdc-navy (2026-08-12, by request — "much easier to
          read... especially for smaller bars"), up from text-micro/text-sdc-muted:
          a 9px unweighted #6e6a6b label on a chart that can hold a 1-hour bar was
          the exact complaint. sdc-navy, not a new color — the same dark token
          Parts Cost's own bar labels already use, so both charts land on one
          shade rather than two independently "dark enough" ones.
          `data-value-label` is resolveLabelOverlaps' only hook into the DOM —
          it walks every element with this attribute, in left-to-right order,
          and nudges apart whichever neighboring pair its own measurements
          say are actually touching. */}
      <span data-value-label className="mb-2 text-xs font-bold leading-none text-sdc-navy">{value ? fmt(value) : ""}</span>
      {/* ── scaleY, not height (§36.2, §36.14, §36.15) ──────────────────────────
          This was `transition-[height] duration-500`, which broke three of §36's
          rules at once on a chart that can hold twenty bars:
            * 500ms is well past the ~300ms ceiling for anything an interaction or a
              data change triggers (§36.2);
            * `height` is a layout property, so every frame relaid out the whole
              chart grid — twenty bars × 30 frames of layout (§36.15);
            * and because each bar grew from 0, the value LABEL above it (a sibling
              in this flex column) travelled up with it for half a second, so the
              numbers were unreadable while they moved (§36.14).
          The bar now takes its final height immediately — which is what fixes the
          label — and scales up from the baseline on the compositor. Same growing
          gesture, one property, no layout. */}
      <div
        className="w-full origin-bottom rounded-t-sm"
        style={{
          height: `${heightPct}%`,
          background: color,
          transform: grown ? "scaleY(1)" : "scaleY(0)",
          transitionProperty: "transform",
          transitionDuration: "var(--motion-panel)",
          transitionTimingFunction: "var(--ease-out)",
        }}
      />
    </div>
  );
}

// Custom grouped-column chart with the Power BI tiered category axis:
// Section names → Department → Phase, with dashed dividers between groups. Shows
// every template section, even at zero. Grid columns = sections so the tiers
// line up by construction (no pixel math).
function SectionHierarchyChart({
  rows,
  plannedLabel,
  onDrill,
  drillCode,
}: {
  rows: HierRow[];
  plannedLabel: string;
  onDrill: (code: string | null) => void;
  drillCode: string | null;
}) {
  // 546, up from 420 (2026-08-14, by request — plot area ~30% taller so bars
  // are easier to compare). Same mechanism as the 300→420 pass before it:
  // raising this constant IS the fix, since `scalePct` below already resolves
  // the tallest bar to exactly 100% of BAR_H with no headroom above it (no
  // `max: dataMax * 1.X`, no fixed-height gray track — both were tried
  // elsewhere in this app and reverted, see PartsCostSummary's BAR_H comment),
  // so more pixels here is more pixels under every bar, in exact proportion,
  // with nothing else to change. Kept in step with PartsCostSummary's own
  // BAR_H — see that constant's comment for the baseline-alignment math this
  // owes it (same +126 delta applied there).
  const BAR_H = 546;
  // Room reserved ABOVE the plot area for the value labels (2026-08-24).
  // A text-xs bold label is ~12px on this type scale, plus the label's own mb-2
  // (~7.5px) and a little slack, so the tallest bar's label sits fully inside
  // the chart box instead of overflowing into the diff-badge row above it.
  const LABEL_HEADROOM = 26;
  // ── Two domains: the detail bars, and the Total band (2026-08-24) ─────────
  //
  // A Total is the SUM of the sections beside it, so on one shared scale it is
  // always the tallest bar by roughly an order of magnitude — which left every
  // department bar at a tenth of the plot height. That is the reported problem,
  // and BAR_H is not the lever for it: `scalePct` already resolves the tallest
  // bar to exactly 100% with no headroom, so there is no unused whitespace above
  // it to reclaim. Raising BAR_H (300 -> 420 -> 546, twice by request) makes
  // every bar taller in proportion but cannot change the RATIO between a section
  // and a sum of sections.
  //
  // So the Total rows no longer set the detail scale. Sections are measured
  // against the tallest SECTION, Totals against the tallest TOTAL.
  //
  // Why this is not the square-root curve that was tried and reverted on
  // 2026-08-20: that curve broke proportionality CONTINUOUSLY — every pair of
  // bars anywhere in the chart lied about its ratio, including two sections
  // sitting side by side. Here proportionality is exact everywhere it is
  // meaningful to compare: within the sections (equal values give equal heights,
  // a larger section is always proportionally taller), and within the Total band
  // (Engineering Total against Shop Total stays honest). What is no longer
  // comparable by height is a section against a Total — a comparison that was
  // never useful, because one contains the other.
  //
  // The Total band is already set apart rather than blending in: its own grey
  // series (TOTAL_SERIES), its own section label, and its own "Total" pill to
  // hide it. That separation is what keeps two domains legible instead of
  // misleading — and the value label above every bar carries the real number
  // regardless.
  // The domains and the height maths live in lib/bar-scale.ts so the
  // proportionality invariants can be tested — this chart has lost them once
  // before (a sqrt curve, reverted 2026-08-20), and tests/bar-scale.test.ts is
  // what stops that recurring quietly.
  const domains = barDomains(rows.map((r) => ({ planned: r.planned, actual: r.actual, isTotal: r.phase === TOTAL_PHASE })));
  const scalePct = (value: number, isTotal: boolean) => barHeightPct(value, isTotal, domains);
  const deptRuns = groupRuns(rows, (r) => `${r.phase}|${r.group}`, (r) => r.group);
  const phaseRuns = groupRuns(rows, (r) => r.phase, (r) => r.phase);
  // ── A floor under the category column (2026-09-02) ────────────────────────
  //
  // This was `minmax(0, 1fr)` — §55's deliberate choice, so the columns shrink
  // to fit the card instead of forcing a scrollbar. On a job with a handful of
  // sections that is right. On a dense one it is not: measured live on job 1104,
  // 26 categories share the label row, and every label is squeezed into a slot
  // far narrower than its own longest WORD:
  //
  //     zoom 80%   row 807px   slot 27px   19 of 26 labels overflow
  //     zoom 100%  row 615px   slot 20px   20 of 26
  //     zoom 125%  row 462px   slot 14px   26 of 26   <- every one
  //
  // The labels already wrap; what cannot wrap is a single word. "Manufacturing"
  // is 75px on its own and there is no width below that at which it fits, so it
  // spills across its neighbours and the axis becomes unreadable. Note this is
  // NOT a zoom bug — it is broken at 100% too — but zoom makes it strictly worse,
  // because a higher zoom leaves fewer layout pixels for the same 26 columns.
  //
  // 78px is measured, not chosen: the widest single word across every category
  // label in this chart is "Manufacturing" at 75px, plus the column's own 3px of
  // padding. Every label can therefore wrap onto two or three lines with no word
  // broken mid-syllable.
  //
  // The trade-off §55 rejected is now taken deliberately, because the request
  // asks for it in those words — "if the chart becomes too dense at a given
  // zoom, allow internal horizontal scrolling rather than overlapping text".
  // The scroll only appears when the columns genuinely cannot fit: below that,
  // `1fr` still spreads them across the full card exactly as before.
  const CATEGORY_MIN_PX = 78;
  const colStyle = { gridTemplateColumns: `repeat(${rows.length}, minmax(${CATEGORY_MIN_PX}px, 1fr))` } as const;

  // Entrance animation — bars grow up from 0 on mount / when the data changes.
  // Two rAFs so the 0-height paints first.
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    // The entrance-animation trigger itself, not state derived from
    // anything React already knows: forces a 0-height paint (synchronous
    // setState back to false) before the double rAF flips it to true so the
    // browser has something to transition FROM. There's no way to get this
    // timing without an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGrown(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true)));
    return () => cancelAnimationFrame(id);
  }, [rows]);

  // Re-run the value-label collision pass whenever the data changes or the
  // card is resized — the two things that change which labels, if any,
  // collide. `useLayoutEffect`, not `useEffect`: it must apply before the
  // browser paints, or a colliding pair would flash unreadable for one frame
  // before jumping apart. Bar heights themselves are already final at the
  // first layout (the animation above only scales them visually via
  // `transform`, see the Bar comment below), so this doesn't need to wait for
  // that transition to finish.
  //
  // It DOES need to wait for `document.fonts.ready`, found live: the first
  // layout pass measures these bold digits in whatever fallback font is
  // active before Montserrat finishes loading, which is narrower — so a pair
  // that only just barely fits shows no collision yet, decides it needs no
  // help, and then the real font swaps in wider and the two labels end up
  // overlapping with nothing ever re-checking them (a font swap resizes no
  // element's box, so the `ResizeObserver` below never fires for it either).
  //
  // It ALSO needs one delayed re-check after mount specifically (found live,
  // 2026-08-13): on a hard navigation to this page, the very first pass
  // consistently measures these labels as clear of each other, and nothing
  // afterward disagrees — no resize, no font swap — yet the same labels DO
  // measure as colliding moments later and stay that way. A later
  // client-side data change (switching the Quoted/ETC toggle, which is the
  // same code path) always resolves correctly on the first try, so this is
  // specific to whatever finishes settling right after this component's
  // first paint on a cold load (most likely this card's row in the page
  // still gaining or losing height as sibling cards above it — Parts Cost,
  // the KPI tiles — finish their own first paint). One extra pass a moment
  // later is cheap insurance against that gap; the direct call above still
  // keeps the common case (and every resize/font-load/data-change after it)
  // correct with no visible delay.
  const barsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = barsRef.current;
    if (!el) return;
    let cancelled = false;
    const resolveAll = () => {
      if (cancelled) return;
      resolveLabelOverlaps(el, "[data-value-label]");
      resolveLabelOverlaps(el, "[data-diff-label]");
    };
    resolveAll();
    document.fonts.ready.then(resolveAll);
    const settleTimer = setTimeout(resolveAll, 300);
    const observer = new ResizeObserver(resolveAll);
    observer.observe(el);
    return () => {
      cancelled = true;
      clearTimeout(settleTimer);
      observer.disconnect();
    };
  }, [rows]);

  return (
    // §55: `w-full`, not `min-w-[640px]` — the chart fits its card exactly and
    // never forces the card to scroll horizontally. `min-w-0` lets it shrink
    // inside the flex column above it.
    <div className="w-full min-w-0">
      <div className="mb-2 flex items-center gap-4 text-xs text-sdc-gray-600">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SERIES.planned }} /> {plannedLabel}</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SERIES.actual }} /> Actual</span>
      </div>
      {/* ── The scroll frame (2026-09-02) ──────────────────────────────────
          Wraps the bars AND all three label tiers, so they scroll as one and
          cannot drift out of alignment — every one of them is laid out from the
          same `colStyle`, so a shared scroll parent keeps a bar over its own
          label by construction.

          It only ever scrolls when the columns hit their 78px floor (see
          CATEGORY_MIN_PX): with room to spare, `1fr` still fills the card and no
          scrollbar appears at all. `overscroll-x-contain` stops a horizontal
          fling here from turning into a browser back-navigation. */}
      <div className="styled-scrollbar overflow-x-auto overscroll-x-contain">
      {/* Bars — with the Quoted−Actual variance called out on top of each group
          (green when Actual is under Quoted, red when over). `barsRef` is the
          collision pass's measurement frame — its own edges are the "don't
          overflow the chart" boundary a lifted or nudged label is clamped
          against. */}
      <div
        ref={barsRef}
        className="grid items-end gap-x-1"
        // height = BAR_H + LABEL_HEADROOM with matching paddingTop. Under
        // border-box (Tailwind's preflight) the CONTENT box stays exactly
        // BAR_H, so every bar's `height: n%` resolves against the same 546px it
        // always did — the scaling from the previous pass is untouched. The
        // padding is pure headroom for the value labels.
        //
        // Before this, the tallest bar filled the box edge to edge and its label
        // had to overflow the top to exist at all. Two things followed: the
        // label could ride up into the diff-badge row above, and every lift in
        // resolveLabelOverlaps was skipped for those labels, because the clamp
        // `rects[i].top - LIFT < bounds.top` was already true before it moved.
        // With headroom, that clamp does what it was written to do.
        style={{ ...colStyle, height: BAR_H + LABEL_HEADROOM, paddingTop: LABEL_HEADROOM }}
      >
        {rows.map((r) => {
          const diff = r.planned - r.actual; // Quoted − Actual: + = under Quoted (green), − = over (red)
          const has = r.planned !== 0 || r.actual !== 0;
          // The synthetic Total-section rows have no month-by-month data behind
          // them (see HierRow.drillable) — the column stays a static bar rather
          // than a dead-end click that opens an empty drill panel.
          const interactive = r.drillable !== false;
          // Grey is reserved for the Total section only — every real section
          // keeps the chart's original blue/navy SERIES pair.
          const isTotal = r.phase === TOTAL_PHASE;
          const colors = isTotal ? TOTAL_SERIES : SERIES;
          return (
            <div
              key={r.code}
              // A real button: the whole column is the drill target, and it's
              // keyboard-reachable. Clicking the open section closes it again.
              // `aria-label`, not `title` — a native title attribute is itself a
              // hover tooltip, which this chart no longer shows on any bar.
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-pressed={interactive ? drillCode === r.code : undefined}
              aria-label={interactive ? `${r.name} — click for month-by-month detail` : r.name}
              onClick={interactive ? () => onDrill(drillCode === r.code ? null : r.code) : undefined}
              onKeyDown={
                interactive
                  ? (e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      onDrill(drillCode === r.code ? null : r.code);
                    }
                  : undefined
              }
              className={`flex h-full flex-col rounded-sm motion-interactive ${interactive ? "cursor-pointer hover:bg-sdc-blue-light/30" : ""} ${
                interactive && drillCode === r.code ? "bg-sdc-blue-light/60 ring-1 ring-sdc-blue" : ""
              }`}
            >
              {/* `data-diff-label`, resolved separately from the value labels
                  below — every column's own diff badge sits directly beside
                  its neighbors' in this row, but a bar's value label sits
                  between them in the DOM, so the two bands need their own
                  passes (see resolveLabelOverlaps' header comment). */}
              <div
                data-diff-label
                className={`h-4 text-center text-note font-bold leading-none ${!has ? "text-transparent" : diff > 0 ? "text-sdc-green-text" : diff < 0 ? "text-red-600" : "text-sdc-gray-400"}`}
              >
                {has ? `${diff > 0 ? "+" : ""}${fmt(diff)}` : ""}
              </div>
              <div className="flex flex-1 items-end justify-center gap-1.5">
                <Bar value={r.planned} color={colors.planned} heightPct={scalePct(r.planned, isTotal)} grown={grown} />
                <Bar value={r.actual} color={colors.actual} heightPct={scalePct(r.actual, isTotal)} grown={grown} />
              </div>
            </div>
          );
        })}
      </div>
      {/* Tier 1 — section names (variance is shown on top of the bars above) */}
      <div className="grid gap-x-1 border-t pt-1" style={{ ...colStyle, borderTopColor: TIER_DIVIDER }}>
        {rows.map((r) => (
          <div key={r.code} className="px-0.5 text-center leading-tight">
            {/* `break-words`: the column floor above fits today's longest word,
                and this is the backstop for a longer one arriving later — it
                breaks inside the word rather than spilling over the neighbour,
                which is the failure this whole change is about. */}
            <div className="text-label break-words text-sdc-navy">{r.name}</div>
          </div>
        ))}
      </div>
      {/* Tier 2 — department, spanning its sections */}
      <div className="mt-1 grid" style={colStyle}>
        {deptRuns.map((g, i) => (
          <div key={i} style={{ gridColumn: `span ${g.count}`, borderLeftColor: TIER_DIVIDER }} className="border-l border-dashed py-0.5 text-center text-label font-medium text-sdc-gray-600 first:border-l-0">
            {abbreviateLabel(g.label)}
          </div>
        ))}
      </div>
      {/* Tier 3 — phase, spanning its departments */}
      <div className="mt-0.5 grid" style={colStyle}>
        {phaseRuns.map((p, i) => (
          <div key={i} style={{ gridColumn: `span ${p.count}`, borderLeftColor: TIER_DIVIDER, borderTopColor: TIER_DIVIDER }} className="border-l border-t border-dashed py-1 text-center text-note font-semibold text-sdc-navy first:border-l-0">
            {abbreviateLabel(p.label)}
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}

// Drill-through detail for one section, opened by clicking its column above.
//
// The charts answer "how much" and "how far off"; this answers "when". Actual
// hours arrive one ETC month at a time, so a section 680 hours over is either a
// steady overrun or one bad month, and those call for different conversations.
// Everything here comes from EtcEntry rows the page already loads — no extra
// query, which is why the panel opens instantly.
function SectionDrill({
  row,
  plannedLabel,
  monthly,
  onClose,
}: {
  row: HierRow;
  plannedLabel: string;
  monthly: { month: string; worked: number }[];
  onClose: () => void;
}) {
  const diff = row.planned - row.actual; // + = under plan
  const peak = Math.max(1, ...monthly.map((m) => m.worked));
  // Running total, so you can see where the plan was crossed rather than
  // inferring it from the monthly bars. Built with an explicit loop rather than
  // a map() closing over a mutable accumulator — the latter reassigns during
  // render, which the react-hooks/immutability rule (correctly) rejects.
  const rowsWithRunning: { month: string; worked: number; running: number }[] = [];
  for (const m of monthly) {
    const prev = rowsWithRunning[rowsWithRunning.length - 1]?.running ?? 0;
    rowsWithRunning.push({ ...m, running: prev + m.worked });
  }
  // Newest month first for display — `running` above is still each month's true
  // cumulative-to-date total, which only makes sense computed oldest-first; only
  // the row ORDER reverses, so the top row shows the largest running figure.
  const displayRows = [...rowsWithRunning].reverse();

  return (
    <div className="mt-4 rounded-lg border border-sdc-blue-100 bg-sdc-blue-light/30 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-sdc-navy">{row.name}</p>
          <p className="text-note text-sdc-muted">
            {row.phase} · {row.group} · {row.code}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-sdc-border bg-white px-2 py-1 text-note font-medium text-sdc-navy hover:bg-sdc-blue-light"
        >
          Close
        </button>
      </div>

      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <span className="text-sdc-gray-600">
          {plannedLabel}: <span className="font-semibold tabular-nums text-sdc-navy">{fmt(row.planned)}</span>
        </span>
        <span className="text-sdc-gray-600">
          Actual: <span className="font-semibold tabular-nums text-sdc-navy">{fmt(row.actual)}</span>
        </span>
        <span className={`font-semibold tabular-nums ${diff > 0 ? "text-sdc-green-text" : diff < 0 ? "text-red-600" : "text-sdc-gray-400"}`}>
          {diff > 0 ? "Under" : diff < 0 ? "Over" : "On"} {plannedLabel} by {fmt(Math.abs(diff))}
        </span>
      </div>

      {displayRows.length === 0 ? (
        // Distinct from "0 hours": a section can carry a quote and a historical
        // Excel actual with no month-by-month ETC history behind it at all.
        <p className="text-xs text-sdc-muted">
          No month-by-month history for this section — its actual comes from the migrated Excel total, not from ETC tracking.
        </p>
      ) : (
        <div className="space-y-1">
          <div className="grid grid-cols-[5rem_1fr_4rem_4.5rem] gap-2 text-label font-semibold uppercase tracking-wide text-sdc-gray-400">
            <span>Month</span>
            <span />
            <span className="text-right">Hours</span>
            <span className="text-right">Running</span>
          </div>
          {displayRows.map((m) => (
            <div key={m.month} className="grid grid-cols-[5rem_1fr_4rem_4.5rem] items-center gap-2">
              <span className="font-mono text-note text-sdc-navy">{m.month}</span>
              <div className="h-2 w-full overflow-hidden rounded-full bg-white">
                <div className="h-full rounded-full" style={{ width: `${(m.worked / peak) * 100}%`, background: SERIES.actual }} />
              </div>
              <span className="text-right text-note font-semibold tabular-nums text-sdc-navy">{fmt(m.worked)}</span>
              {/* Running total turns red once it passes the plan — the month the
                  section went over, which is the whole point of the panel. */}
              <span
                className={`text-right text-note tabular-nums ${
                  row.planned > 0 && m.running > row.planned ? "font-semibold text-red-600" : "text-sdc-muted"
                }`}
              >
                {fmt(m.running)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
