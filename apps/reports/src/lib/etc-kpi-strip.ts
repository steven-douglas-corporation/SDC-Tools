// ── The Monthly ETC summary, as data (§37) ──────────────────────────────────
//
// Six separate KPI cards became ONE unified summary card (§37.1). This module exists
// rather than the JSX simply being rearranged, because consolidating six containers
// into one is precisely the change that quietly loses a KPI, points two blocks at the
// same drill-through, or drops a tone — and none of those show up as anything but
// "moved some divs" in a diff of a 400-line component.
//
// So the strip's CONTENT is a pure function of the figures it is handed, and
// EtcMonthKpiCards only renders what comes back. Every §37.13 criterion that is
// decidable — six blocks, each with its own value, status, tone and drill, nothing
// lost — is then a test in tests/etc-kpi-strip.test.ts rather than a claim.
//
// ── What this module is NOT allowed to do (§37.3) ───────────────────────────
//
// It computes no KPI. Every figure arrives already reconciled by reconcileEtcKpis
// (lib/etc-kpi-live.ts), which is the one place that decides whether a field's
// authority is the live cell store or the server snapshot. This file selects, labels
// and formats — nothing else. A formula here would be a second definition of a number
// the grid also shows, which is the exact failure §28 was written about.
//
// Dependency-free apart from types and the two formatters passed in, for the same
// reason lib/etc-kpi-live.ts is: a plain node:test file has to be able to reach it.

import type { EtcMonthKpis, GroupKpi } from "@/lib/etc-month-kpis";
import type { OffGridJob } from "@/lib/off-grid-hours";
import { varianceTooltip } from "@/lib/etc-kpi-live";

// Which drill-through a block opens. Lives here rather than in the component because
// the mapping from block to drill is one of the things §37.2 forbids collapsing, so it
// belongs with the tests that check it stays injective.
//
// "All" (the unscoped People Booked drill) retired with the block in §64 — every
// remaining drill scope narrows to one section group or one source, so nothing reads
// the punch rows unfiltered any more.
export type DrillScope = "Engineering" | "Shop" | "Unattributed" | "OffGrid" | "Parts";

export type KpiBlockId = "engineering" | "shop" | "parts" | "undefined" | "offGrid";

// "warn" is work to do rather than work done — deliberately not red, nothing is broken.
// "danger" is a figure about to be LOST (see the off-grid block).
export type KpiTone = "warn" | "danger";

// The second line of a block. Three treatments, because they mean three different
// things and painting one as another is how a card comes to say the opposite of the
// truth (see Unplanned's note below):
//
//   variance   ▲/▼ over-or-under against plan, green/red, or a grey "On plan"
//   unplanned  amber — nobody has planned this yet, which is neither good nor bad
//   text       a neutral factual note ("12 eng · 9 shop")
export type KpiStatusKind = "variance" | "unplanned" | "text";

// ── Flat on purpose ─────────────────────────────────────────────────────────
//
// Every field is a primitive so the component can spread a block straight into a
// React.memo'd MetricBlock and have the shallow comparison work. A nested `status`
// object would be a fresh identity on every render, so every block would re-render
// whenever any ONE figure moved — the §37.4/§37.11 requirement that only the affected
// block updates would be quietly false while looking implemented.
export type KpiBlock = {
  id: KpiBlockId;
  label: string;
  // Formatted for display, or "—" when the figure is genuinely unavailable rather than
  // zero (a month with no punch rows at all).
  value: string;
  // The full explanation, carried as the block's title attribute exactly as the six
  // separate cards carried it (§37.1: "any existing tooltip or explanation").
  hint: string | null;
  tone: KpiTone | null;
  // A short non-colour restatement of `tone`, for screen readers and as a visible
  // marker (§37.10: "do not communicate status through color alone"). null when the
  // block has no tone.
  toneLabel: string | null;
  drill: DrillScope | null;
  statusKind: KpiStatusKind;
  statusArrow: "▲" | "▼" | "";
  statusText: string;
  // +1 under plan, −1 over plan, 0 neutral. What colours the status line — kept
  // separate from the text so the component has no arithmetic and no sign convention
  // of its own to get backwards.
  statusSign: -1 | 0 | 1;
  statusTitle: string;
  // The headcount that used to live in its own "People booked" block (§64: retired,
  // its split surfaces here instead) — "24 engineers" / "21 shop". null for the three
  // blocks headcount does not apply to (Parts, Undefined hours, Hours off the grid),
  // and for Engineering/Shop on a month with no punch data at all.
  countLabel: string | null;
};

export type KpiFormatters = {
  hours: (n: number) => string;
  usd: (n: number) => string;
};

export type KpiStripInput = {
  // Already through reconcileEtcKpis — see the header note.
  kpis: EtcMonthKpis;
  // Time booked to something that isn't a job number.
  importIssues: { label: string; rows: number; hours: number }[];
  // Hours on jobs the grid isn't listing.
  offGridJobs: OffGridJob[];
};

// ── The two totals the strip and its drills must agree on ───────────────────
//
// Exported and used by both the block below and the drill panel that opens from it, so
// a card and its own detail cannot state two different numbers (§37.13 #6).

export function offGridTotalHours(jobs: OffGridJob[]): number {
  return jobs.reduce((s, j) => s + j.hours, 0);
}

export function undefinedHoursTotals(issues: { rows: number; hours: number }[]): {
  hours: number;
  entries: number;
} {
  return {
    hours: issues.reduce((s, i) => s + i.hours, 0),
    entries: issues.reduce((s, i) => s + i.rows, 0),
  };
}

// ── The status line ─────────────────────────────────────────────────────────

type Status = Pick<KpiBlock, "statusKind" | "statusArrow" | "statusText" | "statusSign" | "statusTitle">;

// The grid's Diff, in words. Positive = New ETC is under what's left (good), negative =
// over. Zero says "on plan" rather than "0", which reads as missing.
function variance(value: number, format: (n: number) => string, title: string): Status {
  const rounded = Math.round(value);
  if (rounded === 0) {
    return { statusKind: "variance", statusArrow: "", statusText: "On plan", statusSign: 0, statusTitle: title };
  }
  return {
    statusKind: "variance",
    statusArrow: rounded > 0 ? "▲" : "▼",
    // The UNROUNDED value is formatted, exactly as the old Variance component did — the
    // formatter is what rounds, and it rounds the same way everywhere in the app.
    statusText: `${format(Math.abs(value))} ${rounded > 0 ? "under" : "over"}`,
    statusSign: rounded > 0 ? 1 : -1,
    statusTitle: title,
  };
}

// A neutral fact, not a judgement — no arrow, no colour.
function note(text: string, title: string): Status {
  return { statusKind: "text", statusArrow: "", statusText: text, statusSign: 0, statusTitle: title };
}

// ── Engineering / Shop ──────────────────────────────────────────────────────
//
// While anything is still unplanned the block reports THAT rather than a variance. A
// blank New ETC counts as 0, so an untouched cell contributes its whole Hours Left —
// real, but calling it "under plan" would be a lie: nobody has planned it at all. As
// cells get filled in, the unplanned figure shrinks to zero and the block flips to the
// true over/under, which is the state it has to be right in at submission. Both numbers
// are always in the tooltip.
function groupStatus(g: GroupKpi, fmt: KpiFormatters): Status {
  const unplanned = g.diffUnplanned;
  if (Math.round(unplanned) === 0) {
    return variance(g.diff, fmt.hours, "Sum of (Hours Left − New ETC) over the cells a manager has confirmed");
  }
  const rest = Math.round(g.diff - unplanned);
  return {
    statusKind: "unplanned",
    statusArrow: "",
    statusText: `${fmt.hours(unplanned)} unplanned`,
    statusSign: 0,
    statusTitle:
      `${fmt.hours(unplanned)} hours sit in sections with no New ETC entered — counted in full because an empty cell plans nothing. ` +
      (rest === 0
        ? "Every cell that HAS been planned is exactly on plan."
        : `Separately, the cells already planned are ${fmt.hours(Math.abs(rest))} ${rest > 0 ? "under" : "over"}.`),
  };
}

// ── The strip ───────────────────────────────────────────────────────────────
//
// Order is the reading order (§37.10): the two hours groups (each now carrying its own
// headcount, §64), the money, then the two "missing from every figure here" blocks.
// Off-grid is last because it is the only conditional one.
//
// ── The headcount moved INTO Engineering/Shop, the standalone block did not (§64) ──
//
// "People booked" was its own block: 49 distinct people overall, with the eng/shop
// split (24 · 21) as its hint and second line. Retired by request; the split survives
// as each hours block's OWN `countLabel` — `g.people` was already computed on the
// identical scope as `g.worked` (same `month`, same `jobIds`, same section→group map;
// see getEtcMonthKpis) so this is not a new figure, only a new place to read one that
// already existed. The one number this loses is the distinct-overall total (49) —
// engineering.people + shop.people can exceed it (someone who booked both groups) or
// fall short of it (someone whose sections are in neither group) — which is exactly
// why it was never engineering.people + shop.people to begin with, and why there is no
// replacement for it now that neither hours block is the right home for a figure that
// belongs to both.
export function buildKpiBlocks(input: KpiStripInput, fmt: KpiFormatters): KpiBlock[] {
  const { kpis, importIssues, offGridJobs } = input;
  const undef = undefinedHoursTotals(importIssues);
  const offGridTotal = offGridTotalHours(offGridJobs);

  const group = (
    id: "engineering" | "shop",
    label: string,
    g: GroupKpi,
    drill: DrillScope,
    // The compact ON-ROW label ("24 engineers", "21 shop") and the fuller tooltip
    // phrasing, so the short form fits between the status and the figure while the
    // hint can afford to spell out "shop people" without the row's space limit.
    rowLabel: string,
    hintLabel: string,
  ): KpiBlock => ({
    id,
    label,
    value: fmt.hours(g.worked),
    hint: kpis.hasPunchData ? `${hintLabel} booked time` : null,
    tone: null,
    toneLabel: null,
    // No punch rows means there is nothing behind the figure to show, which is why the
    // link and the count are both absent rather than the panel — or the row — opening
    // on nothing.
    drill: kpis.hasPunchData ? drill : null,
    countLabel: kpis.hasPunchData ? rowLabel : null,
    ...groupStatus(g, fmt),
  });

  const blocks: KpiBlock[] = [
    group(
      "engineering",
      "Engineering hours",
      kpis.engineering,
      "Engineering",
      `${kpis.engineering.people} ${kpis.engineering.people === 1 ? "engineer" : "engineers"}`,
      `${kpis.engineering.people} ${kpis.engineering.people === 1 ? "engineer" : "engineers"}`,
    ),
    group(
      "shop",
      "Shop hours",
      kpis.shop,
      "Shop",
      `${kpis.shop.people} shop`,
      `${kpis.shop.people} shop ${kpis.shop.people === 1 ? "person" : "people"}`,
    ),
    {
      id: "parts",
      label: "Parts spent",
      value: fmt.usd(kpis.parts.spent),
      hint: null,
      tone: null,
      toneLabel: null,
      drill: "Parts",
      countLabel: null,
      ...variance(
        kpis.parts.diff,
        fmt.usd,
        // The subtraction in this sentence produces the number beside it, exactly —
        // see varianceTooltip. Quoting the group totals instead is what made the old
        // version stop adding up (§28.15).
        varianceTooltip({
          leftLabel: "Money Left",
          plannedLeft: kpis.parts.plannedMoneyLeft,
          plannedNewEtc: kpis.parts.plannedNewEtc,
          groupLeft: kpis.parts.moneyLeft,
          groupNewEtc: kpis.parts.newEtc,
          format: fmt.usd,
        }),
      ),
    },
    // Hours booked to something that isn't a job number. Part of the summary, not just
    // the banner above the grid, because this is the one figure here that is MISSING
    // from every other figure — it belongs beside the totals it is absent from.
    // Shown even at zero: "0 undefined hours" is a daily reassurance that the import is
    // clean, where an absent block says nothing either way.
    {
      id: "undefined",
      // "Data Quality — Undefined Hours" everywhere this feature is named (by request,
      // 2026-08-20) — the card, the panel it opens, and nowhere else under a different
      // name, since that was the actual complaint: the same underlying figure used to
      // also surface as "Hours booked to a non-job" on the Dashboard's Data Quality tab.
      label: "Data Quality — Undefined Hours",
      value: fmt.hours(undef.hours),
      hint:
        undef.hours > 0
          ? `${undef.entries} ${undef.entries === 1 ? "entry" : "entries"} · ${importIssues
              .map((i) => i.label)
              .join(", ")} — not counted in any figure here`
          : "Every punch this month has a valid job number",
      tone: undef.hours > 0 ? "warn" : null,
      toneLabel: undef.hours > 0 ? "Needs attention" : null,
      drill: undef.hours > 0 ? "Unattributed" : null,
      countLabel: null,
      ...note(
        undef.hours > 0 ? `${undef.entries} ${undef.entries === 1 ? "entry" : "entries"}` : "None outstanding",
        undef.hours > 0
          ? `${importIssues.map((i) => i.label).join(", ")} — these punches reach no figure on this page`
          : "Every punch this month has a valid job number",
      ),
    },
  ];

  // The mirror image of the block before it: those hours have no job, these have a job
  // the grid has stopped showing — and both are missing from every other figure here.
  //
  // Red rather than amber: undefined-hours sit there until someone fixes Paylocity, but
  // these rows are DELETED by the next Refresh Data or Submit ETC, so the window to act
  // closes. Hidden at zero, unlike Undefined hours, because a permanent "0 off-grid"
  // block would just be dead space on the normal month.
  if (offGridJobs.length > 0) {
    const jobWord = offGridJobs.length === 1 ? "job" : "jobs";
    blocks.push({
      id: "offGrid",
      label: "Hours off the grid",
      value: fmt.hours(offGridTotal),
      hint: `${offGridJobs.length} ${jobWord} not listed below — ${offGridJobs
        .slice(0, 2)
        .map((j) => j.jobId)
        .join(", ")}${offGridJobs.length > 2 ? `, +${offGridJobs.length - 2} more` : ""} — missing from every figure here`,
      tone: "danger",
      toneLabel: "Action needed",
      drill: "OffGrid",
      countLabel: null,
      ...note(
        `${offGridJobs.length} ${jobWord} not listed`,
        "These hours reach no total in the grid below, and the rows are deleted by the next Refresh Data or Submit ETC",
      ),
    });
  }

  return blocks;
}

// ── Which block is fetching, and which one failed (§37.9) ───────────────────
//
// Three fetch lanes serve six blocks: the punch detail behind Engineering / Shop /
// People, the parts detail behind Parts spent, and the hours export behind Undefined
// hours. Off-grid has no lane at all — its rows arrive with the page.
//
// The rule §37.9 asks for is that a slow or failed KPI must not affect the other five,
// and it is decidable, so it lives here rather than as a chain of ternaries in the JSX:
// a block reports a state only when ITS OWN drill is the open one. Nothing is fetched
// for a closed drill, so at most one block is ever non-idle and the other five keep
// showing their confirmed values.
export type KpiLane = {
  // A request is in flight for this lane.
  loading: boolean;
  // The last attempt failed, and nothing has replaced it yet.
  error: string | null;
  // Data is already cached, so a `loading` flag belongs to a background refresh rather
  // than to an empty panel — the block keeps its confirmed value and says nothing
  // (§37.9: "keep confirmed values visible during a background update").
  loaded: boolean;
};

export type KpiLanes = {
  punches: KpiLane;
  parts: KpiLane;
  undefinedHours: KpiLane;
};

export type KpiDetailState = "idle" | "loading" | "error";

// Which lane a drill scope reads from. Engineering, Shop and People share the punch
// detail — one request, narrowed client-side — which is why they share a lane.
export function kpiLaneFor(drill: DrillScope): keyof KpiLanes | null {
  if (drill === "Parts") return "parts";
  if (drill === "Unattributed") return "undefinedHours";
  if (drill === "OffGrid") return null;
  return "punches";
}

export function kpiDetailState(
  blockDrill: DrillScope | null,
  openDrill: DrillScope | null,
  lanes: KpiLanes,
): KpiDetailState {
  if (blockDrill == null || openDrill !== blockDrill) return "idle";
  const lane = kpiLaneFor(blockDrill);
  if (lane == null) return "idle";
  const state = lanes[lane];
  if (state.error) return "error";
  return state.loading && !state.loaded ? "loading" : "idle";
}

// ── Layout (§37.8, revised §41.13) ──────────────────────────────────────────
//
// Stacked when narrow, two up, three up, then ONE row with however many blocks there
// are. The count VARIES — off-grid only appears when something is off the grid — so a
// hardcoded grid-cols-6 would wrap the seventh block onto a line of its own and
// hardcoding 7 would leave a gap on every normal month. The column count follows the
// block count through a CSS variable instead, so both cases fill the row.
//
// ── Why these are CONTAINER queries, not breakpoints (§41.13) ───────────────
//
// The previous version reached one row at Tailwind's `xl`, which is a 1280px VIEWPORT.
// This card is not the viewport: it sits inside the page container, inset by a sidebar
// that is ~220px expanded. So a 1440px laptop gives the card ~1180px — under 1280 — and
// the card fell back to three columns and two rows on exactly the "normal desktop"
// §41.13 is about. The breakpoint was measuring the wrong box.
//
// `@container` on the section (see EtcMonthKpiCards) makes these respond to the CARD's
// own width, which is the width that actually decides whether six values fit. That also
// makes it correct for free: collapsing the sidebar widens the card and it re-lays out,
// and browser zoom changes effective width so 80%-200% is handled by the same rule
// rather than by a separate set of breakpoints.
//
// ── auto-fit, not breakpoints, and not a column count ───────────────────────
//
// `repeat(auto-fit, minmax(175px, 1fr))` fits as many blocks per row as the card can
// hold at a readable width and wraps the rest. That replaces both the breakpoint ladder
// and the `--kpi-cols` variable, and it is not a simplification for its own sake — a
// fixed threshold cannot be correct when the BLOCK COUNT VARIES. "One row from 1100px"
// is right for six blocks (183px each) and wrong for seven (157px each, which clips);
// a container query cannot read the block count in its condition, so any single
// threshold is wrong for one of the two cases. A per-block minimum is right for both.
//
// 175px is measured, not chosen. Forcing the real card to N-across and checking every
// text node for overflow: at 180px nothing clips; at 154px "24 eng · 21 shop" and
// "5 jobs not listed" both do. 175px sits just under the proven-clean width, and `1fr`
// lets each block grow past it so a row is always exactly filled and every block in it
// is the same width (§41.13).
//
// It is also self-correcting for the things §41.26 asks about: collapsing the sidebar
// widens the card and it re-lays out, and browser zoom changes the effective width, so
// 80%-200% is handled by the same rule instead of a second set of breakpoints.
//
// gap-px is what draws the dividers: the blocks are opaque and the container behind
// them is the divider colour, so the 1px gaps ARE the section boundaries (§37.7 —
// one outer border, no nested card borders). It also survives wrapping, which a
// per-block border cannot: a left border on every block leaves a stray line at the
// start of each wrapped row.
// ── One block per ROW, not a parallel strip (2026-08-05, by request) ────────
//
// This was `repeat(auto-fit, minmax(175px, 1fr))` — six blocks side by side, wrapping
// by container width. That layout had a real cost the stacked one does not: at six
// across on a 1280px screen each block got ~169px, which is why the value and its
// status had to be put on separate lines, why the label needed `truncate`, and why
// three reserved min-heights exist to stop the card resizing as figures change.
//
// A row per metric gives the label its natural width and puts the label, the status,
// the figure and the Detail link on one line, right-aligned and aligned WITH EACH OTHER
// down the card — which is the thing a parallel strip cannot do: six values in six
// columns never line up, so they cannot be compared by eye.
//
// gap-px still draws the dividers, for the same reason as before: the rows are opaque
// and this container's background shows through the 1px gaps, so there is one outer
// border and no nested ones (§37.7). It survives a row being added or removed, which a
// per-row border does not (the last row would carry a stray line).
export const KPI_GRID_CLASS = "grid grid-cols-1 gap-px";
