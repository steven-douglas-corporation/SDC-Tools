import { test } from "node:test";
import assert from "node:assert/strict";
import { rollupLiveTotals, reconcileEtcKpis, varianceTooltip } from "../src/lib/etc-kpi-live";
import { roundTo } from "../src/lib/cell-rules";

// ── KPI cards vs the tables under them (§28) ────────────────────────────────
//
// The reported symptom was "the cards don't update when the tables change". The
// actual defect was narrower and worse: the DIFFS were live and `newEtc` — the thing
// the diffs are computed from — was not, so a card could show a live variance beside
// a stale operand, and the Parts tooltip printed both in one sentence.
//
// These tests pin the rule: a field is live if and only if it derives from New ETC.

type Group = { prior: number; worked: number; hoursLeft: number; newEtc: number; diff: number; diffUnplanned: number; plannedHoursLeft: number; plannedNewEtc: number };
const group = (o: Partial<Group> = {}): Group => ({
  prior: 0, worked: 0, hoursLeft: 0, newEtc: 0, diff: 0, diffUnplanned: 0, plannedHoursLeft: 0, plannedNewEtc: 0, ...o,
});

// The server's page-load figures.
const SERVER = {
  engineering: { ...group({ prior: 1000, worked: 400, hoursLeft: 600, newEtc: 500, diff: 100, diffUnplanned: 40 }), people: 12 },
  shop: { ...group({ prior: 800, worked: 300, hoursLeft: 500, newEtc: 450, diff: 50, diffUnplanned: 10 }), people: 9 },
  parts: { prior: 20000, spent: 5000, moneyLeft: 15000, newEtc: 12000, diff: 3000, plannedMoneyLeft: 9000, plannedNewEtc: 6000 },
  hasPunchData: true,
};

// One job's published cells, as lib/etc-live-totals.ts shapes them.
function job(o: {
  eng?: Partial<{ newEtc: number; diff: number; diffUnplanned: number; plannedHoursLeft: number; plannedNewEtc: number }>;
  shop?: Partial<{ newEtc: number; diff: number; diffUnplanned: number; plannedHoursLeft: number; plannedNewEtc: number }>;
  parts?: { newEtc: number; diff: number; left?: number; decided?: boolean } | null;
}) {
  const g = (p: Partial<{ newEtc: number; diff: number; diffUnplanned: number; plannedHoursLeft: number; plannedNewEtc: number }> = {}) =>
    ({ prior: 0, worked: 0, hoursLeft: 0, newEtc: 0, diff: 0, diffUnplanned: 0, plannedHoursLeft: 0, plannedNewEtc: 0, ...p });
  return {
    engineering: g(o.eng),
    shop: g(o.shop),
    parts: o.parts ? { prior: 0, spent: 0, left: 0, decided: true, ...o.parts } : null,
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const totals = (...jobs: ReturnType<typeof job>[]) => new Map<number, any>(jobs.map((j, i) => [i + 1, j]));

// ── The rollup ──────────────────────────────────────────────────────────────

test("nothing published means no live rollup at all", () => {
  // The strip can be open on a month whose grid rows have not mounted. A confident
  // zero would be worse than the server's figure.
  assert.equal(rollupLiveTotals(new Map()), null);
});

test("the rollup adds every published job", () => {
  const r = rollupLiveTotals(totals(
    job({ eng: { newEtc: 100, diff: 10, diffUnplanned: 4 } }),
    job({ eng: { newEtc: 250, diff: -5, diffUnplanned: 0 }, shop: { newEtc: 70, diff: 3 } }),
  ))!;
  assert.equal(r.engineering.newEtc, 350);
  assert.equal(r.engineering.diff, 5);
  assert.equal(r.engineering.diffUnplanned, 4);
  assert.equal(r.shop.newEtc, 70);
});

test("parts stays null until a parts cell publishes", () => {
  // The Parts Cost column can be filtered out of the grid, which unmounts its cells.
  // Reporting $0 for a column that simply is not on screen is the §28.10 failure.
  assert.equal(rollupLiveTotals(totals(job({ eng: { newEtc: 5 } })))!.parts, null);
  const withParts = rollupLiveTotals(totals(job({ parts: { newEtc: 900, diff: 100, left: 1000 } })))!;
  assert.deepEqual(withParts.parts, { newEtc: 900, diff: 100, plannedMoneyLeft: 1000, plannedNewEtc: 900 });
});

// ── The identity that makes the tooltip foot (§28.15) ───────────────────────

test("planned left − planned New ETC IS the variance, exactly", () => {
  // This is the whole fix. `hoursLeft − newEtc` across the group does NOT equal
  // `diff`, because an undecided cell contributes 0 to diff while its Hours Left and
  // New ETC still land in the group totals. The planned pair excludes exactly those
  // cells, so the subtraction produces the number the card shows.
  const r = rollupLiveTotals(totals(
    // Decided: 500 left, 300 planned -> +200 variance.
    job({ eng: { newEtc: 300, diff: 200, plannedHoursLeft: 500, plannedNewEtc: 300 } }),
    // Decided: 100 left, 250 planned -> -150 (overspent).
    job({ eng: { newEtc: 250, diff: -150, plannedHoursLeft: 100, plannedNewEtc: 250 } }),
    // UNDECIDED: contributes 0 to diff and 0 to both operands, though its New ETC
    // still counts toward the month's total.
    job({ eng: { newEtc: 4000, diff: 0, diffUnplanned: 0, plannedHoursLeft: 0, plannedNewEtc: 0 } }),
  ))!;
  assert.equal(r.engineering.plannedHoursLeft - r.engineering.plannedNewEtc, r.engineering.diff);
  assert.equal(r.engineering.diff, 50);
  // …while the naive group subtraction does not, which is precisely the old bug.
  assert.notEqual(600 - r.engineering.newEtc, r.engineering.diff);
});

test("the identity survives reconciliation, to the precision it is shown at", () => {
  // The two operands are rounded independently on the way out, so their difference
  // can land a float epsilon away from the rounded diff (0.7 − 0.4 is
  // 0.29999999999999993, not 0.3). That is not a reconciliation failure: the tooltip
  // formats both sides through the same formatter, and what has to be true is that
  // the printed subtraction produces the printed variance. Asserted at cent
  // precision, which is finer than anything the strip displays.
  const out = reconcileEtcKpis(SERVER, rollupLiveTotals(totals(
    job({ eng: { newEtc: 0.1, diff: 0.1, plannedHoursLeft: 0.3, plannedNewEtc: 0.2 } }),
    job({ eng: { newEtc: 0.2, diff: 0.2, plannedHoursLeft: 0.4, plannedNewEtc: 0.2 } }),
  ))!);
  assert.equal(
    roundTo(out.engineering.plannedHoursLeft - out.engineering.plannedNewEtc, 2),
    out.engineering.diff,
  );
});

test("a fully-planned month makes the planned pair the group pair", () => {
  // Nothing excluded, so the tooltip needs no caveat and the two subtractions agree.
  const r = rollupLiveTotals(totals(
    job({ eng: { newEtc: 300, diff: 200, plannedHoursLeft: 500, plannedNewEtc: 300 } }),
  ))!;
  assert.equal(r.engineering.plannedNewEtc, r.engineering.newEtc);
  assert.equal(r.engineering.plannedHoursLeft - r.engineering.plannedNewEtc, r.engineering.diff);
});

// ── What is live, and what must NOT be ──────────────────────────────────────

test("New ETC and every figure derived from it come from the live cells", () => {
  // The actual bug: `diff` was live and `newEtc` was not, so the two disagreed.
  //
  // Note the card's diff is DERIVED from the planned operands, not taken from the
  // cell's published `diff` — the cells publish the Diff COLUMN's figure, which
  // deliberately counts an undecided cell's whole Hours Left and is not a variance.
  const out = reconcileEtcKpis(SERVER, rollupLiveTotals(totals(
    job({
      eng: { newEtc: 640, diff: 999, diffUnplanned: 0, plannedHoursLeft: 600, plannedNewEtc: 640 },
      shop: { newEtc: 111, diff: 999, diffUnplanned: 3, plannedHoursLeft: 133, plannedNewEtc: 111 },
      parts: { newEtc: 7777, diff: 999, left: 9011, decided: true },
    }),
  ))!);
  assert.equal(out.engineering.newEtc, 640);
  assert.equal(out.engineering.diff, -40, "600 − 640");
  assert.equal(out.engineering.diffUnplanned, 0);
  assert.equal(out.shop.newEtc, 111);
  assert.equal(out.shop.diff, 22, "133 − 111");
  assert.equal(out.parts.newEtc, 7777);
  assert.equal(out.parts.diff, 1234, "9011 − 7777");
});

test("the card ignores the cells' own Diff-column figure", () => {
  // The reported bug, reduced: one undecided Parts cell with $500k of Money Left.
  // The CELL publishes diff = $500k, because the Diff column prints unplanned money.
  // The CARD must publish $0 — nobody has planned it, so there is no variance — which
  // is exactly what the server's newEtcDiff says for the same cell.
  const out = reconcileEtcKpis(SERVER, rollupLiveTotals(totals(
    job({ parts: { newEtc: 0, diff: 500_000, left: 500_000, decided: false } }),
  ))!);
  assert.equal(out.parts.diff, 0, "unplanned money is not an underrun");
  assert.notEqual(out.parts.diff, 500_000);
});

test("synced figures are never overwritten by the live store", () => {
  // Hours worked, money spent and headcount describe what already happened. Typing a
  // New ETC must not move them, and the live store carries no opinion about them.
  const out = reconcileEtcKpis(SERVER, rollupLiveTotals(totals(job({ eng: { newEtc: 1 } })))!);
  assert.equal(out.engineering.worked, 400);
  assert.equal(out.engineering.prior, 1000);
  assert.equal(out.engineering.hoursLeft, 600);
  assert.equal(out.engineering.people, 12);
  assert.equal(out.shop.people, 9);
  assert.equal(out.parts.spent, 5000);
  assert.equal(out.parts.moneyLeft, 15000);
  assert.equal(out.hasPunchData, true);
});

test("with nothing published, every figure is the server's", () => {
  assert.deepEqual(reconcileEtcKpis(SERVER, null), SERVER);
});

test("a filtered-out Parts column leaves the server's parts figures alone", () => {
  const out = reconcileEtcKpis(SERVER, rollupLiveTotals(totals(job({ eng: { newEtc: 5 } })))!);
  assert.deepEqual(out.parts, SERVER.parts);
});

// ── Clearing and zero (§28.7, §28.8) ────────────────────────────────────────

test("clearing every cell drops the old amount out of the KPI", () => {
  // A cleared New ETC publishes 0 — it does not stop publishing. So the card must
  // fall to 0, not silently keep the server's 500.
  const out = reconcileEtcKpis(SERVER, rollupLiveTotals(totals(job({ eng: { newEtc: 0, diff: 600 } })))!);
  assert.equal(out.engineering.newEtc, 0, "the cleared amount must leave the KPI");
  assert.notEqual(out.engineering.newEtc, SERVER.engineering.newEtc);
});

test("zero is a value, not an absence", () => {
  // The whole rollup summing to 0 must still REPLACE the server figure. Treating a
  // zero total as "nothing published" would restore the old number — §28.8's
  // "do not restore an earlier value because the new value is zero".
  const r = rollupLiveTotals(totals(job({ eng: { newEtc: 0, diff: 0 } })));
  assert.notEqual(r, null, "a published zero is still a publication");
  const out = reconcileEtcKpis(SERVER, r!);
  assert.equal(out.engineering.newEtc, 0);
  assert.equal(out.engineering.diff, 0);
});

// ── Numbers (§28.19 #16, §27.18) ────────────────────────────────────────────

test("negatives and large values survive intact", () => {
  const out = reconcileEtcKpis(SERVER, rollupLiveTotals(totals(
    job({
      eng: { newEtc: -50, plannedHoursLeft: -1250, plannedNewEtc: -50 },
      parts: { newEtc: 1_000_000, diff: 0, left: 750_000, decided: true },
    }),
  ))!);
  assert.equal(out.engineering.newEtc, -50);
  assert.equal(out.engineering.diff, -1200);
  assert.equal(out.parts.newEtc, 1_000_000);
  assert.equal(out.parts.diff, -250_000, "750,000 − 1,000,000");
});

test("the live figure is rounded the way the server rounds, so a save changes nothing", () => {
  // Float summation order alone must not make the card flicker by a cent when the
  // server's value replaces the live one after a save.
  const out = reconcileEtcKpis(SERVER, rollupLiveTotals(totals(
    job({ eng: { newEtc: 0.1, diff: 0.1 } }),
    job({ eng: { newEtc: 0.2, diff: 0.2 } }),
  ))!);
  assert.equal(out.engineering.newEtc, 0.3, "0.1 + 0.2 must not surface as 0.30000000000000004");
});

// ── The tooltip that started this (§28.15) ──────────────────────────────────

test("the tooltip's subtraction produces the variance beside it", () => {
  // One decided parts cell: $15,000 left, $9,000 planned -> $6,000 under.
  const out = reconcileEtcKpis(
    SERVER,
    rollupLiveTotals(totals(job({ parts: { newEtc: 9000, diff: 6000, left: 15000, decided: true } })))!,
  );
  const usd = (n: number) => `$${n}`;
  const text = varianceTooltip({
    leftLabel: "Money Left",
    plannedLeft: out.parts.plannedMoneyLeft,
    plannedNewEtc: out.parts.plannedNewEtc,
    groupLeft: out.parts.moneyLeft,
    groupNewEtc: out.parts.newEtc,
    format: usd,
  });
  // It quotes the LIVE figures, not the server's 12000 — the vintage half of the bug.
  assert.match(text, /\$9000/);
  assert.ok(!text.includes("12000"), "must not quote the page-load New ETC");
  // And the arithmetic works: $15,000 − $9,000 = $6,000, the number on the card.
  assert.equal(out.parts.plannedMoneyLeft - out.parts.plannedNewEtc, out.parts.diff);
  assert.match(text, /\$15000/);
});

test("the tooltip says what it excluded, and only when something was", () => {
  const usd = (n: number) => `$${n}`;
  // $6,000 of Money Left sits in cells nobody has planned — say so, or the smaller
  // figures look like the month has lost money.
  const withUnplanned = varianceTooltip({
    leftLabel: "Money Left", plannedLeft: 9000, plannedNewEtc: 3000, groupLeft: 15000, groupNewEtc: 12000, format: usd,
  });
  assert.match(withUnplanned, /\$6000 of money left has no New ETC entered yet/);
  // Nothing excluded: no caveat, because it would be noise.
  const fullyPlanned = varianceTooltip({
    leftLabel: "Money Left", plannedLeft: 15000, plannedNewEtc: 12000, groupLeft: 15000, groupNewEtc: 12000, format: usd,
  });
  assert.ok(!/excluded/.test(fullyPlanned), fullyPlanned);
});
