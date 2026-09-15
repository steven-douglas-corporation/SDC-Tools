import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { monthsAccountedFor, departedJobMonths } from "../src/lib/sync-actuals";

// ── (job, month) buckets the export no longer accounts for (2026-09-14) ──────
//
// syncJobHoursDetail is replace-by-(job, month), and it only ever visited pairs the
// feed still had rows for. A pair whose punches ALL moved upstream — every July punch
// on 1104 recoded to 1145 — had zero rows in the new feed, so its stored punches, its
// JobHoursBucket digest and its JobMonthlyActualHours rollup all persisted, and both
// jobs carried the 40h. The two pure helpers here are the rule that closes that: judge a
// stored pair only inside the months the feed carries rows for, and remove the ones the
// feed no longer mentions. The guard is the same one syncHoursWorked's zeroing pass has
// always used.

const row = (jobId: string, year: number, month: number) => ({ jobId, year, month });

test("monthsAccountedFor is the set of report months the feed carries rows for, zero-padded", () => {
  const months = monthsAccountedFor([row("1104", 2026, 7), row("1145", 2026, 7), row("1104", 2026, 8), row("2026", 2025, 12)]);
  assert.deepEqual([...months].sort(), ["2025-12", "2026-07", "2026-08"]);
});

test("an empty feed accounts for no month at all — nothing may be judged against it", () => {
  // A failed or partial read must never be able to erase history; with no months the
  // departed set is empty whatever the table holds.
  const months = monthsAccountedFor([]);
  assert.equal(months.size, 0);
  const stored = [{ jobPk: 1, month: "2026-07" }, { jobPk: 2, month: "2026-07" }];
  assert.deepEqual(departedJobMonths(stored, new Set(), months), []);
});

test("the 1104 -> 1145 case: the pair that lost every punch is departed, the one that gained them is not", () => {
  // July is in the feed (1145 carries it), so July is judged. 1104's July bucket is
  // stored but absent from the feed -> departed. 1145's is present -> kept.
  const feedRows = [row("1145", 2026, 7)];
  const months = monthsAccountedFor(feedRows);
  const present = new Set(["1145::2026-07"]); // `${jobPk}::${month}` — pks stand in for the job numbers here
  const stored = [
    { jobPk: 1104, month: "2026-07", rows: 5, hours: 40 },
    { jobPk: 1145, month: "2026-07", rows: 5, hours: 40 },
  ];
  const departed = departedJobMonths(stored, present, months);
  assert.deepEqual(departed.map((d) => `${d.jobPk}::${d.month}`), ["1104::2026-07"]);
});

test("a stored pair in a month the feed does not carry is PRESERVED, whatever the feed says", () => {
  // "Absent must never mean delete" — the pre-feed legacy months and anything past the
  // file's reach stay exactly as they are. Only the month the feed actually describes
  // is judged.
  const months = monthsAccountedFor([row("1145", 2026, 8)]);
  const stored = [
    { jobPk: 1104, month: "2025-03" }, // legacy history, no source file reaches it
    { jobPk: 1104, month: "2026-07" }, // feed has no August-only export rows for July -> not judged
    { jobPk: 1104, month: "2026-08" }, // judged: August IS in the feed, and 1104 is not
  ];
  assert.deepEqual(departedJobMonths(stored, new Set(["1145::2026-08"]), months).map((d) => d.month), ["2026-08"]);
});

test("a month whose only feed rows are on a job the app does not know still counts as accounted for", () => {
  // The export DID describe that month; a stored bucket it no longer mentions really is
  // gone. The job lookup happens after this rule, on purpose.
  const months = monthsAccountedFor([row("2026", 2026, 9)]); // "2026" is someone typing the year
  assert.ok(months.has("2026-09"));
});

test("departedJobMonths keeps the caller's own fields on the returned entries", () => {
  // The rollup pass carries the row id and current figure through so it can log and
  // zero by id; the bucket pass carries row count and hours for the log line.
  const months = new Set(["2026-07"]);
  const stored = [{ jobPk: 7, month: "2026-07", id: 99, actualHours: 12.5 }];
  const [d] = departedJobMonths(stored, new Set(), months);
  assert.equal(d.id, 99);
  assert.equal(d.actualHours, 12.5);
});

// ── Wiring, by source inspection: the helpers are what the two syncs actually use ──

const SRC = readFileSync(join(process.cwd(), "src", "lib", "sync-actuals.ts"), "utf8");

test("syncJobHoursDetail removes a departed bucket's rows AND its digest in one transaction", () => {
  const fn = SRC.slice(SRC.indexOf("export async function syncJobHoursDetail"), SRC.indexOf("function digestBucket"));
  assert.match(fn, /monthsAccountedFor\(rows\)/, "must scope to the months the feed accounts for");
  assert.match(fn, /departedJobMonths\(/, "must judge stored pairs through the shared rule");
  // Rows and digest go together — a digest must never describe rows that are not there.
  assert.match(fn, /\$transaction\(\[\s*prisma\.jobHoursDetail\.deleteMany\(\{ where \}\),\s*prisma\.jobHoursBucket\.deleteMany\(\{ where \}\),\s*\]\)/);
  assert.match(fn, /removedBuckets: departed\.length/);
});

test("syncActualHours ZEROES a departed rollup and never touches an overridden one", () => {
  const fn = SRC.slice(SRC.indexOf("export async function syncActualHours"), SRC.indexOf("export function monthsAccountedFor"));
  assert.match(fn, /monthsAccountedFor\(rows\)/);
  assert.match(fn, /departedJobMonths\(/);
  // The row is where a manual override lives, so it is zeroed rather than deleted...
  assert.match(fn, /data: \{ actualHours: 0, syncedAt: new Date\(\), source: "paylocity_excel" \}/);
  assert.doesNotMatch(fn, /jobMonthlyActualHours\.deleteMany/);
  // ...and only rows that are not overridden are candidates at all.
  assert.match(fn, /where: \{ month: \{ in: \[\.\.\.months\] \}, overridden: false, actualHours: \{ not: 0 \} \}/);
  assert.match(fn, /rowsZeroed,/);
});

test("the purge script reports the same departed set through the same helpers", () => {
  const script = readFileSync(join(process.cwd(), "scripts", "purge-stale-hours-rows.ts"), "utf8");
  assert.match(script, /import \{ monthsAccountedFor, departedJobMonths \} from "\.\.\/src\/lib\/sync-actuals"/);
  assert.match(script, /process\.argv\.includes\("--apply"\)/, "dry run must stay the default");
  assert.match(script, /OVERRIDDEN — preserved/, "overridden rollups are listed, never touched");
});
