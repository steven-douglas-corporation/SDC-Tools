import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchTransfers, reviewUnmatched, type PullRow } from "../src/lib/parts-transfer-netting";

const P = (id: number, jobId: number, itemId: number, qty: number, cost: number, day: string, poLinked = false): PullRow => ({
  id, jobId, itemId, qty, cost, day, poLinked,
});

const review = (rows: PullRow[]) => reviewUnmatched(matchTransfers(rows).unmatched);

test("a clean transfer is matched, so there is nothing to review", () => {
  const r = review([P(1, 1155, 5, -2, -50, "2026-08-24"), P(2, 1160, 5, 2, 50, "2026-08-24")]);
  assert.equal(r.possible.length, 0);
  assert.equal(r.ordinary.length, 0);
});

test("quantities that differ are flagged on both halves, with the quantities named", () => {
  const r = review([P(1, 1155, 5, -8, -80, "2026-08-24"), P(2, 1160, 5, 5, 50, "2026-08-24")]);
  assert.equal(r.possible.length, 2);
  for (const p of r.possible) assert.match(p.reasons.join(), /quantity differs \(8 left, 5 arrived\)/);
  assert.deepEqual(r.possible.find((p) => p.pull.id === 1)!.counterparts.map((c) => c.id), [2]);
});

test("halves booked more than 14 days apart are flagged with the gap", () => {
  const r = review([P(1, 1155, 5, -2, -50, "2026-08-01"), P(2, 1160, 5, 2, 50, "2026-08-31")]);
  assert.match(r.possible[0].reasons.join(), /booked 30 days apart \(limit 14\)/);
});

test("an arriving pull on a PO is flagged, not silently ignored", () => {
  const r = review([P(1, 1155, 5, -2, -50, "2026-08-24"), P(2, 1160, 5, 2, 50, "2026-08-24", true)]);
  assert.match(r.possible[0].reasons.join(), /linked to a PO/);
});

test("costs too far apart are flagged with both amounts", () => {
  const r = review([P(1, 1155, 5, -2, -50, "2026-08-24"), P(2, 1160, 5, 2, 500, "2026-08-24")]);
  assert.match(r.possible[0].reasons.join(), /costs too far apart \(\$50\.00 left, \$500\.00 arrived\)/);
});

test("a pull with no counterpart on another job is ordinary stock movement, not review", () => {
  const r = review([
    P(1, 1155, 5, -2, -50, "2026-08-24"),
    P(2, 1155, 5, 2, 50, "2026-08-25"), // same job: a return, not a transfer
    P(3, 1160, 6, 3, 30, "2026-08-24"), // different item
    P(4, 1170, 5, 1, 25, "2026-12-30"), // beyond the review window
  ]);
  assert.equal(r.possible.length, 0);
  assert.equal(r.ordinary.length, 4);
});

test("pulls before the netting cutoff are never listed", () => {
  const r = review([P(1, 1155, 5, -8, -80, "2026-07-01"), P(2, 1160, 5, 5, 50, "2026-07-01")]);
  assert.equal(r.possible.length + r.ordinary.length, 0);
});

test("possible transfers come newest first, counterparts nearest first", () => {
  const r = review([
    P(1, 1155, 5, -8, -80, "2026-08-10"),
    P(2, 1160, 5, 5, 50, "2026-08-30"),
    P(3, 1170, 5, 3, 30, "2026-08-12"),
  ]);
  assert.deepEqual(r.possible.map((p) => p.pull.id), [2, 3, 1]);
  assert.deepEqual(r.possible.find((p) => p.pull.id === 1)!.counterparts.map((c) => c.id), [3, 2]);
});

test("the review reads the same pulls as the netting and writes nothing", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "lib", "sync-totaleto.ts"), "utf8");
  const start = src.indexOf("export async function getTransferReview");
  const body = src.slice(start, src.indexOf("\nexport ", start + 1) === -1 ? undefined : src.indexOf("\nexport ", start + 1));
  assert.match(body, /await loadPulls\(\)/);
  assert.match(body, /matchTransfers\(pulls\)/);
  assert.doesNotMatch(body, /\b(INSERT|UPDATE|DELETE|MERGE)\b|prisma\./);
  assert.match(src, /return matchTransfers\(await loadPulls\(\), \{ asOf \}\)\.transfers;/, "loadTransfers uses the same read");
});
