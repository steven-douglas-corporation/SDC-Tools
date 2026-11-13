import test from "node:test";
import assert from "node:assert/strict";
import { fakePartsLines, fakeSampleJobs } from "../src/lib/dev-fake-eto";
import { buildOpenPos } from "../src/lib/open-pos-rules";

// The generated sample jobs that give Open POs a long list in local development
// (dev-fake-eto.ts). Dev-only data, but the page's dev checks lean on these properties.

const SEEDED = ["9001", "9002", "9003", "9004", "9005", "9900"];

function withCount<T>(value: string | undefined, run: () => T): T {
  const before = process.env.SDC_DEV_FAKE_ETO_SAMPLE_JOBS;
  if (value === undefined) delete process.env.SDC_DEV_FAKE_ETO_SAMPLE_JOBS;
  else process.env.SDC_DEV_FAKE_ETO_SAMPLE_JOBS = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.SDC_DEV_FAKE_ETO_SAMPLE_JOBS;
    else process.env.SDC_DEV_FAKE_ETO_SAMPLE_JOBS = before;
  }
}

test("36 sample jobs by default; the count can be set, turned off, and is capped", () => {
  assert.equal(withCount(undefined, fakeSampleJobs).length, 36);
  assert.equal(withCount("5", fakeSampleJobs).length, 5);
  assert.equal(withCount("0", fakeSampleJobs).length, 0);
  assert.equal(withCount("500", fakeSampleJobs).length, 80);
  assert.equal(withCount("nonsense", fakeSampleJobs).length, 0);
  const jobs = withCount(undefined, fakeSampleJobs);
  assert.equal(new Set(jobs.map((j) => j.jobId)).size, jobs.length, "job ids are unique");
  assert.ok(jobs.every((j) => j.jobName.startsWith("DEV ")), "every name carries the DEV marker");
  assert.ok(jobs.every((j) => j.status === "Active" || j.status === "HeadStart"));
  assert.ok(!jobs.some((j) => SEEDED.includes(j.jobId)), "none reuses a seeded job's number");
});

test("sample POs are six characters, T first, and no PO number is shared between jobs", () => {
  const jobs = withCount("80", fakeSampleJobs).map((j) => j.jobId);
  const owner = new Map<string, string>();
  for (const job of [...jobs, ...SEEDED]) {
    for (const l of fakePartsLines(job)) {
      if (!l.poNumber) continue;
      assert.match(l.poNumber, /^T\d{5}$/, `${l.poNumber} on ${job}`);
      const seen = owner.get(l.poNumber);
      assert.ok(seen === undefined || seen === job, `${l.poNumber} is on both ${seen} and ${job}`);
      owner.set(l.poNumber, job);
    }
  }
});

test("a sample job's lines are the same every time, and its line ids are unique", () => {
  const a = fakePartsLines("9117");
  assert.deepEqual(fakePartsLines("9117"), a);
  assert.equal(new Set(a.map((l) => l.lineId)).size, a.length);
  assert.ok(a.every((l) => /^pod:9117\d{3}$/.test(l.lineId)), "line ids carry the job, as the fake BOM lookup expects");
});

test("the sample jobs differ: few POs and many, late and still to come, on the same page", () => {
  const jobs = withCount(undefined, fakeSampleJobs);
  const lines = new Map(jobs.map((j) => [j.jobId, fakePartsLines(j.jobId)] as const));
  const today = new Date().toISOString().slice(0, 10);
  const open = buildOpenPos(lines, jobs, today);
  const perJob = new Map<string, number>();
  for (const r of open.rows) for (const j of r.jobIds) perJob.set(j, (perJob.get(j) ?? 0) + 1);
  const counts = [...perJob.values()];
  assert.ok(Math.min(...counts) <= 2, "some job has only a PO or two open");
  assert.ok(Math.max(...counts) >= 10, "some job has many open");
  assert.ok(open.rows.some((r) => r.money.late > 0), "some POs are late");
  assert.ok(open.rows.some((r) => r.nextDue != null && r.nextDue > today), "some are still to come");
  assert.ok(open.rows.some((r) => r.partiallyReceived), "some are partly received");
  assert.ok(open.rows.some((r) => r.revised), "some were re-promised");
  assert.ok(open.rows.some((r) => r.money.invoicedNotReceived > 0 && r.leftToInvoice === 0), "some are paid for and not here yet");
});
