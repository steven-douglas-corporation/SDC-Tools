import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeIngestRun, parseTaskSetting, INGEST_LABEL, INGEST_SOURCE, type IngestBatch } from "../src/lib/warehouse-ingest-outcome";

// The on-demand Paylocity load (lib/warehouse-ingest.ts): what the task setting
// means, and what a person is told after each way a run can end.

function batch(over: Partial<IngestBatch> = {}): IngestBatch {
  return { batchId: 412, status: "succeeded", counts: { seen: 0 }, errorMessage: null, ...over };
}

test("the task setting splits into the folder and the name PowerShell asks for", () => {
  assert.deepEqual(parseTaskSetting("\\DataWarehouse\\Paylocity ingest"), { taskPath: "\\DataWarehouse\\", taskName: "Paylocity ingest" });
  assert.deepEqual(parseTaskSetting("DataWarehouse\\Paylocity ingest"), { taskPath: "\\DataWarehouse\\", taskName: "Paylocity ingest" });
  assert.deepEqual(parseTaskSetting("  Paylocity ingest "), { taskPath: "\\", taskName: "Paylocity ingest" });
  assert.deepEqual(parseTaskSetting("\\Paylocity ingest"), { taskPath: "\\", taskName: "Paylocity ingest" });
  assert.deepEqual(parseTaskSetting("\\A\\B\\Load"), { taskPath: "\\A\\B\\", taskName: "Load" });
});

test("no setting, or a folder with no task name, means the step is off", () => {
  assert.equal(parseTaskSetting(undefined), null);
  assert.equal(parseTaskSetting("   "), null);
  assert.equal(parseTaskSetting("\\DataWarehouse\\"), null);
});

test("a run that found nothing new says so, and is a success", () => {
  const r = describeIngestRun({ joined: false, exitCode: 0, batch: batch() });
  assert.equal(r.status, "ok");
  assert.equal(r.detail, "Paylocity SFTP: no new files.");
});

test("a run that loaded files says how many, and how many rows", () => {
  const r = describeIngestRun({
    joined: false,
    exitCode: 0,
    batch: batch({ counts: { seen: 3, downloaded: 3, loaded: 2, skipped: 1, rows_loaded: 54535 } }),
  });
  assert.equal(r.status, "ok");
  assert.equal(r.detail, "Paylocity SFTP: 3 new files copied, 2 loaded (54,535 rows).");
});

test("waiting on a load that was already running is said, not hidden", () => {
  const r = describeIngestRun({ joined: true, exitCode: 0, batch: batch({ counts: { downloaded: 1, loaded: 1, rows_loaded: 1 } }) });
  assert.equal(r.detail, "Paylocity SFTP: 1 new file copied, 1 loaded (1 row) (joined the load already running).");
});

test("a batch that finished with errors is a failure carrying the batch's own reason", () => {
  const r = describeIngestRun({
    joined: false,
    exitCode: 1,
    batch: batch({ status: "failed", errorMessage: "load Current_Job_Hours.xlsx: headers_missing\nrefresh warehouse: skipped\nthird line" }),
  });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /batch 412/);
  assert.match(r.detail, /headers_missing; refresh warehouse: skipped/);
  assert.doesNotMatch(r.detail, /third line/);
});

test("a non-zero exit with no batch is the SFTP sign-in case, and points at the log", () => {
  const r = describeIngestRun({ joined: false, exitCode: 1, batch: null });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /exit code 1/);
  assert.match(r.detail, /SFTP sign-in/);
  assert.match(r.detail, /paylocity_ingest\.log/);
});

test("a clean exit with no batch is another run holding the lock: skipped, not failed", () => {
  const r = describeIngestRun({ joined: false, exitCode: 0, batch: null });
  assert.equal(r.status, "skipped");
});

test("a batch left 'running' after the task stopped is not reported as loaded", () => {
  const r = describeIngestRun({ joined: false, exitCode: 0, batch: batch({ status: "running" }) });
  assert.equal(r.status, "failed");
});

// ── The wiring a type check cannot see ──────────────────────────────────────

const read = (...p: string[]) => readFileSync(join(process.cwd(), "src", ...p), "utf8");

test("the stage label fits RefreshRun.currentStage (VarChar 64)", () => {
  assert.ok(INGEST_LABEL.length <= 64);
});

test("the load runs only for a refresh somebody asked for, never on the hourly or startup pass", () => {
  const service = read("lib", "refresh-service.ts");
  assert.match(
    service,
    /if \(\(input\.trigger === "manual" \|\| input\.trigger === "api"\) && input\.pullFiles !== false\) \{\s*const \{ ingestConfigured, runWarehouseIngest \}/,
  );
});

test("the load's own call (pull=0) refreshes without starting the load again", () => {
  const route = read("app", "api", "integration", "refresh", "route.ts");
  assert.match(route, /const pullFiles = params\.get\("pull"\) !== "0"/);
  // Both the waiting and the background path must carry it, or one of them loops.
  assert.equal(route.match(/refreshAllData\(\{ trigger: "api", userName, pullFiles \}\)/g)?.length, 2);
});

test("only a person's click may start a new ETC month: the API trigger does not", () => {
  const service = read("lib", "refresh-service.ts");
  assert.match(service, /if \(input\.trigger === "manual"\) \{\s*try \{\s*const \{ startMonth \}/);
});

test("the button names the pull by the same source id the service reports", () => {
  const button = read("components", "RefreshDataButton.tsx");
  assert.ok(button.includes(`"${INGEST_SOURCE}"`));
});

test("the endpoint has its own token and refuses everything when it is unset", () => {
  const route = read("app", "api", "integration", "refresh", "route.ts");
  assert.match(route, /process\.env\.REFRESH_API_TOKEN/);
  // Not the Scheduler's token: that one lets another app read jobs, not start loads.
  assert.doesNotMatch(route, /checkSchedulerToken/);
  assert.match(route, /refresh_api_not_configured" \}, \{ status: 503 \}/);
  assert.match(route, /trigger: "api"/);
});
