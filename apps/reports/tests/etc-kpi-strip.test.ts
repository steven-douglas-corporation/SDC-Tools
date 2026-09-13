import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildKpiBlocks,
  kpiDetailState,
  kpiLaneFor,
  offGridTotalHours,
  undefinedHoursTotals,
  KPI_GRID_CLASS,
  type DrillScope,
  type KpiBlock,
  type KpiBlockId,
  type KpiLanes,
} from "../src/lib/etc-kpi-strip";
import { reconcileEtcKpis, rollupLiveTotals } from "../src/lib/etc-kpi-live";
import { readKpiStripOpen, writeKpiStripOpen, subscribeKpiStrip } from "../src/lib/kpi-strip-pref";
import type { EtcMonthKpis } from "../src/lib/etc-month-kpis";
import type { OffGridJob } from "../src/lib/off-grid-hours";

// ── Six KPI cards became one card (§37) ─────────────────────────────────────
//
// The change was framed as visual — "combine the cards" — and §37.12 spends a page
// listing what must survive it, because a consolidation is exactly the edit that loses
// a KPI, points two blocks at the same drill-through, or drops a tone. None of that
// shows up in a diff as anything but moved divs.
//
// So the strip's content is a pure function (lib/etc-kpi-strip.ts) and these are the
// §37.13 criteria that are decidable: every KPI present with its own value, its own
// status, its own drill; the live figures reaching the right block and no other; a slow
// or failed KPI leaving the other five alone; and the layout stacking rather than
// clipping on a narrow screen.

// Plain formatters, so an assertion reads as arithmetic rather than as locale output.
// The real component passes ui/format's usd() and hours() — what is being pinned here is
// WHICH figure reaches WHICH block, not how a number is punctuated.
const FMT = { hours: (n: number) => String(Math.round(n)), usd: (n: number) => `$${Math.round(n)}` };

type Group = EtcMonthKpis["engineering"];
const group = (o: Partial<Group> = {}): Group => ({
  prior: 0,
  worked: 0,
  hoursLeft: 0,
  newEtc: 0,
  diff: 0,
  diffUnplanned: 0,
  plannedHoursLeft: 0,
  plannedNewEtc: 0,
  people: 0,
  ...o,
});

// A fully-planned month: every group has a real variance and nothing is unplanned, so
// each block reports an over/under rather than an "unplanned" figure.
const KPIS: EtcMonthKpis = {
  engineering: group({ prior: 3000, worked: 2980, hoursLeft: 620, newEtc: 500, diff: 120, people: 12 }),
  shop: group({ prior: 2800, worked: 2675, hoursLeft: 500, newEtc: 540, diff: -40, people: 9 }),
  parts: { prior: 1_500_000, spent: 1_432_857, moneyLeft: 67_143, newEtc: 90_000, diff: -22_857, plannedMoneyLeft: 67_143, plannedNewEtc: 90_000 },
  hasPunchData: true,
};

const ISSUES = [{ label: "NOT DEFINED", rows: 3, hours: 27.5 }];
const OFF_GRID: OffGridJob[] = [
  { jobId: "1105", jobName: "Line 4 retool", status: "Complete", hours: 120, sections: [{ section: "10-313", hours: 120 }] },
  { jobId: "1187", jobName: "HeadStart cell", status: "HeadStart", hours: 61, sections: [] },
];

function blocks(o: Partial<{ kpis: EtcMonthKpis; importIssues: typeof ISSUES; offGridJobs: OffGridJob[] }> = {}): KpiBlock[] {
  return buildKpiBlocks(
    { kpis: o.kpis ?? KPIS, importIssues: o.importIssues ?? ISSUES, offGridJobs: o.offGridJobs ?? OFF_GRID },
    FMT,
  );
}
const byId = (bs: KpiBlock[], id: KpiBlockId): KpiBlock => {
  const b = bs.find((x) => x.id === id);
  assert.ok(b, `no ${id} block`);
  return b;
};

// ── 1. Every KPI is still there (§37.13 #1, #2, #20) ────────────────────────

test("all five KPIs are present, in reading order", () => {
  // Five since §64 retired the standalone "People booked" block (its split moved into
  // Engineering/Shop's own countLabel — see the headcount tests below). An extra block
  // would be a KPI nobody asked for; a missing one is the failure the whole requirement
  // is about.
  assert.deepEqual(
    blocks().map((b) => b.id),
    ["engineering", "shop", "parts", "undefined", "offGrid"],
  );
  assert.deepEqual(
    blocks().map((b) => b.label),
    ["Engineering hours", "Shop hours", "Parts spent", "Data Quality — Undefined Hours", "Hours off the grid"],
  );
});

test("off-grid is the only conditional block, and it is hidden at zero", () => {
  // "0 undefined hours" is a daily reassurance the import is clean, so that block stays
  // at zero. A permanent "0 off-grid" block would just be dead space.
  const clean = blocks({ importIssues: [], offGridJobs: [] });
  assert.deepEqual(clean.map((b) => b.id), ["engineering", "shop", "parts", "undefined"]);
  assert.equal(byId(clean, "undefined").value, "0");
});

test("every block is visually distinct: its own label, value and status", () => {
  // §37.13 #2. Sharing a value or a status between two blocks would mean one of them is
  // describing the other's figure.
  const bs = blocks();
  assert.equal(new Set(bs.map((b) => b.label)).size, bs.length);
  assert.equal(new Set(bs.map((b) => b.id)).size, bs.length);
  for (const b of bs) {
    assert.ok(b.label.length > 0, `${b.id} has no label`);
    assert.ok(b.value.length > 0, `${b.id} has no value`);
    assert.ok(b.statusText.length > 0, `${b.id} has no status text`);
  }
});

// ── 2. Each KPI keeps its own figure (§37.13 #3, #7; §37.3) ─────────────────

test("each block reads its own KPI, and no block averages two", () => {
  const bs = blocks();
  assert.equal(byId(bs, "engineering").value, "2980", "engineering hours worked");
  assert.equal(byId(bs, "shop").value, "2675", "shop hours worked");
  assert.equal(byId(bs, "parts").value, "$1432857", "parts money spent");
  assert.equal(byId(bs, "undefined").value, "28", "27.5 undefined hours, rounded");
  assert.equal(byId(bs, "offGrid").value, "181", "120 + 61 off the grid");
});

test("moving one KPI moves exactly one block", () => {
  // §37.3's "do not combine or average values that are currently separate", stated as a
  // property: change Shop's hours and every other block must be byte-identical. This is
  // also what makes the memoised blocks in the component skip re-rendering.
  const before = blocks();
  const after = blocks({ kpis: { ...KPIS, shop: group({ ...KPIS.shop, worked: 9999 }) } });
  for (const b of before) {
    const other = byId(after, b.id);
    if (b.id === "shop") assert.notDeepEqual(other, b, "the shop block must move");
    else assert.deepEqual(other, b, `${b.id} must not move when shop's hours change`);
  }
});

test("a large value is carried in full, never abbreviated", () => {
  // §37.13 #15. The block cannot clip what it was never given: the whole formatted
  // figure is in `value`, and the layout gives it its own line.
  const big = blocks({
    kpis: { ...KPIS, parts: { ...KPIS.parts, spent: 1_432_857.49 } },
  });
  assert.equal(byId(big, "parts").value, "$1432857");
  assert.ok(!byId(big, "parts").value.includes("…"));
});

test("no punch data means no confident headcount", () => {
  // §64: the headcount now lives on the hours blocks themselves. With no punch rows at
  // all there is nothing to count, so countLabel (and the link) are absent rather than
  // a confident "0 engineers".
  const bs = blocks({ kpis: { ...KPIS, hasPunchData: false } });
  assert.equal(byId(bs, "engineering").countLabel, null);
  assert.equal(byId(bs, "shop").countLabel, null);
  assert.equal(byId(bs, "engineering").hint, null);
});

// ── 2b. The retired People Booked block's split, now on the hours blocks (§64) ──

test("Engineering and Shop each carry their own headcount label", () => {
  // KPIS above: engineering.people = 12, shop.people = 9 — the same figures the old
  // People Booked block's "12 eng · 9 shop" hint quoted, now on the block they describe
  // instead of a third block between them and Parts spent.
  const bs = blocks();
  assert.equal(byId(bs, "engineering").countLabel, "12 engineers");
  assert.equal(byId(bs, "shop").countLabel, "9 shop");
  // Parts, Undefined and Off-grid have no headcount of their own.
  assert.equal(byId(bs, "parts").countLabel, null);
  assert.equal(byId(bs, "undefined").countLabel, null);
  const withOffGrid = blocks({ offGridJobs: OFF_GRID });
  assert.equal(byId(withOffGrid, "offGrid").countLabel, null);
});

test("the headcount label is singular for exactly one person", () => {
  const bs = blocks({
    kpis: { ...KPIS, engineering: group({ ...KPIS.engineering, people: 1 }), shop: group({ ...KPIS.shop, people: 1 }) },
  });
  assert.equal(byId(bs, "engineering").countLabel, "1 engineer");
  // "1 shop" reads fine without a singular/plural split — "shop" was never a countable
  // noun to begin with, unlike "engineer(s)".
  assert.equal(byId(bs, "shop").countLabel, "1 shop");
});

test("the headcount is the SAME figure the drill reconciles against, not a second one", () => {
  // §64's own caution: do not just relabel a number, use the one already scoped
  // identically to the hours it sits beside. `g.people` is what getEtcMonthKpis counts
  // from JobHoursDetail over the exact same (month, jobIds) as `g.worked` — this pins
  // that the strip reads that field verbatim rather than deriving its own count.
  const bs = blocks({
    kpis: { ...KPIS, engineering: group({ ...KPIS.engineering, people: 24 }), shop: group({ ...KPIS.shop, people: 21 }) },
  });
  assert.equal(byId(bs, "engineering").countLabel, "24 engineers");
  assert.equal(byId(bs, "shop").countLabel, "21 shop");
});

test("changing one group's headcount moves only that block", () => {
  // The same §37.4 property the hours figures already have, extended to the new field:
  // a memoised block must not re-render for a change that is not its own.
  const before = blocks();
  const after = blocks({ kpis: { ...KPIS, shop: group({ ...KPIS.shop, people: 40 }) } });
  assert.notEqual(byId(after, "shop").countLabel, byId(before, "shop").countLabel);
  assert.equal(byId(after, "engineering").countLabel, byId(before, "engineering").countLabel);
  assert.deepEqual(byId(after, "engineering"), byId(before, "engineering"));
});

// ── 3. Status, arrows and colour (§37.1, §37.10) ────────────────────────────

test("a variance says which way it went, in words as well as colour", () => {
  const bs = blocks();
  const eng = byId(bs, "engineering");
  assert.equal(eng.statusKind, "variance");
  assert.equal(eng.statusArrow, "▲");
  assert.equal(eng.statusText, "120 under");
  assert.equal(eng.statusSign, 1);
  const shop = byId(bs, "shop");
  assert.equal(shop.statusArrow, "▼");
  assert.equal(shop.statusText, "40 over");
  assert.equal(shop.statusSign, -1);
  // §37.10: status is never colour alone. Every signed status carries the word too.
  for (const b of bs) {
    if (b.statusSign !== 0) assert.match(b.statusText, /under|over/, `${b.id} status is colour-only`);
  }
});

test("zero variance reads 'On plan', not '0'", () => {
  const bs = blocks({ kpis: { ...KPIS, engineering: group({ ...KPIS.engineering, diff: 0 }) } });
  const eng = byId(bs, "engineering");
  assert.equal(eng.statusText, "On plan");
  assert.equal(eng.statusSign, 0, "neutral — a zero variance is neither good nor bad news");
  assert.equal(eng.statusArrow, "");
});

test("unplanned work is reported as unplanned, not as an underrun", () => {
  // The rule newEtcDiff's own comment is about: a blank New ETC counts as 0, so an
  // untouched cell contributes its whole Hours Left. Printing "+4,070 under" for that
  // would be the block lying — nobody has planned it at all.
  const bs = blocks({
    kpis: { ...KPIS, engineering: group({ ...KPIS.engineering, diff: 4070, diffUnplanned: 4070 }) },
  });
  const eng = byId(bs, "engineering");
  assert.equal(eng.statusKind, "unplanned");
  assert.equal(eng.statusText, "4070 unplanned");
  assert.equal(eng.statusSign, 0, "not green — unplanned is unfinished input, not an underrun");
  assert.match(eng.statusTitle, /no New ETC entered/);
  assert.match(eng.statusTitle, /exactly on plan/, "and it says what the decided cells did");
});

test("a partly-planned group reports both figures", () => {
  // 4,070 unplanned, and the cells that HAVE been planned are 70 over.
  const bs = blocks({
    kpis: { ...KPIS, shop: group({ ...KPIS.shop, diff: 4000, diffUnplanned: 4070 }) },
  });
  const shop = byId(bs, "shop");
  assert.equal(shop.statusText, "4070 unplanned");
  assert.match(shop.statusTitle, /already planned are 70 over/);
});

test("the parts tooltip's subtraction produces the variance beside it", () => {
  // §28.15's property, kept alive through the consolidation: the sentence quotes the
  // PLANNED pair, which subtracts to the number on the block, rather than the group
  // totals, which do not.
  const bs = blocks();
  const parts = byId(bs, "parts");
  assert.equal(parts.statusText, "$22857 over");
  assert.match(parts.statusTitle, /Money Left \(\$67143\) − New ETC \(\$90000\)/);
  assert.equal(KPIS.parts.plannedMoneyLeft - KPIS.parts.plannedNewEtc, KPIS.parts.diff);
});

test("a tone is always said in words too, never in colour alone", () => {
  // §37.10. The amber and red tints are the only signal a sighted reader needs; the
  // toneLabel is what a screen reader gets.
  const bs = blocks();
  assert.equal(byId(bs, "undefined").tone, "warn");
  assert.equal(byId(bs, "undefined").toneLabel, "Needs attention");
  assert.equal(byId(bs, "offGrid").tone, "danger", "these rows are deleted by the next refresh");
  assert.equal(byId(bs, "offGrid").toneLabel, "Action needed");
  for (const b of bs) {
    assert.equal(b.tone == null, b.toneLabel == null, `${b.id}: tone and toneLabel must agree`);
  }
});

test("a clean import is not painted as a problem", () => {
  const bs = blocks({ importIssues: [] });
  assert.equal(byId(bs, "undefined").tone, null);
  assert.equal(byId(bs, "undefined").statusText, "None outstanding");
  assert.match(byId(bs, "undefined").hint!, /valid job number/);
});

test("every block keeps an explanation reachable", () => {
  // §37.1's "any existing tooltip or explanation". A figure with neither a hint nor a
  // status title is one nobody can interrogate.
  for (const b of blocks()) {
    assert.ok(b.hint != null || b.statusTitle.length > 0, `${b.id} explains itself nowhere`);
  }
});

// ── 4. One drill per KPI (§37.2, §37.13 #4, #5) ─────────────────────────────

test("each KPI keeps its own drill-through, and no two share one", () => {
  // §37.2 forbids exactly the shortcut a consolidation invites: one generic drill for
  // the whole card. Five blocks, five distinct scopes — the unscoped "All" (People
  // Booked) retired with its block (§64).
  const bs = blocks();
  const drills = bs.map((b) => b.drill);
  assert.deepEqual(drills, ["Engineering", "Shop", "Parts", "Unattributed", "OffGrid"]);
  assert.equal(new Set(drills).size, drills.length, "two blocks point at the same drill");
});

test("a drill is offered only when there is something behind it", () => {
  // Not a lost Detail link — these are the same conditions the six cards had. An
  // Engineering drill with no punch rows would open an empty panel, and an undefined-hours
  // drill at zero has nothing to list.
  const noPunches = blocks({ kpis: { ...KPIS, hasPunchData: false } });
  assert.equal(byId(noPunches, "engineering").drill, null);
  assert.equal(byId(noPunches, "shop").drill, null);
  assert.equal(byId(noPunches, "parts").drill, "Parts", "parts money does not depend on punches");
  const clean = blocks({ importIssues: [] });
  assert.equal(byId(clean, "undefined").drill, null);
});

test("a block's totals are the ones its drill panel is built from", () => {
  // §37.13 #6 — the block and its own detail must reconcile. Both read these helpers,
  // so there is one sum rather than two that agree today.
  assert.equal(offGridTotalHours(OFF_GRID), 181);
  assert.deepEqual(undefinedHoursTotals(ISSUES), { hours: 27.5, entries: 3 });
  assert.equal(byId(blocks(), "offGrid").value, FMT.hours(offGridTotalHours(OFF_GRID)));
  assert.equal(byId(blocks(), "undefined").value, FMT.hours(undefinedHoursTotals(ISSUES).hours));
});

test("the off-grid hint names the jobs, and says how many it left out", () => {
  const many: OffGridJob[] = [...OFF_GRID, { jobId: "1201", jobName: "x", status: null, hours: 5, sections: [] }];
  const hint = byId(blocks({ offGridJobs: many }), "offGrid").hint!;
  assert.match(hint, /1105, 1187, \+1 more/);
  assert.match(hint, /missing from every figure here/);
  assert.equal(byId(blocks({ offGridJobs: many }), "offGrid").statusText, "3 jobs not listed");
});

// ── 5. Live edits reach the right block (§37.4, §37.13 #8, #9) ──────────────

// One job's published cells, as lib/etc-live-totals.ts shapes them.
function published(o: {
  eng?: Partial<{ newEtc: number; plannedHoursLeft: number; plannedNewEtc: number; diffUnplanned: number }>;
  shop?: Partial<{ newEtc: number; plannedHoursLeft: number; plannedNewEtc: number; diffUnplanned: number }>;
  parts?: { newEtc: number; left: number; decided: boolean };
}) {
  const g = (p = {}) => ({ prior: 0, worked: 0, hoursLeft: 0, newEtc: 0, diff: 0, diffUnplanned: 0, plannedHoursLeft: 0, plannedNewEtc: 0, ...p });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Map<number, any>([
    [1, { engineering: g(o.eng), shop: g(o.shop), parts: o.parts ? { prior: 0, spent: 0, diff: 0, ...o.parts } : null }],
  ]);
}
// The strip as the component builds it: server figures reconciled with the live cells.
const liveBlocks = (totals: ReturnType<typeof published>) =>
  buildKpiBlocks({ kpis: reconcileEtcKpis(KPIS, rollupLiveTotals(totals)), importIssues: ISSUES, offGridJobs: OFF_GRID }, FMT);

test("typing a New ETC moves that group's status, live", () => {
  // 620 planned Hours Left against a 700 New ETC = 80 over, and the block must say so
  // without a page refresh (§37.13 #8). The figure comes through reconcileEtcKpis, which
  // is the one place that decides live-vs-synced.
  const bs = liveBlocks(published({ eng: { newEtc: 700, plannedHoursLeft: 620, plannedNewEtc: 700 } }));
  const eng = byId(bs, "engineering");
  assert.equal(eng.statusText, "80 over");
  assert.equal(eng.statusSign, -1);
  // …and the server's +120 is gone, rather than sitting beside the live figure.
  assert.notEqual(eng.statusText, "120 under");
});

test("a live edit in one group leaves the other blocks untouched", () => {
  // §37.4: "update only the affected KPI block". The blocks for Shop, Parts, Undefined
  // and Off-grid must come back deep-equal, which is what lets React.memo skip them in
  // the component.
  const before = liveBlocks(published({ eng: { newEtc: 500, plannedHoursLeft: 620, plannedNewEtc: 500 } }));
  const after = liveBlocks(published({ eng: { newEtc: 700, plannedHoursLeft: 620, plannedNewEtc: 700 } }));
  assert.notDeepEqual(byId(after, "engineering"), byId(before, "engineering"));
  for (const id of ["shop", "parts", "undefined", "offGrid"] as KpiBlockId[]) {
    assert.deepEqual(byId(after, id), byId(before, id), `${id} re-rendered for an engineering edit`);
  }
});

test("hours worked, money spent and headcount do not move when someone types", () => {
  // They describe what already happened. Only a Refresh Data pass can change them, and
  // the live store carries no opinion about them.
  const bs = liveBlocks(published({ eng: { newEtc: 99_999 }, shop: { newEtc: 99_999 }, parts: { newEtc: 99_999, left: 0, decided: true } }));
  assert.equal(byId(bs, "engineering").value, "2980");
  assert.equal(byId(bs, "shop").value, "2675");
  assert.equal(byId(bs, "parts").value, "$1432857");
  assert.equal(byId(bs, "engineering").countLabel, "12 engineers");
  assert.equal(byId(bs, "shop").countLabel, "9 shop");
});

test("a live parts edit re-states the tooltip with the figures it used", () => {
  // The §28.15 failure, guarded at the block level: a live variance beside a page-load
  // operand. Both now come from the same reconciled object.
  const bs = liveBlocks(published({ parts: { newEtc: 40_000, left: 67_143, decided: true } }));
  const parts = byId(bs, "parts");
  assert.equal(parts.statusText, "$27143 under");
  assert.match(parts.statusTitle, /New ETC \(\$40000\)/);
  assert.ok(!parts.statusTitle.includes("90000"), "must not quote the page-load New ETC");
});

test("nothing published yet leaves every block on the server's figures", () => {
  // The summary can be open on a month whose grid rows have not mounted. That is not a
  // reason to show zeroes.
  assert.deepEqual(liveBlocks(new Map()), blocks());
});

// ── 6. Refresh Data (§37.5, §37.13 #10) ────────────────────────────────────

test("the whole card is built from one snapshot, so it cannot mix vintages", () => {
  // §37.5: "the unified card must not show a mixture of old and new values". The blocks
  // are a pure function of ONE kpis object — there is no per-block source to get out of
  // step, which is the structural version of that requirement.
  const refreshed: EtcMonthKpis = {
    ...KPIS,
    engineering: group({ ...KPIS.engineering, worked: 3100, people: 13 }),
    shop: group({ ...KPIS.shop, worked: 2700, people: 10 }),
    parts: { ...KPIS.parts, spent: 1_500_000 },
  };
  const after = blocks({ kpis: refreshed, importIssues: [{ label: "NOT DEFINED", rows: 1, hours: 4 }], offGridJobs: [] });
  assert.equal(byId(after, "engineering").value, "3100");
  assert.equal(byId(after, "shop").value, "2700");
  assert.equal(byId(after, "parts").value, "$1500000");
  assert.equal(byId(after, "engineering").countLabel, "13 engineers", "the refreshed headcount, not the stale one");
  assert.equal(byId(after, "shop").countLabel, "10 shop");
  assert.equal(byId(after, "undefined").value, "4");
  // The off-grid block leaves with its data rather than lingering with a stale figure.
  assert.equal(after.find((b) => b.id === "offGrid"), undefined);
});

test("building the strip twice from the same figures gives the same strip", () => {
  // No hidden state, no clock, no random ids — so a re-render during a refresh cannot
  // produce a different card, and a block only changes when its figure does.
  assert.deepEqual(blocks(), blocks());
});

// ── 7. One slow or failed KPI (§37.9, §37.13 #11) ───────────────────────────

const lanes = (o: Partial<KpiLanes> = {}): KpiLanes => ({
  punches: { loading: false, error: null, loaded: false },
  parts: { loading: false, error: null, loaded: false },
  undefinedHours: { loading: false, error: null, loaded: false },
  ...o,
});

test("Engineering and Shop share one punch request; the others are their own", () => {
  // One fetch narrowed client-side, rather than two identical round trips. People
  // Booked used to share this lane too (unscoped, via "All"), retired with its block
  // (§64) along with that scope.
  assert.equal(kpiLaneFor("Engineering"), "punches");
  assert.equal(kpiLaneFor("Shop"), "punches");
  assert.equal(kpiLaneFor("Parts"), "parts");
  assert.equal(kpiLaneFor("Unattributed"), "undefinedHours");
  assert.equal(kpiLaneFor("OffGrid"), null, "off-grid rows arrive with the page");
});

test("only the open block reports loading, so a slow KPI blocks nothing", () => {
  // §37.13 #11. The Parts detail is a TotalETO round trip; while it runs, the other four
  // blocks must keep showing their confirmed values with no spinner and no placeholder.
  const busy = lanes({ parts: { loading: true, error: null, loaded: false } });
  assert.equal(kpiDetailState("Parts", "Parts", busy), "loading");
  for (const other of ["Engineering", "Shop", "Unattributed", "OffGrid"] as DrillScope[]) {
    assert.equal(kpiDetailState(other, "Parts", busy), "idle", `${other} showed a state for the parts fetch`);
  }
});

test("a failed KPI is named, and only that one", () => {
  const broken = lanes({ undefinedHours: { loading: false, error: "Could not read the hours export.", loaded: false } });
  assert.equal(kpiDetailState("Unattributed", "Unattributed", broken), "error");
  assert.equal(kpiDetailState("Engineering", "Unattributed", broken), "idle");
  // …and a block whose drill is closed never reports its lane's error, because nothing
  // was being fetched for it.
  assert.equal(kpiDetailState("Unattributed", null, broken), "idle");
});

test("a background refresh of already-loaded detail keeps the value visible", () => {
  // §37.9: "keep confirmed values visible during a background update". Cached data plus
  // an in-flight request is not a loading state — the panel has something to show.
  const refreshing = lanes({ punches: { loading: true, error: null, loaded: true } });
  assert.equal(kpiDetailState("Engineering", "Engineering", refreshing), "idle");
  const first = lanes({ punches: { loading: true, error: null, loaded: false } });
  assert.equal(kpiDetailState("Engineering", "Engineering", first), "loading");
});

test("an error outranks a loading flag", () => {
  // A retry in flight must not hide the failure that prompted it.
  const both = lanes({ parts: { loading: true, error: "TotalETO timed out", loaded: false } });
  assert.equal(kpiDetailState("Parts", "Parts", both), "error");
});

test("a block with no drill never reports a fetch state", () => {
  assert.equal(kpiDetailState(null, "Parts", lanes({ parts: { loading: true, error: "x", loaded: false } })), "idle");
  // Off-grid has a drill but no fetch, so it cannot load or fail.
  assert.equal(kpiDetailState("OffGrid", "OffGrid", lanes({ punches: { loading: true, error: "x", loaded: false } })), "idle");
});

// ── 8. Layout (§37.7, §37.8, §37.13 #14) ───────────────────────────────────

test("the blocks fill one row when they fit and wrap when they do not", () => {
  // §41.13, in the only form a unit test can check: the layout is auto-fit on a measured
  // per-block minimum, so a row holds as many blocks as fit at a readable width and wraps
  // the rest. No horizontal scrolling, and nothing removed at any width.
  // Changed 2026-08-05, by request: six blocks across became one block per ROW. That old
  // shape forced every compromise inside MetricBlock — at six across on a 1280px screen
  // each block got ~169px, so the value and its status could not share a line, the label
  // needed truncating, and three reserved min-heights existed purely to stop the card
  // resizing as figures changed. Stacked, the values right-align WITH EACH OTHER down the
  // card, which six columns cannot do.
  assert.match(KPI_GRID_CLASS, /grid-cols-1/, `one column; got: ${KPI_GRID_CLASS}`);
  assert.ok(!/auto-fit|auto-fill/.test(KPI_GRID_CLASS), "a stacked card must not re-flow into columns");
  // NO viewport breakpoints. They were the §41.13 defect: `xl` is a 1280px VIEWPORT, but
  // this card is inset by the sidebar, so a 1440px laptop gave it ~1089px and it fell
  // back to two rows on exactly the desktop width the requirement is about. The card's
  // own width is the only thing that can decide whether six values fit.
  assert.ok(!/(sm|md|lg|xl|2xl):/.test(KPI_GRID_CLASS), "must not depend on viewport breakpoints");
  // No fixed column count either: the block count varies with the off-grid block, so a
  // hardcoded 6 wraps the seventh and a hardcoded 7 leaves a gap every normal month.
});

test("the per-block minimum is the measured one, not a round number", () => {
  // Measured on the real card by forcing N-across and checking every text node for
  // overflow: nothing clips at 180px; at 154px "24 eng · 21 shop" and "5 jobs not listed"
  // both do. Anything at or above ~175 is safe, and 1fr lets blocks grow past it so a row
  // is exactly filled and every block in it is equal width.
  // Retired with the parallel layout: a stacked row takes the card's full width, so
  // there is no per-block minimum left to protect. The measurement it recorded (nothing
  // clips at 180px; "24 eng · 21 shop" and "5 jobs not listed" both clip at 154px) is
  // kept here because it is the evidence for why the columns were abandoned.
  assert.ok(true);
});

test("the dividers are gaps, not per-block borders", () => {
  // §37.7: one outer border, no nested card borders. gap-px over an opaque container is
  // what draws the section boundaries — and unlike a left border on each block, it does
  // not leave a stray line at the start of every wrapped row.
  assert.match(KPI_GRID_CLASS, /gap-px/);
});

// ── 9. Hide summary (§37.6, §37.13 #12, #13) ───────────────────────────────
//
// The control now hides ONE card rather than a grid of six, and its preference module is
// unchanged — which is the point: hiding is a display preference and must not be
// entangled with the card's data. These pin that it stays that way.

type FakeWindow = {
  localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  dispatchEvent(e: Event): boolean;
};

function withFakeWindow(run: (store: Map<string, string>) => void) {
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  const fake: FakeWindow = {
    localStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v);
      },
    },
    addEventListener: (type, cb) => {
      const set = listeners.get(type) ?? new Set();
      set.add(cb);
      listeners.set(type, set);
    },
    removeEventListener: (type, cb) => listeners.get(type)?.delete(cb),
    dispatchEvent: (e) => {
      for (const cb of listeners.get(e.type) ?? []) cb();
      return true;
    },
  };
  const g = globalThis as unknown as { window?: FakeWindow };
  const prev = g.window;
  g.window = fake;
  try {
    run(store);
  } finally {
    if (prev === undefined) delete g.window;
    else g.window = prev;
  }
}

test("the summary starts visible on a browser that has never hidden it", () => {
  // A summary that hides itself on first visit is a summary nobody discovers.
  withFakeWindow(() => assert.equal(readKpiStripOpen(), true));
});

test("hiding and showing the card round-trips, and is remembered", () => {
  withFakeWindow(() => {
    writeKpiStripOpen(false);
    assert.equal(readKpiStripOpen(), false, "§37.13 #12 — Hide Summary hides the whole card");
    writeKpiStripOpen(true);
    assert.equal(readKpiStripOpen(), true, "§37.13 #13 — Show Summary brings it straight back");
  });
});

test("hiding the card stores a preference and nothing else", () => {
  // §37.6: "preserve its state and data. Do not destroy or reload the card data." The
  // preference module touching exactly one key is the structural version of that — the
  // figures live in the page's props and the drill caches in component state, neither of
  // which this can reach.
  withFakeWindow((store) => {
    writeKpiStripOpen(false);
    assert.deepEqual([...store.keys()], ["etc-kpi-strip-open"]);
  });
});

test("toggling notifies the open page, so the card reappears without a reload", () => {
  withFakeWindow(() => {
    let notified = 0;
    const unsubscribe = subscribeKpiStrip(() => notified++);
    writeKpiStripOpen(false);
    writeKpiStripOpen(true);
    assert.equal(notified, 2);
    unsubscribe();
    writeKpiStripOpen(false);
    assert.equal(notified, 2, "an unmounted page must not keep being notified");
  });
});

// ── The summary toggle is an icon button, not a text link (2026-09-02) ──────
//
// It was the words "Hide summary" in the app's muted label size with a dotted
// underline — 10px of grey beside a month title in the same 10px grey, which read as
// caption text rather than as the one pressable thing in that header. Replaced by a
// chevron button. Source-level assertions: this is a `"use client"` component and
// this suite has no DOM, so what is pinned is the contract an icon control has to
// meet to be findable and usable at all.

const KPI_CARDS = readFileSync(
  join(import.meta.dirname, "..", "src", "components", "EtcMonthKpiCards.tsx"),
  "utf8",
);
const KPI_CODE = KPI_CARDS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the text control is gone and both toggles are the same icon button", () => {
  // Comments stripped: the note explaining what this replaced quotes the old wording,
  // and a guard that trips on its own documentation is a guard someone deletes.
  assert.ok(
    !/>\s*\{?\s*stripOpen \? "Hide summary"/.test(KPI_CODE),
    "the text link must not come back",
  );
  // Collapsed and expanded were two separately styled controls. One component now, so
  // they cannot drift apart in size, glyph or label.
  assert.equal((KPI_CODE.match(/<SummaryToggle\b/g) ?? []).length, 2);
  assert.match(KPI_CODE, /function SummaryToggle\(/);
});

test("the accessible name states the action and changes with state", () => {
  // "summary" alone would tell a screen-reader user what the thing IS, not what
  // pressing it does — and would say the same in both states.
  assert.match(KPI_CODE, /const label = open \? "Hide summary" : "Show summary";/);
  assert.match(KPI_CODE, /aria-label=\{label\}/, "a name, for assistive tech");
  assert.match(KPI_CODE, /title=\{label\}/, "a hover tooltip, for everyone else");
  assert.match(KPI_CODE, /aria-expanded=\{open\}/);
});

test("it is a real button, so the keyboard works without reimplementing it", () => {
  // Enter/Space, focus order and the focus ring all come free from <button>; a div
  // with an onClick would need all three hand-rolled, and typically gets two.
  const toggle = KPI_CODE.slice(KPI_CODE.indexOf("function SummaryToggle("));
  assert.match(toggle.slice(0, 900), /<button\s/, "must be a button element");
  assert.match(toggle.slice(0, 900), /type="button"/, "never a form submit");
});

test("the chevron rotates rather than swapping glyph, like every other caret here", () => {
  // drill-design.test.ts already pins this rule for the drill caret, and
  // SortableHeader follows it. A second chevron drawn a second way is one more thing
  // to keep in step.
  const toggle = KPI_CODE.slice(KPI_CODE.indexOf("function SummaryToggle("));
  assert.equal((toggle.slice(0, 1400).match(/<path /g) ?? []).length, 1, "one path, not two glyphs");
  assert.match(toggle, /M4 9 L8 5 L12 9/, "the app's own chevron path");
  assert.match(toggle, /open \? "" : "rotate-180"/, "up when open, down when collapsed");
  assert.match(toggle, /aria-hidden/, "the glyph is decorative — the button carries the name");
});

test("the icon-only control still reads as pressable at rest", () => {
  // An icon with no border or hover state on a dense page is a mark, not a control.
  const toggle = KPI_CODE.slice(KPI_CODE.indexOf("function SummaryToggle("));
  assert.match(toggle, /border border-sdc-border/);
  assert.match(toggle, /hover:/);
});

test("the header aligns the toggle on centre, not on a baseline it does not have", () => {
  // An icon button has no text baseline, so `items-baseline` hung it below the month
  // title. Pinned because the class is invisible until someone looks at the header.
  const header = KPI_CODE.slice(KPI_CODE.indexOf("{monthTitle}") - 400, KPI_CODE.indexOf("{monthTitle}"));
  assert.match(header, /items-center/);
  assert.ok(!/items-baseline/.test(header));
});
