import "server-only";

import { execFile } from "node:child_process";
import { warehouseConfigured, warehouseSnapshot } from "@/lib/data-warehouse";
import { describeIngestRun, parseTaskSetting, INGEST_JOB, type IngestBatch, type IngestResult } from "@/lib/warehouse-ingest-outcome";

// ── Pulling Paylocity's files on demand ─────────────────────────────────────
//
// The reports app reads Paylocity from the DataWarehouse, and the warehouse is
// filled by tools/data-warehouse/ingest/paylocity_ingest.py: SFTP -> files ->
// warehouse. That script runs on its own schedule in Task Scheduler (hourly at :30
// since 2026-11-16, per "Integration"."Batch"), so until now Refresh Data could only
// re-read what the last scheduled run had loaded. A file Paylocity had just dropped
// stayed invisible until the next run, whatever anyone pressed.
//
// This starts that same scheduled task and waits for it. The TASK, not the script:
// the task runs as svc-datawarehouse, which holds the SFTP and dw_loader passwords
// in its own Credential Manager. Running the script from this process would mean
// copying both passwords to the account the app runs as. Starting the task moves no
// secret anywhere, and the run is logged, locked and recorded exactly like a scheduled one.
//
// WAREHOUSE_INGEST_TASK names the task, folder included (`\DataWarehouse\Paylocity
// ingest`). Unset means this step does not exist: a developer laptop has no such
// task. The account the app runs as needs the right to start it; without that the
// step fails with Task Scheduler's own message and the refresh carries on.

// Under the Refresh Data button's own 300s ceiling, with room for the rest of the
// pass. A load still running at this point is not stopped: it finishes on its own
// and the next refresh reads what it loaded.
export const INGEST_WAIT_MS = 150_000;

export function ingestConfigured(): boolean {
  return parseTaskSetting(process.env.WAREHOUSE_INGEST_TASK) != null;
}

// Starts the task unless it is already running, waits until it stops, and prints
// one line of JSON. LastRunTime is compared so a run too quick to be caught in the
// Running state still counts as having run. It gets 60 seconds to start: a busy
// Task Scheduler can take a while to launch a task, and giving up early would
// report "the task never ran" about one that was merely slow off the mark. The
// task is named through the environment so nothing from .env is spliced into the
// script.
//
// The try/catch writes the reason as plain text: left to itself, PowerShell run
// with -EncodedCommand reports an error as CLIXML, and the person reading the
// toast would be told "#< CLIXML" instead of "Access is denied".
// Progress is silenced for the same reason: "Preparing modules for first use" is
// CLIXML on stderr too, ahead of the real message.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
$p = $env:SDC_INGEST_TASK_PATH
$n = $env:SDC_INGEST_TASK_NAME
$t = Get-ScheduledTask -TaskPath $p -TaskName $n
$before = ($t | Get-ScheduledTaskInfo).LastRunTime
$joined = $t.State -eq 'Running'
if (-not $joined) {
  Start-ScheduledTask -TaskPath $p -TaskName $n
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    $now = Get-ScheduledTask -TaskPath $p -TaskName $n
    if ($now.State -eq 'Running' -or ($now | Get-ScheduledTaskInfo).LastRunTime -ne $before) { break }
    Start-Sleep -Milliseconds 500
  }
}
while ((Get-ScheduledTask -TaskPath $p -TaskName $n).State -eq 'Running') { Start-Sleep -Seconds 2 }
$i = Get-ScheduledTask -TaskPath $p -TaskName $n | Get-ScheduledTaskInfo
[pscustomobject]@{ joined = $joined; ran = ($joined -or $i.LastRunTime -ne $before); exitCode = $i.LastTaskResult } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

type TaskRun = { joined: boolean; ran: boolean; exitCode: number };

function runTask(task: { taskPath: string; taskName: string }): Promise<TaskRun> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")],
      {
        env: { ...process.env, SDC_INGEST_TASK_PATH: task.taskPath, SDC_INGEST_TASK_NAME: task.taskName },
        timeout: INGEST_WAIT_MS,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          // `killed` is the timeout above: only the watcher is stopped, never the load.
          if (err.killed) {
            reject(
              new Error(
                `The Paylocity load was still running after ${INGEST_WAIT_MS / 1000}s, so this refresh used what the warehouse already held. ` +
                  `The load carries on by itself; refresh again in a few minutes to read it.`,
              ),
            );
            return;
          }
          const why = (stderr || err.message).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#< CLIXML") && !l.startsWith("<Objs"))[0] ?? "no reason given";
          reject(new Error(`Could not start the scheduled task ${task.taskPath}${task.taskName}: ${why.slice(0, 240)}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as { joined: boolean; ran: boolean; exitCode: number };
          resolve({ joined: !!parsed.joined, ran: !!parsed.ran, exitCode: Number(parsed.exitCode) });
        } catch {
          reject(new Error(`The scheduled task ${task.taskPath}${task.taskName} gave no readable result.`));
        }
      },
    );
  });
}

// The batch this run wrote. `since` is null when we joined a run already going,
// whose batch began before we looked: its row is simply the newest one.
async function readBatch(since: Date | null): Promise<IngestBatch | null> {
  type Row = { BatchId: string | number; Status: string; Counts: Record<string, unknown> | null; ErrorMessage: string | null };
  const rows = await warehouseSnapshot((q) =>
    q<Row>(
      `SELECT "BatchId", "Status", "Counts", "ErrorMessage"
         FROM "Integration"."Batch"
        WHERE "JobName" = $1 AND ($2::timestamptz IS NULL OR "StartedAt" >= $2::timestamptz)
        ORDER BY "BatchId" DESC
        LIMIT 1`,
      [INGEST_JOB, since],
    ),
  );
  const r = rows[0];
  return r ? { batchId: Number(r.BatchId), status: r.Status, counts: r.Counts, errorMessage: r.ErrorMessage } : null;
}

/**
 * Runs the Paylocity load and says what it did. Null when no task is configured.
 * Never throws: a load that cannot run is reported, and the refresh that asked for
 * it goes on to read whatever the warehouse holds.
 */
export async function runWarehouseIngest(): Promise<IngestResult | null> {
  const task = parseTaskSetting(process.env.WAREHOUSE_INGEST_TASK);
  if (!task) return null;
  try {
    if (process.platform !== "win32") {
      throw new Error("WAREHOUSE_INGEST_TASK is set, but the Paylocity load is a Windows scheduled task and this server is not Windows.");
    }
    // Half a minute of slack: Task Scheduler and PostgreSQL share this server's
    // clock in production, and the previous batch is hours older than that.
    const since = new Date(Date.now() - 30_000);
    const run = await runTask(task);
    if (!run.ran) {
      throw new Error(`Task Scheduler accepted the start of ${task.taskPath}${task.taskName}, but the task never ran. Check that it is enabled.`);
    }
    if (!warehouseConfigured()) {
      return run.exitCode === 0
        ? { status: "ok", detail: "Paylocity SFTP: the load ran (DATAWAREHOUSE_URL is unset, so what it loaded was not read back)." }
        : { status: "failed", detail: `The Paylocity load ended with exit code ${run.exitCode}.` };
    }
    const batch = await readBatch(run.joined ? null : since);
    return describeIngestRun({ joined: run.joined, exitCode: run.exitCode, batch });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[warehouse-ingest] ${detail}`);
    return { status: "failed", detail };
  }
}
