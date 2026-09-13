import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publishEtcCell,
  forgetEtcCell,
  publishPartsCell,
  forgetPartsCell,
  readEtcLiveTotals,
  readEtcLiveFooterTotals,
  type LiveCell,
} from "../src/lib/etc-live-totals";

// The <tfoot> grand totals a manager watches while typing. Only the per-billing-
// group pair was ever wired to the live store; the per-SECTION pair — the total
// directly beneath the cell being edited — and the Parts Cost pair were summed on
// the server and sat frozen until a save. Reported 2026-08-03 as the column total
// "not changing in live", and then as Save being broken, since Save doesn't
// revalidate either so it also repainted nothing.
//
// These cover the summation only. What the store must never do is hold a formula
// of its own: publishers send figures they computed with lib/etc.ts, and the store
// adds them up. So the assertions here are about addition and about cells
// leaving, not about ETC arithmetic.

const cell = (over: Partial<LiveCell> = {}): LiveCell => ({
  jobId: 1,
  billingGroup: "Engineering",
  sectionCode: "10-211",
  prior: 100,
  worked: 40,
  hoursLeft: 60,
  effective: 50,
  diff: 10,
  decided: true,
  ...over,
});

// The store is module-global (deliberately — see its header), so each test
// clears up after itself rather than relying on order.
function withCells(entries: [string, LiveCell][], body: () => void) {
  for (const [key, c] of entries) publishEtcCell(key, c);
  try {
    body();
  } finally {
    for (const [key] of entries) forgetEtcCell(key);
  }
}

test("per-section footer total sums every job in that column", () => {
  withCells(
    [
      ["a", cell({ jobId: 1, sectionCode: "10-211", effective: 50, diff: 10 })],
      ["b", cell({ jobId: 2, sectionCode: "10-211", effective: 5, diff: -3 })],
      ["c", cell({ jobId: 3, sectionCode: "10-516", effective: 7, diff: 1 })],
    ],
    () => {
      const { sections } = readEtcLiveFooterTotals();
      assert.deepEqual(sections.get("10-211"), { newEtc: 55, diff: 7 });
      assert.deepEqual(sections.get("10-516"), { newEtc: 7, diff: 1 });
    },
  );
});

test("a section column total moves when one of its cells is retyped", () => {
  publishEtcCell("k", cell({ sectionCode: "40-211", effective: 20, diff: 5 }));
  assert.equal(readEtcLiveFooterTotals().sections.get("40-211")!.newEtc, 20);
  // Same cell key, new value — the manager typed over it.
  publishEtcCell("k", cell({ sectionCode: "40-211", effective: 31, diff: -6 }));
  assert.deepEqual(readEtcLiveFooterTotals().sections.get("40-211"), { newEtc: 31, diff: -6 });
  forgetEtcCell("k");
  assert.equal(readEtcLiveFooterTotals().sections.get("40-211"), undefined);
});

test("the section totals and the group totals sum the same cells", () => {
  // The footer's far-right Engineering/Shop rollup and its per-section columns are
  // two views of one set of cells. If they ever disagree, one of them is lying to
  // whoever is about to hit Submit.
  withCells(
    [
      ["a", cell({ jobId: 1, sectionCode: "10-211", billingGroup: "Engineering", effective: 50, diff: 10 })],
      ["b", cell({ jobId: 1, sectionCode: "10-516", billingGroup: "Engineering", effective: 12, diff: -2 })],
      ["c", cell({ jobId: 2, sectionCode: "10-411", billingGroup: "Shop", effective: 8, diff: 4 })],
    ],
    () => {
      const { sections } = readEtcLiveFooterTotals();
      const sectionSum = [...sections.values()].reduce((a, s) => ({ newEtc: a.newEtc + s.newEtc, diff: a.diff + s.diff }), { newEtc: 0, diff: 0 });

      const jobs = readEtcLiveTotals();
      let groupNewEtc = 0;
      let groupDiff = 0;
      for (const t of jobs.values()) {
        groupNewEtc += t.engineering.newEtc + t.shop.newEtc;
        groupDiff += t.engineering.diff + t.shop.diff;
      }

      assert.equal(sectionSum.newEtc, groupNewEtc);
      assert.equal(sectionSum.diff, groupDiff);
      assert.equal(sectionSum.newEtc, 70);
    },
  );
});

test("a parts republish that only flips `decided` still notifies", () => {
  // `decided` moves the row's own Diff between "—" and a figure, so the no-op shortcut
  // must compare it. Miss it and typing the first value into a Parts Cost cell would
  // leave that Diff showing "—".
  publishPartsCell(9, { prior: 100, spent: 10, left: 90, newEtc: 90, diff: 0, decided: false });
  assert.equal(readEtcLiveTotals().get(9)!.parts!.decided, false);
  publishPartsCell(9, { prior: 100, spent: 10, left: 90, newEtc: 90, diff: 0, decided: true });
  assert.equal(readEtcLiveTotals().get(9)!.parts!.decided, true);
  forgetPartsCell(9);
});

test("Parts Cost grand total sums the per-job parts cells", () => {
  publishPartsCell(1, { prior: 15000, spent: 2604.43, left: 12395.57, newEtc: 12000, diff: 395.57, decided: true });
  publishPartsCell(2, { prior: 500, spent: 100, left: 400, newEtc: 250, diff: 150, decided: true });
  const { parts } = readEtcLiveFooterTotals();
  assert.equal(parts.newEtc, 12250);
  assert.equal(Math.round(parts.diff * 100) / 100, 545.57);
  forgetPartsCell(1);
  forgetPartsCell(2);
  assert.deepEqual(readEtcLiveFooterTotals().parts, { newEtc: 0, diff: 0 });
});

test("a cell that unmounts stops counting — month switch and column filters", () => {
  publishEtcCell("x", cell({ sectionCode: "50-211", effective: 9, diff: 3 }));
  publishEtcCell("y", cell({ sectionCode: "50-211", effective: 1, diff: 1 }));
  assert.deepEqual(readEtcLiveFooterTotals().sections.get("50-211"), { newEtc: 10, diff: 4 });
  forgetEtcCell("y");
  assert.deepEqual(readEtcLiveFooterTotals().sections.get("50-211"), { newEtc: 9, diff: 3 });
  forgetEtcCell("x");
});

test("moving a cell to another section re-buckets it", () => {
  // Guards the no-op-republish shortcut: it compares every published field, so
  // sectionCode has to be one of them. Miss it and a cell would keep contributing
  // to the column it used to be in.
  publishEtcCell("m", cell({ sectionCode: "10-211", effective: 40, diff: 2 }));
  publishEtcCell("m", cell({ sectionCode: "10-312", effective: 40, diff: 2 }));
  const { sections } = readEtcLiveFooterTotals();
  assert.equal(sections.get("10-211"), undefined);
  assert.deepEqual(sections.get("10-312"), { newEtc: 40, diff: 2 });
  forgetEtcCell("m");
});
