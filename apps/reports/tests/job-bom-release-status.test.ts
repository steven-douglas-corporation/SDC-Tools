import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type BomContext,
  type BomRow,
  type PullInfo,
  buildAssembly,
  buildSpecTree,
  explodes,
  getRequirementRows,
  isRequirement,
  isUncoveredPart,
  makePart,
  releaseOf,
  sourceFor,
  statsForRoots,
  statusFor,
  unitPriceFor,
} from "../src/lib/job-bom-rules";

// ── Procurement BOM: release status, coverage and costing ─────────────────────
//
// The rules module is pure by design (job-bom.ts owns all the SQL), so these are
// real behavioural tests over synthetic Total ETO rows rather than source-shape
// assertions like the other JobProcurement tests.
//
// The fixture is job 1116's actual spec-10 shape, cut down to the branch Pat used
// as the example. Real ItemIDs/part numbers/prices from tblEngProductStructure +
// tblEngItemMaster, so a figure asserted here is a figure Purchasing can look up:
//
//   TOP 1116-10
//     └─ 1116-D-000  S01: FLEX FEEDER ASSY.        release 1 (Contents of Assembly Only)
//          ├─ 1116-DA-000  ROBOT ASSY.             release 1  → exploded
//          │    └─ 1116-DAE-000 CALIBRATION TOOL   release 1  → exploded
//          │         ├─ 1116-DAE-001 PIN           leaf, no PO, no coverage → uncovered
//          │         └─ 1116-DAE-002 TEACH PIN PL. leaf, no PO, no coverage → uncovered
//          ├─ 1116-DB-000  LEFT PICK CONVEYOR      release 2 (Assembly Only), LastCost 1430
//          │    ├─ 089-D-001    CONVEYOR FOOT      ← must NOT be a requirement
//          │    ├─ 1116-DBA-000 DRIVE ASSY (assy)  ← must NOT be a requirement
//          │    └─ 995-DA-015-1 EXIT RAIL 1        ← must NOT be a requirement
//          └─ 1116-D-006   FUNNEL BRACKET          leaf, PO 101590 @ $33.85, received
//
// The reference report (SDC Standard Project BOM — "Structured BOM - Readiness
// Summary", page 3 of 26 for job 1116) prints 1116-DB-000 as ONE line at $1,430
// on PO 101563 and prints none of its three subcomponents. That is the property
// the first four tests pin down.

let nextId = 1;
const ids: Record<string, number> = {};
const id = (pn: string) => (ids[pn] ??= nextId++);

type RowOverrides = Partial<BomRow>;

function row(parentPN: string, childPN: string, o: RowOverrides = {}): BomRow {
  return {
    ChildID: id(childPN),
    ChildPN: childPN,
    ChildDesc: childPN,
    Manufacturer: "SDC",
    ParentID: id(parentPN),
    ParentPN: parentPN,
    ParentDesc: parentPN,
    ItemQty: 1,
    SpecID: 10,
    RequiredDate: null,
    ItemHold: null,
    BOMAssemblyReleaseID: null,
    ItemCost: null,
    ItemLastCost: null,
    ItemListCost: null,
    POQty: 0,
    ReceivedQty: 0,
    UnitPrice: 0,
    LastReceivedDate: null,
    BOMCustom1: null,
    Note: null,
    ...o,
  };
}

const CONTENTS_ONLY = 1;
const ASSEMBLY_ONLY = 2;
const BOTH = 3;

const FIXTURE: BomRow[] = [
  row("TOP", "1116-D-000", { BOMAssemblyReleaseID: CONTENTS_ONLY }),
  row("1116-D-000", "1116-DA-000", { BOMAssemblyReleaseID: CONTENTS_ONLY }),
  row("1116-DA-000", "1116-DAE-000", { BOMAssemblyReleaseID: CONTENTS_ONLY }),
  row("1116-DAE-000", "1116-DAE-001"),
  row("1116-DAE-000", "1116-DAE-002"),
  // Assembly Only: bought whole for $1,430 on PO 101563, fully received.
  row("1116-D-000", "1116-DB-000", {
    BOMAssemblyReleaseID: ASSEMBLY_ONLY,
    ItemLastCost: 1430,
    POQty: 1,
    ReceivedQty: 1,
    UnitPrice: 1430,
  }),
  row("1116-DB-000", "089-D-001", { ItemQty: 4, ItemLastCost: 16.5 }),
  row("1116-DB-000", "1116-DBA-000", { BOMAssemblyReleaseID: ASSEMBLY_ONLY }),
  row("1116-DBA-000", "1116-DBA-001", { ItemLastCost: 99 }),
  row("1116-DB-000", "995-DA-015-1"),
  row("1116-D-000", "1116-D-006", { POQty: 1, ReceivedQty: 1, UnitPrice: 33.85 }),
];

const emptyCtx = (): BomContext => ({ poIndex: new Map(), pulls: new Map(), processItems: new Set() });

const tree = () => buildSpecTree(FIXTURE);

const pnsOf = (rows: BomRow[]) => rows.map((r) => r.ChildPN).sort();

// ── Rule 1: BOM release status decides what gets exploded ─────────────────────

test("NULL release status defaults to Contents of Assembly Only", () => {
  // Every one of job 1116's 934 NULLs is a leaf edge, where the field is
  // meaningless — and a project that never sets the field must keep behaving
  // exactly as this module did before release status was read at all.
  assert.equal(releaseOf({ BOMAssemblyReleaseID: null }), "contentsOnly");
  assert.equal(releaseOf({ BOMAssemblyReleaseID: 0 }), "contentsOnly");
  assert.equal(releaseOf({ BOMAssemblyReleaseID: 1 }), "contentsOnly");
  assert.equal(releaseOf({ BOMAssemblyReleaseID: 2 }), "assemblyOnly");
  assert.equal(releaseOf({ BOMAssemblyReleaseID: 3 }), "bothAssemblyAndContents");
});

test("an Assembly Only parent is a requirement and its contents are not", () => {
  const t = tree();
  const dbEdge = FIXTURE.find((r) => r.ChildPN === "1116-DB-000")!;
  // The parent itself: bought, never exploded.
  assert.equal(isRequirement(dbEdge, t), true, "1116-DB-000 is the thing being bought");
  assert.equal(explodes(dbEdge, t), false, "1116-DB-000 must not be exploded");

  // Nothing beneath it reaches the requirement list — this is the exact defect:
  // 089-D-001 / 1116-DBA-000 / 995-DA-015-1 used to be counted and priced on
  // top of the $1,430 parent.
  const reqs = pnsOf(getRequirementRows(id("1116-D-000"), t, new Set()));
  assert.ok(reqs.includes("1116-DB-000"));
  for (const excluded of ["089-D-001", "1116-DBA-000", "1116-DBA-001", "995-DA-015-1"]) {
    assert.ok(!reqs.includes(excluded), `${excluded} is inside an Assembly Only purchase and must not be a separate requirement`);
  }
});

test("Contents of Assembly Only explodes and the parent is not a requirement", () => {
  const t = tree();
  const daEdge = FIXTURE.find((r) => r.ChildPN === "1116-DA-000")!;
  assert.equal(explodes(daEdge, t), true);
  assert.equal(isRequirement(daEdge, t), false, "a Contents-Only assembly is not itself bought");

  const reqs = pnsOf(getRequirementRows(id("1116-DA-000"), t, new Set()));
  assert.deepEqual(reqs, ["1116-DAE-001", "1116-DAE-002"], "only the leaves below it");
});

test("Both Assembly and Contents counts the assembly AND explodes it", () => {
  const rows = FIXTURE.map((r) =>
    r.ChildPN === "1116-DB-000" ? { ...r, BOMAssemblyReleaseID: BOTH } : r,
  );
  const t = buildSpecTree(rows);
  const dbEdge = rows.find((r) => r.ChildPN === "1116-DB-000")!;
  assert.equal(isRequirement(dbEdge, t), true);
  assert.equal(explodes(dbEdge, t), true);

  const reqs = pnsOf(getRequirementRows(id("1116-D-000"), t, new Set()));
  assert.ok(reqs.includes("1116-DB-000"), "the assembly itself");
  assert.ok(reqs.includes("089-D-001"), "and its contents");
  // 1116-DBA-000 is still Assembly Only in its own right, so its own child stays out.
  assert.ok(reqs.includes("1116-DBA-000"));
  assert.ok(!reqs.includes("1116-DBA-001"), "release status is per edge, so the nested Assembly Only still holds");
});

test("the assembly's own buy line lands on the node for Both, and nowhere for Contents Only", () => {
  const t = tree();
  const ctx = emptyCtx();
  const contentsOnly = buildAssembly(id("1116-DA-000"), "1116-DA-000", "ROBOT ASSY.", "k", t, ctx, new Set(), FIXTURE[1]);
  assert.equal(contentsOnly.self, null, "a Contents-Only assembly is not a purchase");

  const rows = FIXTURE.map((r) => (r.ChildPN === "1116-DA-000" ? { ...r, BOMAssemblyReleaseID: BOTH } : r));
  const t2 = buildSpecTree(rows);
  const both = buildAssembly(id("1116-DA-000"), "1116-DA-000", "ROBOT ASSY.", "k", t2, ctx, new Set(), rows[1]);
  assert.ok(both.self, "a Both assembly carries its own buy line");
  assert.equal(both.self?.pn, "1116-DA-000");
  assert.equal(both.self?.isAssembly, true);
  // …and it is counted in the node's own readiness, not silently left out of it.
  assert.equal(both.stats.total, contentsOnly.stats.total + 1);
});

test("an Assembly Only parent appears as one part row, with no children", () => {
  const t = tree();
  const node = buildAssembly(id("1116-D-000"), "1116-D-000", "FLEX FEEDER", "k", t, emptyCtx(), new Set(), FIXTURE[0]);
  const partPns = node.parts.map((p) => p.pn).sort();
  assert.deepEqual(partPns, ["1116-D-006", "1116-DB-000"], "the leaf and the bought-whole assembly");
  assert.deepEqual(node.children.map((c) => c.pn), ["1116-DA-000"], "1116-DB-000 must not be a child node");
  const db = node.parts.find((p) => p.pn === "1116-DB-000")!;
  assert.equal(db.isAssembly, true, "flagged so the UI can say why it has no contents");
  assert.equal(db.release, "assemblyOnly");
});

// ── Rule 1, in money and in readiness ────────────────────────────────────────

test("Assembly Only stops the double-count in material cost", () => {
  const t = tree();
  const node = buildAssembly(id("1116-D-000"), "1116-D-000", "FLEX FEEDER", "k", t, emptyCtx(), new Set(), FIXTURE[0]);
  // $1,430 (the conveyor, bought whole) + $33.85 (the funnel bracket). NOT the
  // conveyor's own subcomponents on top: 4 × $16.50 of CONVEYOR FOOT and $99 of
  // drive-assembly part would have added $165 of cost the job never pays.
  assert.equal(Math.round(node.totalCost * 100) / 100, 1463.85);
});

test("readiness counts the bought assembly once, not its subcomponents", () => {
  const t = tree();
  const stats = statsForRoots([id("1116-D-000")], t, emptyCtx());
  // 1116-DB-000, 1116-D-006, 1116-DAE-001, 1116-DAE-002 — four requirements.
  assert.equal(stats.total, 4);
  assert.equal(stats.received, 2, "the conveyor and the bracket are in hand");
  assert.equal(stats.noPO, 2, "the two SDC-made calibration parts are genuinely uncovered");
  assert.equal(stats.pct, 50);
});

// ── Rule 2: no PO is not the same as missing ─────────────────────────────────

const pull = (o: Partial<PullInfo> = {}): PullInfo => ({
  pullQty: 1,
  fulfilledQty: 1,
  pullPrice: 0,
  fulfilledDate: null,
  ...o,
});

test("a part with no PO is still uncovered when nothing else covers it", () => {
  const r = row("A", "B");
  const t = buildSpecTree([r]);
  assert.equal(sourceFor(r, emptyCtx()), "none");
  assert.equal(statusFor(r, emptyCtx()), "noPO");
  assert.equal(statsForRoots([id("A")], t, emptyCtx()).noPO, 1);
});

test("a part issued from inventory is received, not missing", () => {
  const r = row("A", "PULLED", { ItemQty: 3 });
  const ctx = emptyCtx();
  ctx.pulls.set(r.ChildID, pull({ pullQty: 3, fulfilledQty: 3 }));
  assert.equal(sourceFor(r, ctx), "stock");
  assert.equal(statusFor(r, ctx), "received", "stock in hand is in hand");
});

test("a part pulled but not yet issued is committed, not missing", () => {
  const r = row("A", "PULLING", { ItemQty: 3 });
  const ctx = emptyCtx();
  ctx.pulls.set(r.ChildID, pull({ pullQty: 3, fulfilledQty: 0 }));
  assert.equal(statusFor(r, ctx), "ordered");
});

test("a part built in-house on a process schedule is not missing", () => {
  const r = row("A", "MADE");
  const ctx = emptyCtx();
  ctx.processItems.add(r.ChildID);
  assert.equal(sourceFor(r, ctx), "process");
  assert.equal(statusFor(r, ctx), "ordered");
});

test("PO receipts and inventory issues add up for partly-stocked parts", () => {
  // 4 needed, 1 received against a PO, 3 pulled off the shelf → complete. Under
  // the old PO-only rule this sat at 1/4 forever.
  const r = row("A", "MIXED", { ItemQty: 4, POQty: 1, ReceivedQty: 1 });
  const ctx = emptyCtx();
  ctx.pulls.set(r.ChildID, pull({ pullQty: 3, fulfilledQty: 3 }));
  assert.equal(statusFor(r, ctx), "received");
  assert.equal(sourceFor(r, ctx), "po", "a real PO still names the source");
});

test("last cost alone never satisfies a requirement", () => {
  // The trap this guards: 61 of job 1116's no-PO parts carry an ItemLastCost, and
  // treating a price as coverage would have marked all of them ready — including
  // 1116-DAE-001/002, which the reference report shows as 0% red.
  const r = row("A", "PRICED-BUT-ABSENT", { ItemLastCost: 260 });
  assert.equal(statusFor(r, emptyCtx()), "noPO");
  assert.equal(sourceFor(r, emptyCtx()), "none");
});

// ── Rule 3: cost falls back through LPP ──────────────────────────────────────

test("unit price prefers a committed PO price over every estimate", () => {
  const r = row("A", "B", { UnitPrice: 10, ItemCost: 20, ItemLastCost: 30, ItemListCost: 40 });
  const ctx = emptyCtx();
  ctx.pulls.set(r.ChildID, pull({ pullPrice: 25 }));
  assert.deepEqual(unitPriceFor(r, ctx), { price: 10, basis: "po" });
});

test("unit price falls back pull → BOM line → last cost → list cost", () => {
  const base = { UnitPrice: 0 } as const;
  const ctx = emptyCtx();
  const withPull = row("A", "P1", base);
  ctx.pulls.set(withPull.ChildID, pull({ pullPrice: 25 }));
  assert.deepEqual(unitPriceFor(withPull, ctx), { price: 25, basis: "pull" });

  assert.deepEqual(unitPriceFor(row("A", "P2", { ...base, ItemCost: 20, ItemLastCost: 30 }), emptyCtx()), { price: 20, basis: "bom" });
  assert.deepEqual(unitPriceFor(row("A", "P3", { ...base, ItemLastCost: 30, ItemListCost: 40 }), emptyCtx()), { price: 30, basis: "lastCost" });
  assert.deepEqual(unitPriceFor(row("A", "P4", { ...base, ItemListCost: 40 }), emptyCtx()), { price: 40, basis: "listCost" });
  assert.deepEqual(unitPriceFor(row("A", "P5", base), emptyCtx()), { price: 0, basis: "none" });
});

test("an inventory-pulled part with no PO is priced, not free", () => {
  // The other half of the old understatement: every stock/in-house part priced at
  // $0 because the job had no PO line for it.
  const r = row("A", "STOCKED", { ItemQty: 2, ItemLastCost: 55 });
  const t = buildSpecTree([r]);
  const ctx = emptyCtx();
  ctx.pulls.set(r.ChildID, pull({ pullQty: 2, fulfilledQty: 2, pullPrice: 50 }));
  const node = buildAssembly(id("A"), "A", "A", "k", t, ctx, new Set(), null);
  assert.equal(node.totalCost, 100, "2 × the $50 inventory pull price");
  assert.equal(node.parts[0].costBasis, "pull");
});

// ── isUncoveredPart: the one "needs a PO" rule, reused by every Procurement view ──
//
// The "No Purchase Order" risk card in JobProcurement.tsx used to re-derive
// coverage from a raw `!poNumber` check, which counts stock/process-covered
// parts as missing (they legitimately have no PO) and inflated its count well
// past the Parts List's own "Uncovered (no PO)" filter, which already used
// statusFor's "noPO". These tests pin down the rule both now call, so a
// future card can't quietly re-diverge from it the same way.

test("isUncoveredPart: genuinely uncovered and not on hold is true", () => {
  const r = row("A", "B");
  const part = makePart(r, buildSpecTree([r]), emptyCtx());
  assert.equal(part.status, "noPO");
  assert.equal(isUncoveredPart(part), true);
});

test("isUncoveredPart: covered by a committed stock pull is false, even with no PO", () => {
  const r = row("A", "PULLING", { ItemQty: 3 });
  const ctx = emptyCtx();
  ctx.pulls.set(r.ChildID, pull({ pullQty: 3, fulfilledQty: 0 }));
  const part = makePart(r, buildSpecTree([r]), ctx);
  assert.equal(part.status, "ordered", "committed to stock, not received yet");
  assert.equal(isUncoveredPart(part), false);
});

test("isUncoveredPart: built in-house on a process schedule is false", () => {
  const r = row("A", "MADE");
  const ctx = emptyCtx();
  ctx.processItems.add(r.ChildID);
  const part = makePart(r, buildSpecTree([r]), ctx);
  assert.equal(isUncoveredPart(part), false);
});

test("isUncoveredPart: fully received is false", () => {
  const r = row("A", "B", { POQty: 1, ReceivedQty: 1, UnitPrice: 10 });
  const part = makePart(r, buildSpecTree([r]), emptyCtx());
  assert.equal(part.status, "received");
  assert.equal(isUncoveredPart(part), false);
});

test("isUncoveredPart: genuinely uncovered but on hold is false — hold gets its own bucket", () => {
  const r = row("A", "B", { ItemHold: true });
  const part = makePart(r, buildSpecTree([r]), emptyCtx());
  assert.equal(part.status, "noPO");
  assert.equal(part.hold, true);
  assert.equal(isUncoveredPart(part), false);
});

test("isUncoveredPart: last cost alone still does not cover a part", () => {
  // Mirrors "last cost alone never satisfies a requirement" above — a price on
  // the item master must not make isUncoveredPart say a part is covered.
  const r = row("A", "PRICED-BUT-ABSENT", { ItemLastCost: 260 });
  const part = makePart(r, buildSpecTree([r]), emptyCtx());
  assert.equal(isUncoveredPart(part), true);
});

// ── Universality ─────────────────────────────────────────────────────────────

test("nothing keys off a project number", () => {
  // The rules are structural: the same fixture with different part numbers and a
  // different top must behave identically. Job 1116 is the example, never the rule.
  const renamed = FIXTURE.map((r) => ({
    ...r,
    ChildPN: r.ChildPN?.replace("1116", "2200") ?? null,
    ParentPN: r.ParentPN?.replace("1116", "2200") ?? null,
  }));
  const t = buildSpecTree(renamed);
  const stats = statsForRoots([id("1116-D-000")], t, emptyCtx());
  assert.deepEqual(stats, statsForRoots([id("1116-D-000")], tree(), emptyCtx()));
});
