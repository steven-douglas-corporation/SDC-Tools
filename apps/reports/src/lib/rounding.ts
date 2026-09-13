// ── One shared "largest remainder" rounding reconciliation, for ANY set of
// displayed parts that must sum to a displayed total (2026-08-17) ──────────
//
// Extracted from parts-cost-financials-shared.ts's `reconcilePartsCostRounding`
// (that name is kept, as a re-export, for backward compatibility — see that
// file), which was written for the Parts Cost card's fixed 2-3 term sum. This
// is the same algorithm, generalized: it is domain-neutral (no Parts Cost or
// Hours vocabulary in here) and works for any array length, so the Hours
// tab's grouped rollups — which can have anywhere from one to dozens of
// sibling rows at a given level — reuse the identical fix instead of a second
// copy of it.
//
// The problem this solves: rounding several full-precision numbers
// INDEPENDENTLY, then summing those DISPLAYED numbers, does not always equal
// a separately-rounded total of the same underlying figures — e.g.
// 10.4 + 10.4 + 10.4 = 31.2 exactly, but round(10.4)+round(10.4)+round(10.4) =
// 30, one less than round(31.2) = 31. Nothing in the underlying math is
// wrong; a reader who manually re-adds the DISPLAYED numbers gets a
// different total than the one shown, which reads as the app being wrong
// even though it isn't.
//
// Fixed with the standard "largest remainder" allocation: floor every part,
// then hand the leftover whole units (the difference between the floors' sum
// and the target total) to whichever parts lost the most to flooring. The
// result always sums to exactly `total`, and no individual figure is ever
// off by more than the same ~1 unit of rounding it already risked — this
// only decides WHICH parts absorb it, so the visible pieces always add up to
// the visible total.
export function reconcileRounding(parts: number[], targetTotal?: number): number[] {
  // Default: round the parts' OWN sum — the "no external total to match"
  // case (e.g. reconciling a set of root-level rows against nothing but
  // themselves). An explicit `targetTotal` lets a caller reconcile a set of
  // CHILD rows against their PARENT's own already-displayed number instead
  // of a fresh, independent rounding of the children's raw sum — which
  // matters when the parent itself was adjusted by ONE unit during ITS OWN
  // sibling reconciliation: without this, a child level could sum to a
  // number one off from the parent row directly above it, even though each
  // level individually reconciles perfectly with its own immediate total.
  const total = targetTotal ?? Math.round(parts.reduce((s, p) => s + p, 0));
  const floors = parts.map((p) => Math.floor(p));
  const floorSum = floors.reduce((s, f) => s + f, 0);
  const remainders = parts.map((p, i) => p - floors[i]);
  const order = remainders.map((_, i) => i).sort((a, b) => remainders[b] - remainders[a]);
  const toDistribute = Math.max(0, Math.min(parts.length, total - floorSum));
  const result = [...floors];
  for (let k = 0; k < toDistribute; k++) result[order[k]] += 1;
  return result;
}
