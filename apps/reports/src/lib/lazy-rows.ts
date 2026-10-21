// ── Drawing a long table in chunks ───────────────────────────────────────────
//
// A table that holds thousands of rows costs the browser one DOM node per cell up
// front, whether anyone scrolls to them or not. The Data Management punch table gets
// up to 3,000 rows from the server and used to draw every one of them. It now draws a
// chunk and adds the next as the bottom of the scroll box comes into view.
//
// This is rendering only. The rows are all already in the browser, so sorting still
// covers every one of them and a header click re-sorts the whole set; only how many
// are drawn at a time changes. Nothing is fetched on scroll.
//
// Pure arithmetic, no React and no DOM, so tests/lazy-rows.test.ts can pin it.

/** Rows drawn first, and added each time the bottom of the table is reached. */
export const LAZY_CHUNK = 100;

/** How many rows to draw to start with, for `total` rows. */
export function firstVisible(total: number, chunk: number = LAZY_CHUNK): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(Math.floor(total), chunk);
}

/** How many to draw after one more chunk is asked for — never more than there are. */
export function nextVisible(current: number, total: number, chunk: number = LAZY_CHUNK): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const from = Number.isFinite(current) && current > 0 ? current : 0;
  return Math.min(Math.floor(total), from + chunk);
}

/**
 * The count to actually draw, given the one in state. The row list can change under a
 * mounted table (a realtime refresh re-renders it with the same filters), so the stored
 * count is clamped to the rows that exist and never drops below the first chunk.
 */
export function clampVisible(stored: number, total: number, chunk: number = LAZY_CHUNK): number {
  const floor = firstVisible(total, chunk);
  const safe = Number.isFinite(stored) ? stored : floor;
  return Math.min(Math.max(0, Math.floor(total)), Math.max(safe, floor));
}
