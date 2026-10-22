import "server-only";

import { warehouseConfigured, warehouseSnapshot } from "@/lib/data-warehouse";
import { jobMaster } from "@/lib/hours-feed";
import { readTempPunches, TEMP_REPORT_KEY, type TempFeed } from "@/lib/temp-punches";
import { tempPunchFindings, type TempPunchQuality, type StagingPunch } from "@/lib/temp-punch-findings";

// ── Data Management → Data quality → "Temp punches (Paylocity report)" (2026-10-22) ──
//
// Where the temp report and the app disagree, for a person to act on. Read live, and only
// when that tab is open — the same way the roster and position-family sections are — so it
// is always about the file as it is now, with nothing stored to go stale.
//
// What the app can and cannot use is NOT recomputed here. The punches go through the same
// reader the hours use (readTempPunches), and its own rejections ARE the findings, so this
// section and the Undefined Hours figures cannot disagree about what is broken. What the
// reader cannot see — a punch with no Out, which carries 0 hours and so never reaches it —
// comes from the warehouse's staging view, which keeps every row as delivered.
//
// Fixing the punches themselves is a Paylocity correction; the report is HR's.

/** The columns the warehouse's TempPunch view reads. One missing means the view reads NULL for it. */
export const TEMP_PUNCH_COLUMNS = [
  "Last Name",
  "Preferred / First Name",
  "Work Date",
  "Punch In Time",
  "Punch Out Time",
  "Regular Duration  (Hours)",
  "OT1 Duration (Hours)",
  "Jobs",
  "Jobs Name",
  "MachineSec",
  "Function",
] as const;

export async function getTempPunchQuality(feedOverride?: TempFeed): Promise<TempPunchQuality> {
  const base = { configured: warehouseConfigured(), error: null as string | null };
  if (!base.configured) return { ...base, ...emptyQuality(), error: null };

  try {
    const { known, byLabel } = await jobMaster();
    const feed = feedOverride ?? (await readTempPunches({ knownJobNumbers: known, jobIdByLabel: byLabel }));
    if (feed.status === "failed") return { ...base, ...emptyQuality(), error: feed.error ?? "The temp punches could not be read." };
    if (feed.status !== "ok") return { ...base, ...emptyQuality(), waiting: true };

    const { staging, keys } = await warehouseSnapshot(async (q) => ({
      staging: await q<StagingPunch>(
        `SELECT "SheetRow" AS "sheetRow", "EmployeeName" AS "name", to_char("WorkDate", 'YYYY-MM-DD') AS "workDate",
                to_char("PunchIn", 'HH24:MI') AS "punchIn", to_char("PunchOut", 'HH24:MI') AS "punchOut",
                "IsOpen" AS "isOpen", "Hours"::float8 AS "hours", "JobCode" AS "jobCode",
                "SectionCode" AS "sectionCode", "FunctionCode" AS "functionCode"
         FROM "Paylocity"."TempPunch" WHERE "WorkDate" IS NOT NULL`,
      ),
      keys: await q<{ key: string }>(
        `SELECT DISTINCT k.key
         FROM "RawPaylocity"."DataRow" AS d
         JOIN "RawPaylocity"."LatestFile" AS l USING ("FileId")
         CROSS JOIN LATERAL jsonb_object_keys(d."RowJson") AS k (key)
         WHERE d."ReportKey" = $1`,
        [TEMP_REPORT_KEY],
      ),
    }));

    const seen = new Set(keys.map((k) => k.key));
    const missingColumns = TEMP_PUNCH_COLUMNS.filter((c) => !seen.has(c));
    return { ...base, ...tempPunchFindings({ staging, feed, missingColumns }) };
  } catch (err) {
    return { ...base, ...emptyQuality(), error: err instanceof Error ? err.message : String(err) };
  }
}

function emptyQuality() {
  return tempPunchFindings({ staging: [], feed: null, missingColumns: [] });
}
