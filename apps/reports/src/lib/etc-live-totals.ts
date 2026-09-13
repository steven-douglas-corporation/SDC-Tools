"use client";

import { useSyncExternalStore } from "react";
import { partsNewEtc } from "@/lib/left-to-invoice";
// The rollup rule, shared with the server render so the block cannot paint one
// figure on load and a different one on the first keystroke (§51).
import { rollupNewEtc, type NewEtcRollup, type NewEtcRollupCell } from "@/lib/etc";

// Live per-job ETC totals, published by the cells that own the numbers and read
// by everything downstream of them.
//
// ── The bug this exists for (2026-08-03) ────────────────────────────────────
// Every derived figure on the Monthly ETC page — the row's TOTAL (NEW ETC)
// block, the sticky grand-total row, Total ETC $, % Total, Standard Fees, Total
// Standard Fees — is summed on the SERVER from stored EtcEntry values. The
// section cells themselves recompute Hours Left / New ETC / Diff client-side as
// you type (EtcSectionCells), so a manager watched each cell update correctly
// while every total that summed those cells sat frozen at what the page loaded
// with, until a save round-trip.
//
// That is one root cause, not four: everything downstream reads a per-job
// (engineering, shop, parts) triple. So the triple is what goes live here, and
// the row totals, the footer and the Standard Sheet all read it.
//
// It matters most on this page rather than Projects: this is the grid Submit ETC
// freezes. A total that disagrees with the cells above it is exactly the number
// nobody should be signing off.
//
// ── Why a module-scope store ────────────────────────────────────────────────
// Same reasoning as etc-dirty-tracker.ts, which this is modelled on: the
// publishers are ~800 independent cell components and the subscribers are a
// handful of totals components with no ancestor in common short of the page.
// Threading this through context would re-render the entire grid on every
// keystroke — which is the cost the server-rendered cells were chosen to avoid.
//
// ── The one rule that makes this safe ───────────────────────────────────────
// Publishers send values they computed with the SAME functions the server uses
// (calcHoursLeft / suggestNewEtc / newEtcDiff in lib/etc.ts). This module only
// ADDS. It must never contain a formula of its own, or the live total and the
// figure Submit persists could drift — worse than a stale total.

export type LiveCell = {
  jobId: number;
  // Which of the two rollup blocks this section feeds.
  billingGroup: "Engineering" | "Shop";
  // Which COLUMN this cell sits in. The <tfoot> carries a grand total per section
  // as well as per billing group, and the per-section one is the total directly
  // beneath the cell a manager is typing in — the most-watched figure on the page
  // (see readEtcLiveSectionTotals).
  sectionCode: string;
  prior: number;
  worked: number;
  hoursLeft: number;
  // The New ETC that would be written right now: the manager's value if typed,
  // else the suggestion.
  effective: number;
  diff: number;
  // Has anyone actually planned this cell? A blank New ETC now counts as 0, so an
  // untouched cell contributes its whole Hours Left to `diff` — true, but not a
  // variance. The KPI strip splits the two so it never calls unplanned work
  // "under plan".
  decided: boolean;
};

// ── The two operands that actually produce `diff` (§28, 2026-08-04) ─────────
//
// `diff` is summed PER CELL, and a cell nobody has decided contributes exactly 0
// (newEtcDiff) — while its Hours Left and its effective New ETC still land in
// `hoursLeft` and `newEtc` above. So the group's `hoursLeft − newEtc` is NOT the
// group's `diff`, and a tooltip that says "Hours Left (X) − New ETC (Y)" prints a
// subtraction that does not produce the number beside it. Reported on the Parts card:
//
//     Money Left ($2,996,607) − New ETC ($4,038,388)   shown: $1,085,685 under
//
// These two are the same sums restricted to the cells that DO contribute — decided,
// and clamped the same way the per-cell formula clamps. By construction:
//
//     plannedHoursLeft − plannedNewEtc === diff
//
// term for term. (In floating point the two sums are rounded independently on the way
// out, so the subtraction can land an epsilon off — 0.7 − 0.4 is 0.29999999999999993.
// The guarantee is therefore "foots at the precision it is displayed at", which for a
// strip showing whole dollars and whole hours is comfortably met.)
//
// so the tooltip can quote figures that foot. Kept as sums rather than derived later
// because the clamp and the decided-test are per cell and cannot be reconstructed
// from any group total — which is the whole reason the old sentence was wrong.
type GroupTotals = {
  prior: number;
  worked: number;
  hoursLeft: number;
  newEtc: number;
  diff: number;
  diffUnplanned: number;
  plannedHoursLeft: number;
  plannedNewEtc: number;
  // ── The TOTAL (NEW ETC) block's own figures (§51) ─────────────────────────
  //
  // ADDED beside the sums above rather than replacing them, and that is the whole
  // scoping decision: §51 applies to the ENG/SHOP rollup block and to nothing else,
  // so the KPI cards keep reading `newEtc` / `diff` / `plannedNewEtc` exactly as they
  // did. Only the block reads this, and only this goes blank.
  //
  // `newEtc` and `diff` here are null until every section in the group that needs an
  // answer has one — see rollupNewEtc in lib/etc.ts, which is the SAME function the
  // server render calls, so the first paint and the first keystroke agree.
  rollup: NewEtcRollup;
};

export type JobTotals = {
  engineering: GroupTotals;
  shop: GroupTotals;
  // Parts Cost is dollars, not hours, and has one cell per job rather than one
  // per section — so it is published separately and carries no group.
  // `decided` rides along so the row's own Diff cell can be repainted correctly: an
  // undecided Parts Cost cell prints "—", not $0, and the repaint has to know which.
  parts: { prior: number; spent: number; left: number; newEtc: number; diff: number; decided: boolean } | null;
};

// Keyed by STRING, not entry id: a section a job was never quoted for has no
// EtcEntry yet but is still an editable cell (see EtcSectionCells), and it needs
// a stable key before the row it will create exists. Real cells use the entry id;
// not-yet-created ones use `<jobId>:<section>`.
const cells = new Map<string, LiveCell>();
const parts = new Map<number, NonNullable<JobTotals["parts"]>>(); // jobId -> parts cell
const listeners = new Set<() => void>();

// Bumped on every change; the snapshot below is keyed on it so
// useSyncExternalStore can tell "same data" from "recomputed".
let version = 0;

// ── Notifications are coalesced to one per frame (§38.4, measured 2026-08-04) ─
//
// This used to notify synchronously inside every publish, and that single line was the
// worst performance defect in the app.
//
// Every New ETC cell publishes itself on mount. On July's grid that is ~880 publishes
// inside one commit, and each one notified every listener immediately. One of those
// listeners is EtcLiveTotals' painter, which is not React: it walks the grid's rollup
// cells, READS their text and WRITES new text and classes. So ~880 synchronous
// DOM-read-then-write passes over ~150 cells, each forcing a style recalculation, plus
// ~880 re-render notifications to the KPI strip and the Standard Fees columns whose
// subtree is the whole grid.
//
// Measured on the production build, July 2026, before this change:
//
//   /etc     first paint 60ms, then ONE long task of 4,347ms (total blocking ~4.5s)
//   /quoted  1,194 inputs — almost exactly the same DOM — worst long task 159ms
//
// The page painted in 60ms and then ignored every click for four and a half seconds.
// That is the whole of the reported "the app freezes / my first click does nothing":
// not the cell count (Projects has as many inputs and is 27× cheaper), but the fact
// that mounting N cells cost N full repaints.
//
// The version counter still bumps SYNCHRONOUSLY — a reader between a publish and the
// notification must see the new figures, so `snapshot()` cannot be allowed to serve a
// stale cache. Only the notification waits, which is legal for useSyncExternalStore
// (React re-reads the snapshot when it renders, so nothing can tear) and is the right
// moment for a paint anyway: one per frame, aligned with the browser's own.
let notifyScheduled = false;

// requestAnimationFrame in a browser; a microtask under node, where the tests run and
// where there are no frames. Both coalesce a burst into one notification.
const scheduleNotify: (fn: () => void) => void =
  typeof requestAnimationFrame === "function"
    ? (fn) => {
        requestAnimationFrame(fn);
      }
    : (fn) => {
        queueMicrotask(fn);
      };

function emit() {
  version += 1;
  if (notifyScheduled) return;
  notifyScheduled = true;
  scheduleNotify(() => {
    notifyScheduled = false;
    // Copied before iterating: a listener may unsubscribe (a cell unmounting during a
    // month switch) while the set is being walked.
    for (const l of [...listeners]) l();
  });
}

// Notify now rather than next frame. For tests and for anything that must observe the
// coalesced notification without waiting on a frame — not needed by the app itself.
export function flushEtcLiveTotals(): void {
  if (!notifyScheduled) return;
  notifyScheduled = false;
  for (const l of [...listeners]) l();
}

export function publishEtcCell(cellKey: string, cell: LiveCell): void {
  const prev = cells.get(cellKey);
  if (
    prev &&
    prev.jobId === cell.jobId &&
    prev.billingGroup === cell.billingGroup &&
    prev.sectionCode === cell.sectionCode &&
    prev.prior === cell.prior &&
    prev.worked === cell.worked &&
    prev.hoursLeft === cell.hoursLeft &&
    prev.effective === cell.effective &&
    prev.diff === cell.diff &&
    prev.decided === cell.decided
  ) {
    return; // no-op republish (a re-render with the same value) must not notify
  }
  cells.set(cellKey, cell);
  emit();
}

export function forgetEtcCell(cellKey: string): void {
  if (cells.delete(cellKey)) emit();
}

export function publishPartsCell(jobId: number, cell: NonNullable<JobTotals["parts"]>): void {
  const prev = parts.get(jobId);
  // `decided` is compared too — it changes the row's Diff between "—" and a figure, so a
  // republish that only flips it must still notify.
  if (
    prev &&
    prev.prior === cell.prior &&
    prev.spent === cell.spent &&
    prev.left === cell.left &&
    prev.newEtc === cell.newEtc &&
    prev.diff === cell.diff &&
    prev.decided === cell.decided
  ) {
    return;
  }
  parts.set(jobId, cell);
  emit();
}

export function forgetPartsCell(jobId: number): void {
  if (parts.delete(jobId)) emit();
}

const EMPTY_GROUP = (): GroupTotals => ({
  prior: 0, worked: 0, hoursLeft: 0, newEtc: 0, diff: 0, diffUnplanned: 0, plannedHoursLeft: 0, plannedNewEtc: 0,
  // Overwritten at the end of computeTotals; this is the empty-group answer.
  rollup: { complete: true, hoursLeft: 0, newEtc: 0, diff: 0 },
});

// Recomputed from scratch on demand rather than maintained incrementally: the
// grid is at most ~800 cells, summing them is microseconds, and an incremental
// accumulator is how a rounding error or a missed unmount becomes a total that
// slowly stops matching its column.
function computeTotals(): Map<number, JobTotals> {
  const byJob = new Map<number, JobTotals>();
  // The block's cells, collected per job+group so the rollup can be computed by the
  // SHARED function rather than re-derived here. Kept out of JobTotals: it is working
  // state, and putting it on the exported type would invite a consumer to sum it.
  const rollupCells = new Map<string, NewEtcRollupCell[]>();
  const ensure = (jobId: number) => {
    let t = byJob.get(jobId);
    if (!t) byJob.set(jobId, (t = { engineering: EMPTY_GROUP(), shop: EMPTY_GROUP(), parts: null }));
    return t;
  };
  for (const c of cells.values()) {
    const t = ensure(c.jobId);
    const g = c.billingGroup === "Engineering" ? t.engineering : t.shop;
    const key = `${c.jobId}|${c.billingGroup}`;
    let list = rollupCells.get(key);
    if (!list) rollupCells.set(key, (list = []));
    // `decided` is the cell's own live answer to "is this box filled in" — the same
    // flag it already publishes for `diff`, so the block and the Diff column can never
    // disagree about whether a cell has been answered.
    list.push({ decided: c.decided, hoursLeft: c.hoursLeft, newEtc: c.effective });
    g.prior += c.prior;
    g.worked += c.worked;
    g.hoursLeft += c.hoursLeft;
    g.newEtc += c.effective;
    // Summed PER CELL, matching the server: the suggestion clamps at zero per
    // cell, and that clamp cannot be reproduced from the group's sums.
    g.diff += c.diff;
    if (!c.decided) g.diffUnplanned += c.diff;
    // The two operands that produce `diff`, restricted to the cells that produce it.
    // An undecided cell contributes 0 to diff (newEtcDiff), so it must contribute 0 to
    // BOTH of these or the identity breaks. The clamp mirrors the per-cell formula.
    if (c.decided) {
      g.plannedHoursLeft += c.hoursLeft;
      g.plannedNewEtc += Math.max(c.effective, 0);
    }
  }
  for (const [jobId, p] of parts) ensure(jobId).parts = p;
  // The rollup, from the one shared function (§51). A job whose group published no
  // cells at all keeps EMPTY_GROUP's rollup, which is `complete` over zero cells —
  // correct: there is nothing outstanding, and 0 − 0 is 0.
  for (const [jobId, t] of byJob) {
    t.engineering.rollup = rollupNewEtc(rollupCells.get(`${jobId}|Engineering`) ?? []);
    t.shop.rollup = rollupNewEtc(rollupCells.get(`${jobId}|Shop`) ?? []);
  }
  return byJob;
}

let cachedVersion = -1;
let cached: Map<number, JobTotals> = new Map();

function snapshot(): Map<number, JobTotals> {
  if (cachedVersion !== version) {
    cached = computeTotals();
    cachedVersion = version;
  }
  return cached;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// The server snapshot is what renders on the way in and after any save, so it is
// also the correct value before a single cell has mounted and published.
const SERVER_SNAPSHOT: Map<number, JobTotals> = new Map();

export function useEtcLiveTotals(): Map<number, JobTotals> {
  return useSyncExternalStore(subscribe, snapshot, () => SERVER_SNAPSHOT);
}

// Non-hook read, for imperative repainting (see EtcLiveTotals.tsx).
export function readEtcLiveTotals(): Map<number, JobTotals> {
  return snapshot();
}

// ── The <tfoot> grand totals ────────────────────────────────────────────────
//
// The footer holds THREE families of total, and until 2026-08-03 only one of them
// was wired up:
//
//   • per billing group (Engineering / Shop)  — was live
//   • per SECTION column (ME Gen, Robot, …)   — was NOT, and it is the total
//     sitting directly under the cell being typed in
//   • Parts Cost                              — was NOT, though its New ETC
//     column is manager-editable like any other
//
// So a manager typed a New ETC, watched the cell update, and watched the total
// immediately below it sit still. Reasonably, they read that as the edit not
// having registered at all — and then as Save being broken, since Save (which
// deliberately skips revalidatePath for speed) doesn't repaint anything either.
// The values were being saved correctly the whole time; nothing said so.
//
// Same two-cells-only rule as the per-job blocks: Prior ETC and Hours Worked
// aren't editable and Hours Left derives from them, so only New ETC and Diff can
// move. Still pure summation — no formula of its own (see the header note).
export type SectionTotals = { newEtc: number; diff: number };

function computeSectionTotals(): Map<string, SectionTotals> {
  const bySection = new Map<string, SectionTotals>();
  for (const c of cells.values()) {
    let t = bySection.get(c.sectionCode);
    if (!t) bySection.set(c.sectionCode, (t = { newEtc: 0, diff: 0 }));
    t.newEtc += c.effective;
    // Per cell, matching the server — the suggestion clamps at zero per cell and
    // that clamp can't be reproduced from a column's sums.
    t.diff += c.diff;
  }
  return bySection;
}

// Parts Cost is dollars and has one cell per job, so its grand total is summed
// from the parts cells rather than the section cells.
function computePartsGrandTotal(): SectionTotals {
  const total = { newEtc: 0, diff: 0 };
  for (const p of parts.values()) {
    total.newEtc += p.newEtc;
    total.diff += p.diff;
  }
  return total;
}

let cachedFooterVersion = -1;
let cachedSections: Map<string, SectionTotals> = new Map();
let cachedParts: SectionTotals = { newEtc: 0, diff: 0 };

function footerSnapshot(): { sections: Map<string, SectionTotals>; parts: SectionTotals } {
  if (cachedFooterVersion !== version) {
    cachedSections = computeSectionTotals();
    cachedParts = computePartsGrandTotal();
    cachedFooterVersion = version;
  }
  return { sections: cachedSections, parts: cachedParts };
}

export function readEtcLiveFooterTotals(): { sections: Map<string, SectionTotals>; parts: SectionTotals } {
  return footerSnapshot();
}

export function subscribeEtcLiveTotals(cb: () => void): () => void {
  return subscribe(cb);
}

// ── The New ETC breakout, live (2026-09-03) ──────────────────────────────────
//
// Parts Cost New ETC is now the SUM of two manager-entered cells, Left to Invoice and
// Left to Purchase. Those are client components; the New ETC cell that shows their
// total is rendered by the page, so it cannot see their state.
//
// Same shape, and for the same reason, as `publishPartsCell` above: the two inputs
// publish here, EtcLiveTotals patches the New ETC cell and the Parts Cost footer from
// it. Without this the sum would only be right after a reload.
export type PartsBreakoutHalf = "invoice" | "purchase";

const breakout = new Map<number, { invoice: number | null; purchase: number | null }>();

export function publishPartsBreakout(jobId: number, which: PartsBreakoutHalf, value: number | null): void {
  const prev = breakout.get(jobId) ?? { invoice: null, purchase: null };
  if (prev[which] === value) return; // no-op republish, e.g. a re-render with the same text
  breakout.set(jobId, { ...prev, [which]: value });
  emit();
}

export function forgetPartsBreakout(jobId: number, which: PartsBreakoutHalf): void {
  const prev = breakout.get(jobId);
  if (!prev) return;
  const next = { ...prev, [which]: null };
  if (next.invoice === null && next.purchase === null) breakout.delete(jobId);
  else breakout.set(jobId, next);
  emit();
}

/**
 * The live New ETC for a job: the two halves added.
 *
 * Null when NEITHER has been entered — that is a cell nobody has answered, and it must
 * render blank rather than $0. When only one is entered the other counts as 0, because
 * a manager who filled one half and left the other empty has said something about the
 * total; treating that as "unknown" would blank a figure they can see the inputs for.
 */
export function readPartsBreakoutSum(jobId: number): number | null {
  const b = breakout.get(jobId);
  if (!b) return null;
  // BOTH halves, or blank. The same rule the server renders by and the save writes by
  // (lib/left-to-invoice.ts's partsNewEtc). This used to treat a blank half as 0, which
  // showed a New ETC nobody had forecast the moment one of the two cells was filled in.
  return partsNewEtc(b.invoice, b.purchase);
}

/** Every job with at least one half entered, for the footer total. */
export function readPartsBreakoutTotals(): { invoice: number; purchase: number } {
  let invoice = 0;
  let purchase = 0;
  for (const b of breakout.values()) {
    invoice += b.invoice ?? 0;
    purchase += b.purchase ?? 0;
  }
  return { invoice, purchase };
}
