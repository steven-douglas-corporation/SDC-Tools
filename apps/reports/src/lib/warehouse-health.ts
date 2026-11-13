import "server-only";

import { warehouseSnapshot } from "@/lib/data-warehouse";
import { prisma } from "@/lib/prisma";
import { formatEastern, type WarehouseJobHealth, type WarehouseLoadCheck } from "@/lib/warehouse-load-check";

// ── Reading "Integration"."JobHealth" and telling people (2026-11-13) ────────
//
// The view (tools/data-warehouse/sql/07_monitoring.sql) decides per job whether a
// run is missing; lib/warehouse-load-check.ts turns that into sentences. This file
// does the two things with side effects: the read, and the Teams alert.

export async function readWarehouseJobHealth(): Promise<WarehouseJobHealth[]> {
  type Row = {
    JobName: string;
    Description: string;
    DueBy: string;
    DueSince: Date | null;
    ExpectedDataThrough: string | null;
    LastRunAt: Date | null;
    LastRunStatus: string | null;
    LastRunError: string | null;
    LastSucceededAt: Date | null;
    IsOverdue: boolean;
    TodayIsBusinessDay: boolean;
  };
  const rows = await warehouseSnapshot((q) =>
    q<Row>(
      `SELECT "JobName", "Description", "DueBy"::text AS "DueBy", "DueSince",
              to_char("ExpectedDataThrough", 'YYYY-MM-DD') AS "ExpectedDataThrough",
              "LastRunAt", "LastRunStatus", "LastRunError", "LastSucceededAt",
              "IsOverdue", "TodayIsBusinessDay"
         FROM "Integration"."JobHealth"
        ORDER BY "JobName"`,
    ),
  );
  return rows.map((r) => ({
    jobName: r.JobName,
    description: r.Description,
    dueBy: r.DueBy,
    dueSince: r.DueSince,
    expectedDataThrough: r.ExpectedDataThrough,
    lastRunAt: r.LastRunAt,
    lastRunStatus: r.LastRunStatus,
    lastRunError: r.LastRunError,
    lastSucceededAt: r.LastSucceededAt,
    isOverdue: r.IsOverdue,
    todayIsBusinessDay: r.TodayIsBusinessDay,
  }));
}

// ── The Teams alert ─────────────────────────────────────────────────────────
//
// A banner only helps whoever opens the page, and this outage went three days
// because nobody happened to look closely. So a missed load is also posted to a
// Teams channel, the same way the calendar app already alerts
// (apps/calendar/server/notificationService.js).
//
// DATA_ALERT_TEAMS_WEBHOOK_URL is the channel's webhook (a Teams "Workflows"
// webhook or a classic incoming webhook: both accept the Adaptive Card below).
// Unset means no alert; the banner and Data Sync card still show the problem.
//
// At most ONE post per business day while the problem lasts, and one "resolved"
// post when it clears. The hourly pass would otherwise post 24 times a day, and a
// channel that pings every hour is muted by the second day. What was last posted
// is kept on a PowerBiFreshness row of its own (not on the schedule, so it never
// shows as a source): refreshedThrough = when, status = "open" while unresolved.

const ALERT_ROW = "warehouse_load_alert";

function easternDay(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
}

function card(title: string, lines: string[], tone: "Attention" | "Good") {
  const base = process.env.AUTH_URL?.trim().replace(/\/+$/, "");
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", color: tone, wrap: true },
            ...lines.map((text) => ({ type: "TextBlock", text, wrap: true, spacing: "Small" })),
          ],
          ...(base ? { actions: [{ type: "Action.OpenUrl", title: "Open Job Details", url: `${base}/job-hours` }] } : {}),
        },
      },
    ],
  };
}

async function post(url: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Teams webhook answered HTTP ${res.status}`);
}

/**
 * Posts to Teams when the load is behind (once per business day) or has just
 * recovered. Never throws: an alert that cannot be sent must not turn the
 * check itself into a failure, and the banner still carries the message.
 */
export async function notifyWarehouseLoad(check: WarehouseLoadCheck, now = new Date()): Promise<void> {
  const url = process.env.DATA_ALERT_TEAMS_WEBHOOK_URL?.trim();
  if (!url) return;
  try {
    const last = await prisma.powerBiFreshness.findUnique({
      where: { source: ALERT_ROW },
      select: { refreshedThrough: true, status: true },
    });
    const open = last?.status === "open";

    if (!check.ok) {
      if (!check.todayIsBusinessDay) return;
      if (open && last && easternDay(last.refreshedThrough) === easternDay(now)) return;
      await post(
        url,
        card(
          "Hours data is out of date",
          [
            ...check.problems,
            "Until it is fixed, Job Details and Monthly ETC show hours as of the last successful load.",
          ],
          "Attention",
        ),
      );
      await prisma.powerBiFreshness.upsert({
        where: { source: ALERT_ROW },
        update: { refreshedThrough: now, checkedAt: now, status: "open" },
        create: { source: ALERT_ROW, refreshedThrough: now, checkedAt: now, status: "open" },
      });
      return;
    }

    if (open) {
      await post(
        url,
        card(
          "Hours data is current again",
          [
            check.lastSucceededAt
              ? `The warehouse load succeeded at ${formatEastern(check.lastSucceededAt)}.`
              : "The warehouse load is back on schedule.",
          ],
          "Good",
        ),
      );
      await prisma.powerBiFreshness.update({
        where: { source: ALERT_ROW },
        data: { checkedAt: now, status: null },
      });
    }
  } catch (err) {
    console.error(`[warehouse-load] Teams alert not sent: ${err instanceof Error ? err.message : String(err)}`);
  }
}
