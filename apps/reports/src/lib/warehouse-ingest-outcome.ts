// The rules behind the on-demand Paylocity load. Pure on purpose (no I/O, no
// server-only), like warehouse-load-check.ts, so the sentences a person reads after
// pressing Refresh Data are tested rather than eyeballed on the day the load breaks.
// The side effects (starting the task, reading the batch) are in warehouse-ingest.ts.

export const INGEST_SOURCE = "warehouse_ingest";
// Shown as the refresh stage. RefreshRun.currentStage is VarChar(64).
export const INGEST_LABEL = "Paylocity files (SFTP to warehouse)";
// The tag paylocity_ingest.py writes into "Integration"."Batch"."JobName".
export const INGEST_JOB = "paylocity_ingest";

export type IngestResult = { status: "ok" | "skipped" | "failed"; detail: string };

/**
 * The load has new files and asks for a refresh, but one is already running. Is
 * that refresh going to read them?
 *
 * Only if it has not reached the warehouse yet, and the one case where that is
 * certain is a refresh still on the stage that waits for this very load (the
 * button, or the endpoint, started or joined it). Any other stage, or none, means
 * a pass that may have read the hours BEFORE these files landed: a startup or
 * hourly pass that happened to overlap the load. Answering "busy, not needed"
 * there would leave the new files unread until the next hourly pass, which is the
 * delay the load's call exists to remove. So that case queues one more refresh.
 */
export function busyAnswerForLoad(stage: string | null): "reads_these_files" | "queue_follow_up" {
  return stage === INGEST_LABEL ? "reads_these_files" : "queue_follow_up";
}

/**
 * Who called POST /api/integration/refresh, for the refresh record and the audit
 * log: the X-Refresh-Caller header or ?caller=, reduced to plain characters. "API
 * request refreshed all data" does not say whether it was the warehouse load, a
 * script or a person with curl, which is the first question when one misbehaves.
 */
export function apiCallerName(raw: string | null | undefined): string {
  const name = (raw ?? "").replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, 40);
  return name ? `API: ${name}` : "API: unnamed caller";
}

export type IngestBatch = {
  batchId: number;
  status: string; // "running" | "succeeded" | "failed"
  counts: Record<string, unknown> | null;
  errorMessage: string | null;
};

/**
 * WAREHOUSE_INGEST_TASK is the scheduled task as Task Scheduler shows it, folder
 * included: `\DataWarehouse\Paylocity ingest`. PowerShell wants the folder and the
 * name apart, and the folder with a backslash at both ends.
 */
export function parseTaskSetting(raw: string | undefined | null): { taskPath: string; taskName: string } | null {
  const value = raw?.trim();
  if (!value) return null;
  const cut = value.lastIndexOf("\\");
  const taskName = value.slice(cut + 1).trim();
  if (!taskName) return null;
  const folder = cut <= 0 ? "" : value.slice(0, cut).replace(/^\\+|\\+$/g, "");
  return { taskPath: folder ? `\\${folder}\\` : "\\", taskName };
}

function count(counts: Record<string, unknown> | null, key: string): number {
  const n = Number(counts?.[key] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/**
 * What one run of the load task amounted to.
 *
 * `joined` is true when the task was already running (the scheduled run, or someone
 * else's click) and this pass waited for it instead of starting a second one.
 * `exitCode` is Task Scheduler's last result for the task: 0, or 1 when the
 * script reported errors. `batch` is the "Integration"."Batch" row the run wrote,
 * or null when it wrote none.
 */
export function describeIngestRun(input: { joined: boolean; exitCode: number; batch: IngestBatch | null }): IngestResult {
  const { joined, exitCode, batch } = input;
  if (!batch) {
    // The script signs in to SFTP before it opens a batch, so a run that fails
    // there leaves a non-zero exit code and no row at all.
    if (exitCode !== 0) {
      return {
        status: "failed",
        detail:
          `The Paylocity load stopped before it reached the warehouse (exit code ${exitCode}), which is usually the SFTP sign-in. ` +
          `The reason is in logs\\paylocity_ingest.log on the warehouse server.`,
      };
    }
    return { status: "skipped", detail: "The Paylocity load ran but loaded nothing: another load was already in progress." };
  }
  if (batch.status === "failed") {
    const why = (batch.errorMessage ?? "no reason recorded").split(/\r?\n/).filter(Boolean).slice(0, 2).join("; ").slice(0, 300);
    return { status: "failed", detail: `The Paylocity load (batch ${batch.batchId}) finished with errors: ${why}` };
  }
  if (batch.status !== "succeeded") {
    return { status: "failed", detail: `The Paylocity load (batch ${batch.batchId}) ended without finishing its batch.` };
  }
  const downloaded = count(batch.counts, "downloaded");
  const loaded = count(batch.counts, "loaded");
  const rows = count(batch.counts, "rows_loaded");
  const how = joined ? " (joined the load already running)" : "";
  if (downloaded === 0 && loaded === 0) {
    return { status: "ok", detail: `Paylocity SFTP: no new files${how}.` };
  }
  return {
    status: "ok",
    detail: `Paylocity SFTP: ${plural(downloaded, "new file")} copied, ${loaded.toLocaleString("en-US")} loaded (${plural(rows, "row")})${how}.`,
  };
}
