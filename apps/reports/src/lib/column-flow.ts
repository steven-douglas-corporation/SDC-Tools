// ── Cards that run down columns: who goes in which column ──────────────────────────────
//
// For cards of different heights laid out in columns that read top to bottom, then on to the
// top of the next column (ListCardGrid flow="columns"). The cards keep their order, so each
// column is a run of consecutive cards; the question is only where to cut.
//
// CSS multi-column answers it by filling columns one after another to a balanced height, which
// leaves the last columns EMPTY when there are few cards (six equal cards in four columns come
// out 2, 2, 2, and a blank). This cuts so that the tallest column is as short as it can be AND
// every column gets a card when there are enough of them: 2, 2, 1, 1.

/**
 * How many cards each column takes, in order, for `weights` (each card's height, or anything
 * proportional to it) across `columns` columns. Minimises the tallest column; among the cuts
 * that tie, the earlier columns are the fuller ones. Columns beyond the number of cards get 0.
 */
export function splitInOrder(weights: readonly number[], columns: number): number[] {
  const n = weights.length;
  const k = Math.max(1, Math.floor(columns));
  const used = Math.min(k, n);
  const sizes = new Array<number>(k).fill(0);
  if (n === 0) return sizes;

  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 1));
  const prefix = [0];
  for (const x of w) prefix.push(prefix[prefix.length - 1] + x);
  const sum = (from: number, to: number) => prefix[to] - prefix[from]; // cards [from, to)

  // best[j][i]: the smallest possible tallest column when the first i cards fill j columns,
  // none of them empty.
  const best: number[][] = Array.from({ length: used + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  best[0][0] = 0;
  for (let j = 1; j <= used; j++) {
    for (let i = j; i <= n; i++) {
      for (let m = j - 1; m < i; m++) {
        const tallest = Math.max(best[j - 1][m], sum(m, i));
        if (tallest < best[j][i]) best[j][i] = tallest;
      }
    }
  }

  // Walk back from the last column, giving it as few cards as the optimum allows, so the
  // fuller columns are the first ones. A hair of slack absorbs float rounding in the sums.
  const limit = best[used][n] * (1 + 1e-9);
  let end = n;
  for (let j = used; j >= 1; j--) {
    let start = end - 1;
    for (let m = end - 1; m >= j - 1; m--) {
      if (sum(m, end) <= limit && best[j - 1][m] <= limit) {
        start = m;
        break;
      }
    }
    sizes[j - 1] = end - start;
    end = start;
  }
  return sizes;
}
