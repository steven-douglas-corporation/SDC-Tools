// ── "How many people is this hiring position?" — one answer, one place ──────
//
// A hiring position row is no longer necessarily one head (2026-08-24): it
// carries a `quantity` of openings and a `filledCount` of those already hired
// against it. Before that change every hiring total in the app was some form of
// `positions.length` or `count + 1`, spread across WorkforceSummaryCards,
// EmployeesGrid and EmployeesCards.
//
// Replacing each of those with its own `reduce((s, p) => s + p.remainingQuantity)`
// would work and would also be four independent chances to use `quantity` where
// the answer is `remainingQuantity`, or to forget the `?? 1` that keeps rows
// predating the columns behaving as one opening. So the sum lives here instead,
// and the components call it.
//
// Deliberately dependency-free — no React, no Prisma, no "server-only" — for
// the same reason employee-workforce-groups.ts and hiring-position-status.ts
// are: this is imported by client components AND by server code, and
// `tsx --test` has to be able to load it directly.

/** The only shape any of this needs. Structural, so both HiringPosition and a test fixture satisfy it. */
export type HasOpenings = {
  quantity?: number | null;
  filledCount?: number | null;
  remainingQuantity?: number | null;
};

/**
 * How many unfilled openings one position represents.
 *
 * Prefers the already-clamped `remainingQuantity` that hiring-positions.ts
 * computes, and falls back to deriving it — so this is correct both for a real
 * HiringPosition and for a plain `{quantity}` object in a test or an older
 * caller. Absent everything, the answer is 1: that is what makes a row written
 * before the quantity columns existed keep counting as exactly one opening,
 * which the request asks for explicitly.
 */
export function openingsFor(position: HasOpenings): number {
  if (position.remainingQuantity != null) return Math.max(0, Math.trunc(position.remainingQuantity));
  const quantity = Math.max(1, Math.trunc(Number(position.quantity ?? 1)) || 1);
  const filled = Math.min(quantity, Math.max(0, Math.trunc(Number(position.filledCount ?? 0)) || 0));
  return Math.max(0, quantity - filled);
}

/**
 * Total unfilled openings across a set of positions — the number that belongs
 * anywhere the app used to say `positions.length`: Open Positions, Planned
 * Headcount, a department's or workforce group's hiring count, and any planning
 * KPI counting planned hires.
 *
 * Callers must still filter to OPEN positions first, exactly as they did before
 * this function existed (see EmployeesGrid's `openHiring`) — this sums openings,
 * it does not decide which positions count.
 */
export function countOpenings(positions: readonly HasOpenings[]): number {
  return positions.reduce((sum, p) => sum + openingsFor(p), 0);
}

/**
 * The "×2" suffix for a position's title, or "" for a single opening.
 *
 * Returning empty below 2 is the request's "show the quantity clearly when
 * greater than 1" — a "×1" on every ordinary position would be noise on the
 * overwhelming majority of rows, and would make the multi-opening ones harder
 * to spot rather than easier.
 */
export function openingsSuffix(quantity: number | null | undefined): string {
  const q = Math.trunc(Number(quantity ?? 1)) || 1;
  return q > 1 ? ` ×${q}` : "";
}

/**
 * Long form for a drawer or tooltip — "2 openings · 1 filled · 1 remaining",
 * or "" when there is only ever one opening and nothing interesting to say.
 */
export function openingsSummary(position: HasOpenings): string {
  const quantity = Math.max(1, Math.trunc(Number(position.quantity ?? 1)) || 1);
  if (quantity === 1) return "";
  const filled = Math.min(quantity, Math.max(0, Math.trunc(Number(position.filledCount ?? 0)) || 0));
  const parts = [`${quantity} openings`];
  if (filled > 0) parts.push(`${filled} filled`, `${quantity - filled} remaining`);
  return parts.join(" · ");
}
