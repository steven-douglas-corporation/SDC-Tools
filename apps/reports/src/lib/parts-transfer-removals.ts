// ── Pulls that took parts OUT of a job with no matching arrival (2026-10-14) ──
//
// parts-transfer-netting.ts nets a transfer only when it can pair the leaving pull with an
// arriving one — same item, same quantity, another job — and it never guesses. That is the right
// default: across the database a negative pull is usually an ordinary stock return, and netting
// every one would move about a hundred jobs.
//
// But Total ETO's own material-cost report does subtract EVERY pull out of a job. For job 1155 that
// is -$22,403.79; the matched transfers account for $20,463.08 of it, and 10 pulls (-$1,941.14)
// are left over: nine parts booked out on 2026-08-24 with the 126 matched movements, and one stock
// return on 2026-10-06. Nothing arrived anywhere under the same item — job 1160 carries the same
// parts under its own new part numbers (098-B-005 TOP PLATE -> 1160-B-005, and so on), which is a
// different item in Total ETO and cannot be paired.
//
// So the app showed ~$1.9K more on 1155 than the report. Rather than loosen the rule for every job,
// those pulls are NAMED here, each by its Total ETO pull id with the job and item it must still
// belong to. matchTransfers turns each into a removal: it comes off the job it left, goes onto no
// job, and the row of that part hides with the other fully moved ones. A pull whose job or item no
// longer matches is ignored, so a stale entry can never move money.
//
// To add one: find the pull in tblInventoryPullDetails (the transfer review lists unmatched pulls
// with their ids), confirm it really left the job for good, and add a line. Nothing else changes.

export type RemovedPull = {
  /** tblInventoryPullDetails.PullDetailID */
  pullId: number;
  /** The job it left. */
  jobId: number;
  /** Total ETO item id (tblEngItemMaster.ItemID). */
  itemId: number;
  /** Why it is listed — for whoever reads this later. */
  note: string;
};

const BATCH_1155 = "Booked out of 1155 on 2026-08-24 with the 1155 -> 1160 batch; no arrival under the same item (1160 holds it under its own part number). In ETO's material cost report.";

export const REMOVED_FROM_JOB_PULLS: readonly RemovedPull[] = [
  { pullId: 4109, jobId: 1155, itemId: 2706, note: `098-B-009 MACHINE FRONT SHORT PANEL. ${BATCH_1155}` },
  { pullId: 4111, jobId: 1155, itemId: 2708, note: `098-B-014 PANEL EXTENSION COVER. ${BATCH_1155}` },
  { pullId: 4115, jobId: 1155, itemId: 2714, note: `098-B-005 TOP PLATE. ${BATCH_1155}` },
  { pullId: 4126, jobId: 1155, itemId: 2728, note: `098-BA-001 LOWER STATIONARY PLATE. ${BATCH_1155}` },
  { pullId: 4134, jobId: 1155, itemId: 2738, note: `098-B-006 SUPPORT LEG, SHORTENED VERSION. ${BATCH_1155}` },
  { pullId: 4136, jobId: 1155, itemId: 2741, note: `098-B-010 MACHINE COVER BACK PANEL. ${BATCH_1155}` },
  { pullId: 4150, jobId: 1155, itemId: 2756, note: `FS-927 / 70821 FLOW SWITCHES. ${BATCH_1155}` },
  { pullId: 4156, jobId: 1155, itemId: 2765, note: `098-BC-009 SHOT PIN COVER. ${BATCH_1155}` },
  { pullId: 4187, jobId: 1155, itemId: 21345, note: `BES M12MG-PSC80F-S04G PROXIMITY SENSOR. ${BATCH_1155}` },
  { pullId: 4681, jobId: 1155, itemId: 2704, note: "098-B-013 LIFT TUBE FELT SEAL: stock return on 2026-10-06, after the batch. In ETO's material cost report." },
];

/** The list as a lookup, for matchTransfers. */
export const REMOVED_PULLS: ReadonlyMap<number, RemovedPull> = new Map(REMOVED_FROM_JOB_PULLS.map((r) => [r.pullId, r]));
