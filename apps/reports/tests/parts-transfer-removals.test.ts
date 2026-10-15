import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  matchTransfers,
  netTransfersByJob,
  summarizeTransfersForJobs,
  describeTransfers,
  jobLabel,
  NO_DESTINATION,
  type PullRow,
} from "../src/lib/parts-transfer-netting";
import { REMOVED_FROM_JOB_PULLS, REMOVED_PULLS } from "../src/lib/parts-transfer-removals";
import {
  indexMovedOut,
  isFullyMoved,
  buildTransferRows,
  hiddenMovedNote,
  transferFooterAdd,
} from "../src/lib/parts-list-transfer-rows";

// ── Pulls named as having taken a part out of a job for good (2026-10-14) ────
//
// Total ETO's material-cost report subtracts EVERY pull out of job 1155 (-$22,403.79). The pairing
// rule nets only matched transfers ($20,463.08) and never guesses, which left 10 pulls (-$1,941.14)
// on 1155: nine booked out on 2026-08-24 with the batch (job 1160 holds the same parts under its
// own part numbers, a different item in Total ETO, so no pull arrives under the same item) and one
// stock return on 2026-10-06. They are named by pull id; matchTransfers turns each into a removal.

const pull = (o: Partial<PullRow> & Pick<PullRow, "id" | "jobId" | "itemId" | "qty" | "cost" | "day">): PullRow => ({ poLinked: false, ...o });
const removed = (...ids: [number, number, number][]) => new Map(ids.map(([id, jobId, itemId]) => [id, { jobId, itemId }]));

test("a named pull that matched nothing comes off the job it left and goes onto no job", () => {
  const rows = [pull({ id: 4115, jobId: 1155, itemId: 2714, qty: -1, cost: -508, day: "2026-08-24" })];
  const { transfers, unmatched } = matchTransfers(rows, { removed: removed([4115, 1155, 2714]) });
  assert.equal(transfers.length, 1);
  assert.deepEqual(
    { from: transfers[0].fromJob, to: transfers[0].toJob, out: transfers[0].costOut, inn: transfers[0].costIn, pulls: transfers[0].negPullIds, arr: transfers[0].posPullIds },
    { from: "1155", to: NO_DESTINATION, out: 508, inn: 0, pulls: [4115], arr: [] },
  );
  assert.equal(unmatched.length, 0, "no longer waiting for review");
  const net = netTransfersByJob(transfers);
  assert.equal(net.get("1155"), -508);
  assert.equal(net.has(NO_DESTINATION), false, "never credited to a job called 'none'");
  assert.equal(net.size, 1);
});

test("an unnamed pull is left alone — the rule itself is unchanged", () => {
  const rows = [pull({ id: 5000, jobId: 1155, itemId: 2714, qty: -1, cost: -508, day: "2026-08-24" })];
  const { transfers, unmatched } = matchTransfers(rows, { removed: removed([4115, 1155, 2714]) });
  assert.equal(transfers.length, 0);
  assert.equal(unmatched.length, 1);
});

test("a stale entry can never move money: the pull must still belong to the job AND item it was listed under", () => {
  const rows = [pull({ id: 4115, jobId: 1155, itemId: 2714, qty: -1, cost: -508, day: "2026-08-24" })];
  assert.equal(matchTransfers(rows, { removed: removed([4115, 1160, 2714]) }).transfers.length, 0, "wrong job");
  assert.equal(matchTransfers(rows, { removed: removed([4115, 1155, 9999]) }).transfers.length, 0, "wrong item");
});

test("only pulls out of a job, on or after the cutoff, are removals", () => {
  const list = removed([1, 1155, 7], [2, 1155, 7]);
  assert.equal(matchTransfers([pull({ id: 1, jobId: 1155, itemId: 7, qty: -1, cost: -5, day: "2026-07-31" })], { removed: list }).transfers.length, 0, "before 2026-08-01");
  assert.equal(matchTransfers([pull({ id: 2, jobId: 1155, itemId: 7, qty: 1, cost: 5, day: "2026-08-24" })], { removed: list }).transfers.length, 0, "a positive pull is not a removal");
});

test("a pull that DID match a transfer is never counted twice", () => {
  const rows = [
    pull({ id: 4115, jobId: 1155, itemId: 2714, qty: -1, cost: -508, day: "2026-08-24" }),
    pull({ id: 9001, jobId: 1160, itemId: 2714, qty: 1, cost: 508, day: "2026-08-24" }),
  ];
  const { transfers } = matchTransfers(rows, { removed: removed([4115, 1155, 2714]) });
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].toJob, "1160", "the real transfer wins");
});

test("as-of mode keeps a removal only once it has happened", () => {
  const rows = [pull({ id: 4681, jobId: 1155, itemId: 2704, qty: -1, cost: -20, day: "2026-10-06" })];
  const list = removed([4681, 1155, 2704]);
  assert.equal(matchTransfers(rows, { removed: list, asOf: "2026-09-30" }).transfers.length, 0);
  assert.equal(matchTransfers(rows, { removed: list, asOf: "2026-10-06" }).transfers.length, 1);
});

test("the card names it as a removal, not as a job", () => {
  const rows = [
    pull({ id: 1, jobId: 1155, itemId: 5, qty: -1, cost: -100, day: "2026-08-24" }),
    pull({ id: 2, jobId: 1160, itemId: 5, qty: 1, cost: 100, day: "2026-08-24" }),
    pull({ id: 3, jobId: 1155, itemId: 6, qty: -1, cost: -40, day: "2026-08-24" }),
  ];
  const { transfers } = matchTransfers(rows, { removed: removed([3, 1155, 6]) });
  const s = summarizeTransfersForJobs(transfers, ["1155"]);
  assert.deepEqual(s.entries.map((e) => [e.otherJob, e.amount]), [["1160", -100], [NO_DESTINATION, -40]]);
  assert.equal(s.net, -140);
  assert.equal(describeTransfers(s.entries), "moved to job 1160 (−$100), removed, no matching arrival (−$40)");
  assert.equal(jobLabel("1160"), "job 1160");
  assert.equal(jobLabel(NO_DESTINATION), "no matching arrival");
  // 1160 is unaffected by a removal: nothing arrives anywhere.
  assert.equal(summarizeTransfersForJobs(transfers, ["1160"]).net, 100);
});

// ── It hides with the rest, and the footer still ties ────────────────────────

test("a removed part's row hides like any fully moved part, and its share rides on the residual TRANSFER row", () => {
  const rows = [
    pull({ id: 1, jobId: 1155, itemId: 5, qty: -1, cost: -100, day: "2026-08-24" }),
    pull({ id: 2, jobId: 1160, itemId: 5, qty: 1, cost: 100, day: "2026-08-24" }),
    pull({ id: 3, jobId: 1155, itemId: 6, qty: -1, cost: -508, day: "2026-08-24" }),
  ];
  const { transfers } = matchTransfers(rows, { removed: removed([3, 1155, 6]) });
  const items = transfers.map((t) => ({
    direction: "out" as const, otherJob: t.toJob, itemId: t.itemId, partNumber: null, description: null, qty: t.qty, amount: -t.costOut, day: t.day, pullIds: [...t.negPullIds, ...t.posPullIds],
  }));
  const moved = indexMovedOut(items);
  const topPlate = { id: 6, nonBom: false, matchReason: "matched", totalPrice: 508, invoicedAmount: 508, leftToSpend: 0 };
  assert.equal(isFullyMoved(topPlate, moved), true);
  assert.deepEqual([...moved.get(6)!.byJob.keys()], [NO_DESTINATION]);
  const entries = summarizeTransfersForJobs(transfers, ["1155"]).entries;
  const hidden = buildTransferRows(entries, { rows: [topPlate], moved });
  const removal = hidden.find((r) => r.otherJob === NO_DESTINATION)!;
  assert.equal(removal.total, 0, "the hidden row's $508 already left the footer");
  assert.equal(removal.hiddenParts, 1);
  assert.match(removal.description, /^Parts removed from the job — 1 item movement \(inventory pulls, no matching arrival\); 1 fully moved part is hidden above/);
  const off = transferFooterAdd(buildTransferRows(entries));
  const on = transferFooterAdd(hidden);
  assert.equal(Math.round((508 + off.total) * 100) / 100, Math.round((0 + on.total) * 100) / 100, "footer identical on or off");
});

test("the strip names removed parts too", () => {
  assert.equal(hiddenMovedNote(9, [NO_DESTINATION]), "9 parts removed with no matching arrival are hidden");
  assert.equal(hiddenMovedNote(120, ["1160", NO_DESTINATION]), "120 parts moved to job 1160 or removed with no matching arrival are hidden");
  assert.equal(hiddenMovedNote(111, ["1160"]), "111 parts moved to job 1160 are hidden");
});

// ── The list itself ──────────────────────────────────────────────────────────

test("the list is the 10 pulls on job 1155 that reconcile it to Total ETO's report, with no duplicates", () => {
  assert.equal(REMOVED_FROM_JOB_PULLS.length, 10);
  assert.equal(REMOVED_PULLS.size, 10, "every pull id appears once");
  assert.ok(REMOVED_FROM_JOB_PULLS.every((r) => r.jobId === 1155));
  assert.equal(new Set(REMOVED_FROM_JOB_PULLS.map((r) => r.itemId)).size, 10);
  assert.ok(REMOVED_FROM_JOB_PULLS.every((r) => r.note.length > 20), "each says why it is listed");
});

test("the netting and the card read their pulls through the one loadPulls", () => {
  const sync = readFileSync(join(import.meta.dirname, "..", "src", "lib", "sync-totaleto.ts"), "utf8");
  assert.match(sync, /return matchTransfers\(await loadPulls\(\), \{ asOf \}\)\.transfers;/, "loadTransfers uses the one read");
  assert.equal((sync.match(/await loadPulls\(\)/g) ?? []).length, 1, "nothing else reads pulls separately");
});

test("matchTransfers reads the list by default, and nothing else passes ids in", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "lib", "parts-transfer-netting.ts"), "utf8");
  assert.match(src, /const removed = opts\.removed \?\? REMOVED_PULLS;/);
  const sync = readFileSync(join(import.meta.dirname, "..", "src", "lib", "sync-totaleto.ts"), "utf8");
  assert.doesNotMatch(sync, /REMOVED_PULLS|REMOVED_FROM_JOB_PULLS/, "both callers get the same answer because the default applies to both");
});
