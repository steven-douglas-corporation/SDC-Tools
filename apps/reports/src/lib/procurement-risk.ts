// Procurement risk cards — Delivery Slip · No Purchase Order · Upcoming
// Deliveries.
//
// ── Why this module exists (2026-08-26) ─────────────────────────────────────
// These three rules used to live inside JobProcurement.tsx's own `risk`
// useMemo, which made this app's Job Hours Details page the only place they
// existed. The Build Readiness app (apps/build-readiness) shipped its OWN
// three cards with the same three titles and DIFFERENT arithmetic, computed
// client-side off its PO action list:
//
//   • Delivery Slip     — window [today-7d, today+1d) instead of
//                         "everything not received that is due on or before
//                         today+7d". A 3-week-overdue PO simply vanished from
//                         the card whose whole job is surfacing late work.
//   • No Purchase Order — `POQty === 0 && ReceivedQty < ItemQty`, which counts
//                         inventory pulls and in-house process schedules as
//                         procurement gaps and ignores BOM release status
//                         entirely (see job-bom-rules.ts's header for why both
//                         are wrong).
//   • Upcoming          — PO lines only, so an uncovered part with a required
//                         date next week never appeared; and the week picker
//                         was CUMULATIVE (1W = weeks 1..1, 4W = weeks 1..4)
//                         against this app's per-week buckets.
//
// So the rules are extracted here, JobProcurement.tsx calls
// `computeRiskCards` (its behaviour is unchanged — this was a pure move), and
// /api/integration/jobs/[jobId]/procurement serves the result to Build
// Readiness. There is now exactly one implementation of each rule, on this
// side of the wire, and Build Readiness renders what it is given rather than
// re-deriving anything.
//
// Pure and SSR-safe: `now` is always a caller-supplied timestamp, never
// `Date.now()` read at module scope.

import { isUncoveredPart } from "./job-bom-rules";
import { DAY, NO_PO_KEY, makePoGroup, type FlatPart, type PoGroup } from "./po-detail";

export function startOfTodayMs(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// A part's due date: the PO line's Expected date when there is one, otherwise
// the BOM's own Required date. The fallback is what lets an uncovered part
// (no PO, so no Expected date at all) still carry a position on the calendar.
export function dueMs(p: FlatPart): number {
  const d = p.expectedDate || p.requiredDate;
  if (!d) return NaN;
  return new Date(d).getTime();
}

export function reqMs(p: FlatPart): number {
  return p.requiredDate ? new Date(p.requiredDate).getTime() : NaN;
}

// Earliest required date among a group of parts — the No Purchase Order
// card's own primary date (there's no PO to hang an Expected date off), and
// the Required half of the other two cards' PO rows. Not part of PoGroup /
// makePoGroup: those are shared with the Card view and PoPanel, neither of
// which needs a required-date rollup, so this stays local to the risk cards.
export function earliestRequired(poParts: FlatPart[]): string | null {
  let acc: string | null = null;
  for (const p of poParts) {
    if (p.requiredDate && (!acc || p.requiredDate < acc)) acc = p.requiredDate;
  }
  return acc;
}

// Groups a FlatPart[] list into one row per (supplier, PO) pair — the same
// Map<supplier, Map<poKey, parts[]>> → makePoGroup pattern PartsCardView's own
// vendor grouping already uses (see its `vendorGroups` useMemo), just
// flattened: the risk cards (2026-08-14, by request — "group by PO instead
// of individual parts") want one flat list of PO rows, not a vendor-then-PO
// tree. A part with no PO number groups under NO_PO_KEY per supplier, same
// as everywhere else — there's no real PO to split those out by, so every
// no-PO part for one supplier lands in ONE row (which is exactly the "No PO /
// Unassigned" grouping asked for; the No Purchase Order card's own
// eligibility already guarantees `poNumber` is null for every part it passes
// in here).
//
// Preserves the INPUT array's own order within each group's first
// appearance (a `Map` iterates in insertion order) — a caller that passes an
// already date-sorted list (the risk cards' delivery/upcoming arrays, both
// sorted by due date ascending before reaching here) gets PO rows that come
// out sorted by their own earliest due date too, for free: the first part
// belonging to a given PO, in an already-sorted array, can only be the
// earliest one for that PO, since any earlier-due part sharing the same PO
// would already have appeared (and created the group) before it.
export function groupPartsByPo(parts: FlatPart[]): { supplier: string; po: PoGroup }[] {
  const byKey = new Map<string, { supplier: string; poKey: string; parts: FlatPart[] }>();
  for (const p of parts) {
    const supplier = p.supplier ?? "Unknown supplier";
    const poKey = p.poNumber ?? NO_PO_KEY;
    const key = `${supplier} ${poKey}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.parts.push(p);
    else byKey.set(key, { supplier, poKey, parts: [p] });
  }
  return [...byKey.values()].map((b) => ({ supplier: b.supplier, po: makePoGroup(b.poKey, b.parts) }));
}

export type RiskWeek = { week: number; parts: FlatPart[]; count: number };

export type RiskCards = {
  delivery: FlatPart[];
  deliveryAvgLate: number;
  deliveryOldest: string | null;
  deliveryPos: { supplier: string; po: PoGroup }[];
  noPo: FlatPart[];
  noPoThisWeek: number;
  noPoOldest: string | null;
  noPoPos: { supplier: string; po: PoGroup }[];
  noPoSorted: FlatPart[];
  upcoming: FlatPart[];
  upcomingAllPos: { supplier: string; po: PoGroup }[];
  weekData: RiskWeek[];
};

// How many weekly buckets Upcoming Deliveries offers. The `upEnd` bound below
// is derived from it so the two can never disagree.
export const UPCOMING_WEEKS = 8;

export function computeRiskCards(parts: FlatPart[], now: number): RiskCards {
  const today = startOfTodayMs(now);

  // Delivery Slip — upcoming/overdue deliveries: has a PO, not received, due
  // date <= today + 7 days (by request). No lower bound — an item due a
  // month ago hasn't stopped needing attention just because it aged out of
  // a 7-day-late window; it used to (a `today - 7*DAY` floor dropped
  // anything overdue by more than a week), which is exactly backwards for a
  // card whose whole point is surfacing what's late. Sorted ascending by
  // due date (unchanged), so the oldest overdue item leads.
  const slipEnd = today + 8 * DAY; // exclusive: "+7 days" is the last included calendar day
  const delivery = parts
    .filter((p) => {
      if (!p.poNumber || p.st.key === "received") return false;
      const t = dueMs(p);
      return Number.isFinite(t) && t < slipEnd;
    })
    .sort((a, b) => dueMs(a) - dueMs(b));
  const lateParts = delivery.filter((p) => Number.isFinite(dueMs(p)) && dueMs(p) < today);
  const deliveryAvgLate = lateParts.length
    ? Math.round(lateParts.reduce((s, p) => s + Math.ceil((today - dueMs(p)) / DAY), 0) / lateParts.length)
    : 0;
  const deliveryOldest = delivery.reduce<string | null>((acc, p) => {
    if (!p.requiredDate) return acc;
    return !acc || p.requiredDate < acc ? p.requiredDate : acc;
  }, null);
  // Grouped by (supplier, PO) — `delivery` is already sorted by due date
  // ascending, so (per groupPartsByPo's own comment) these rows come out
  // sorted by their own earliest due date too, with no extra sort needed.
  const deliveryPos = groupPartsByPo(delivery);

  // No Purchase Order — `isUncoveredPart`, the same eligibility the Parts
  // List's "Uncovered (no PO)" filter and the readiness summary use (no PO,
  // no stock pull, no process schedule, BOM release status already applied,
  // not on hold). `parts` is already deduped by item id (job-bom-rules.ts's
  // own unique-requirement counting), so this card's total can never
  // disagree with either of those again — it used to check `!p.poNumber`
  // directly, which counted stock/process-covered parts as missing and
  // re-deduped by part number on top.
  const noPo = parts.filter(isUncoveredPart);
  const weekEnd = today + 7 * DAY;
  let noPoThisWeek = 0;
  let noPoOldest: string | null = null;
  for (const p of noPo) {
    const t = reqMs(p);
    if (Number.isFinite(t) && t <= weekEnd) noPoThisWeek++;
    if (p.requiredDate && (!noPoOldest || p.requiredDate < noPoOldest)) noPoOldest = p.requiredDate;
  }
  // Grouped by supplier (every part here has `poNumber === null` by
  // isUncoveredPart's own definition, so groupPartsByPo's PO half always
  // resolves to NO_PO_KEY — one row per supplier, exactly the "No PO /
  // Unassigned" grouping asked for). `noPo` isn't date-sorted (unlike
  // delivery/upcoming), so these rows are explicitly sorted oldest-
  // required-first, same read as the card's own `noPoOldest` stat.
  const noPoPos = groupPartsByPo(noPo).sort((a, b) => {
    const ra = earliestRequired(a.po.parts);
    const rb = earliestRequired(b.po.parts);
    if (ra == null && rb == null) return 0;
    if (ra == null) return 1;
    if (rb == null) return -1;
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
  // Part-mode equivalent of noPoPos' own ordering — individual parts
  // (rather than one row per supplier), oldest required date first, same
  // read as `noPoOldest`.
  const noPoSorted = [...noPo].sort((a, b) => {
    const ra = a.requiredDate;
    const rb = b.requiredDate;
    if (ra == null && rb == null) return 0;
    if (ra == null) return 1;
    if (rb == null) return -1;
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });

  // Upcoming — not received, due tomorrow through ~8 weeks out.
  const upStart = today + 1 * DAY;
  const upEnd = today + (UPCOMING_WEEKS * 7 + 1) * DAY;
  const upcoming = parts
    .filter((p) => {
      if (p.st.key === "received") return false;
      const t = dueMs(p);
      return Number.isFinite(t) && t >= upStart && t < upEnd;
    })
    .sort((a, b) => dueMs(a) - dueMs(b));
  // Per-week buckets, NOT cumulative: week 4 is "due in week 4", not "due
  // within 4 weeks". Selecting a week on the card shows that week alone.
  const weekData = Array.from({ length: UPCOMING_WEEKS }, (_, i) => {
    const w = i + 1;
    const wStart = today + ((w - 1) * 7 + 1) * DAY;
    const wEnd = today + (w * 7 + 1) * DAY;
    const wParts = upcoming.filter((p) => {
      const t = dueMs(p);
      return Number.isFinite(t) && t >= wStart && t < wEnd;
    });
    return { week: w, parts: wParts, count: wParts.length };
  });

  // Grouped over the FULL 8-week upcoming set (not just the selected
  // week) — this is what "See all" shows, same as `risk.upcoming` always
  // was, so opening it still surfaces every upcoming PO regardless of
  // which week button is active on the compact card underneath it.
  const upcomingAllPos = groupPartsByPo(upcoming);

  return {
    delivery,
    deliveryAvgLate,
    deliveryOldest,
    deliveryPos,
    noPo,
    noPoThisWeek,
    noPoOldest,
    noPoPos,
    noPoSorted,
    upcoming,
    upcomingAllPos,
    weekData,
  };
}
