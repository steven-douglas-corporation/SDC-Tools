-- DataWarehouse (PostgreSQL): is every load that should have run, run?
--
-- Run after 06_people.sql, as the database owner: signed in as yourself, start the
-- session with SET ROLE dw_loader; (see README "To apply"). Safe to re-run: tables
-- and columns are only added when missing, seed rows only inserted when missing,
-- and the view is CREATE OR REPLACE. reports_app can read everything here through
-- the default privileges in 05_access.sql.
--
--   psql "host=localhost port=5432 dbname=DataWarehouse user=dw_loader" -v ON_ERROR_STOP=1 -f 07_monitoring.sql
--
-- Why (2026-11-13): the daily Paylocity load stopped for three business days
-- (11/10-11/12) and nothing said so. The task stored Jon's Windows password; he
-- changed it on 11/9, so Task Scheduler could no longer start it. A task that
-- never starts writes no "failed" row anywhere: "Integration"."Batch" simply had
-- no row for those days, the reports app kept showing hours through 11/6, and
-- people noticed before any system did, for the fourth or fifth time.
--
-- So the question this file answers is not "did a run fail?" but "is a run
-- MISSING?". That needs to know which jobs are expected and when, which is what
-- "ExpectedJob" records. Adding a job to the monitoring is one row there.

-- ── Which jobs are expected, and by when ──────────────────────────────────────
--
-- "JobName" is the tag each job already writes into "Integration"."Batch"."JobName"
-- (paylocity_ingest.py: JOB_NAME). "DueBy" is the local (Eastern) time by which a
-- successful run must have finished on every business day: the scheduled start
-- plus enough slack for a slow run, not the start time itself.
CREATE TABLE IF NOT EXISTS "Integration"."ExpectedJob" (
    "JobName"     text    PRIMARY KEY,
    "Description" text    NOT NULL,
    "DueBy"       time    NOT NULL,
    "Enabled"     boolean NOT NULL DEFAULT true,
    "Notes"       text
);

INSERT INTO "Integration"."ExpectedJob" ("JobName", "Description", "DueBy", "Notes")
VALUES ('paylocity_ingest',
        'Paylocity load into the warehouse',
        '06:30',
        'Task Scheduler \DataWarehouse\Paylocity ingest on SERVER-APP1, daily at 05:30, runs as '
        'SERVER-APP1\svc-datawarehouse. Output: D:\DataWarehouse\logs\paylocity_ingest.log.')
ON CONFLICT ("JobName") DO NOTHING;

-- ── Business days ─────────────────────────────────────────────────────────────
--
-- "IsWeekday" alone would expect data for Thanksgiving and then report the day
-- after as stale (nobody punched on the holiday, so the hours legitimately stop
-- the day before). Mark company holidays here:
--
--   UPDATE "Dimension"."Date" SET "IsHoliday" = true, "HolidayName" = 'Thanksgiving'
--   WHERE "Date" IN ('2026-11-26');
ALTER TABLE "Dimension"."Date" ADD COLUMN IF NOT EXISTS "IsHoliday"   boolean NOT NULL DEFAULT false;
ALTER TABLE "Dimension"."Date" ADD COLUMN IF NOT EXISTS "HolidayName" text;

-- SDC paid holidays, from HR's "2026 Holidays" sheet. Add each new year's here.
UPDATE "Dimension"."Date" AS d
   SET "IsHoliday" = true, "HolidayName" = h.name
  FROM (VALUES
        (date '2026-01-01', 'New Year''s Day'),
        (date '2026-04-03', 'Easter (observed)'),
        (date '2026-05-25', 'Memorial Day'),
        (date '2026-07-03', 'Independence Weekend'),
        (date '2026-07-06', 'Independence Weekend'),
        (date '2026-09-07', 'Labor Day'),
        (date '2026-11-26', 'Thanksgiving Weekend'),
        (date '2026-11-27', 'Thanksgiving Weekend'),
        (date '2026-12-24', 'Christmas Holidays'),
        (date '2026-12-25', 'Christmas Holidays')) AS h (day, name)
 WHERE d."Date" = h.day;

-- ── One row per expected job: is it current? ─────────────────────────────────
--
--   "DueSince"            the latest business-day deadline that has already passed
--                         (e.g. Monday 10:00 -> Monday 06:30; Saturday -> Friday 06:30)
--   "ExpectedDataThrough" the business day before "DueSince": a daily load that ran
--                         Monday morning carries data through Friday
--   "IsOverdue"           no successful run since "DueSince" — the case that went
--                         unnoticed for three days, because a run that never started
--                         leaves no row behind
--   "LastRun*"            the newest run whatever its outcome, so a failure shows its
--                         own error message
--
-- Clock: Eastern, explicitly, so the answer does not depend on the session or
-- server time zone.
CREATE OR REPLACE VIEW "Integration"."JobHealth" AS
WITH clock AS (
    SELECT (now() AT TIME ZONE 'America/New_York') AS "LocalNow"
),
jobs AS (
    SELECT j.*,
           c."LocalNow",
           (SELECT d."Date" + j."DueBy"
              FROM "Dimension"."Date" d
             WHERE d."IsWeekday" AND NOT d."IsHoliday"
               AND d."Date" > c."LocalNow"::date - 31
               AND d."Date" + j."DueBy" <= c."LocalNow"
             ORDER BY d."Date" DESC
             LIMIT 1) AS "DueSinceLocal"
      FROM "Integration"."ExpectedJob" j
     CROSS JOIN clock c
     WHERE j."Enabled"
)
SELECT j."JobName",
       j."Description",
       j."DueBy",
       j."DueSinceLocal" AT TIME ZONE 'America/New_York'                AS "DueSince",
       (SELECT max(d."Date")
          FROM "Dimension"."Date" d
         WHERE d."IsWeekday" AND NOT d."IsHoliday"
           AND d."Date" < j."DueSinceLocal"::date
           AND d."Date" > j."DueSinceLocal"::date - 31)                  AS "ExpectedDataThrough",
       last_run."StartedAt"                                              AS "LastRunAt",
       last_run."Status"                                                 AS "LastRunStatus",
       last_run."ErrorMessage"                                           AS "LastRunError",
       last_ok."FinishedAt"                                              AS "LastSucceededAt",
       (j."DueSinceLocal" IS NOT NULL
        AND (last_ok."FinishedAt" IS NULL
             OR last_ok."FinishedAt" < j."DueSinceLocal" AT TIME ZONE 'America/New_York'))
                                                                         AS "IsOverdue",
       EXISTS (SELECT 1 FROM "Dimension"."Date" d
                WHERE d."Date" = j."LocalNow"::date
                  AND d."IsWeekday" AND NOT d."IsHoliday")               AS "TodayIsBusinessDay"
  FROM jobs j
  LEFT JOIN LATERAL (
        SELECT b."StartedAt", b."Status", b."ErrorMessage"
          FROM "Integration"."Batch" b
         WHERE b."JobName" = j."JobName"
         ORDER BY b."BatchId" DESC
         LIMIT 1) last_run ON true
  LEFT JOIN LATERAL (
        SELECT max(b."FinishedAt") AS "FinishedAt"
          FROM "Integration"."Batch" b
         WHERE b."JobName" = j."JobName" AND b."Status" = 'succeeded') last_ok ON true;

COMMENT ON VIEW "Integration"."JobHealth" IS
    'One row per enabled ExpectedJob: last run, last success, the latest business-day deadline '
    'and whether it was missed. Read hourly by the reports app (warehouse_load source).';
