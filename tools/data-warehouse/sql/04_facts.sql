-- DataWarehouse (PostgreSQL): facts, and the refresh that loads every
-- dimension and fact.
--
-- Run after 03_dimensions.sql, as the database owner. Safe to re-run: tables
-- are only created when missing, and functions are CREATE OR REPLACE.

CREATE SCHEMA IF NOT EXISTS "Fact";

-- ── Job hours ───────────────────────────────────────────────────────────────
-- Grain: one Paylocity punch row (employee, work date, job, section, function,
-- travel) as delivered, plus the migration snapshot unpivoted to one row per job
-- and section-function (lifetime hours through 2025-01-31; Employee = Unknown,
-- WorkDate = 2025-01-31; see LoadJobHours). Vertical: one hours value per row. Punches have no ID in Paylocity, so loads replace whole
-- years rather than upserting rows: a punch edited or deleted in Paylocity is
-- simply different in the next file, and replacing the year picks that up.

CREATE TABLE IF NOT EXISTS "Fact"."JobHours" (
    "JobHoursId"     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "DateKey"        integer     NOT NULL REFERENCES "Dimension"."Date" ("DateKey"),
    "EmployeeKey"    bigint      NOT NULL REFERENCES "Dimension"."Employee" ("EmployeeKey"),
    "EmployeeId"     text,                    -- Paylocity Employee Id, kept even when unmatched
    "WorkDate"       date        NOT NULL,
    "WorkYear"       integer     NOT NULL,    -- the replace window
    "JobCode"        text,                    -- as in Paylocity: '0114', '2025 SERVICE', 'Not Defined'
    "JobNumber"      text,                    -- digits-only codes without leading zeros; NULL otherwise
    "JobName"        text,
    "SectionCode"    text,
    "SectionNumber"  integer,
    "FunctionCode"   text,
    "FunctionNumber" integer,
    "TravelCode"     text,                    -- as in Paylocity
    "TravelLocation" text,                    -- 'Not Defined' -> Concord, 'TRAVEL' -> Travel (the Power BI rule)
    "Hours"          numeric     NOT NULL,
    "SourceReport"   text        NOT NULL,
    "SourceFileId"   bigint      NOT NULL,
    "SourceSheetRow" integer     NOT NULL,
    "LoadedAt"       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "IX_JobHours_DateKey"     ON "Fact"."JobHours" ("DateKey");
CREATE INDEX IF NOT EXISTS "IX_JobHours_EmployeeKey" ON "Fact"."JobHours" ("EmployeeKey");
CREATE INDEX IF NOT EXISTS "IX_JobHours_JobNumber"   ON "Fact"."JobHours" ("JobNumber");
CREATE INDEX IF NOT EXISTS "IX_JobHours_WorkYear"    ON "Fact"."JobHours" ("WorkYear");

-- Punches already counted inside the migration snapshot: January 2025 punches on
-- jobs the snapshot covers (see LoadJobHours). Kept, not deleted, exactly as the
-- reports app does (actual-hours.ts, supersededBySnapshot / OUTSIDE_SNAPSHOT).
-- Totals: sum("Hours") WHERE NOT "SupersededBySnapshot".
ALTER TABLE "Fact"."JobHours" ADD COLUMN IF NOT EXISTS "SupersededBySnapshot" boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "IX_JobHours_SourceReport" ON "Fact"."JobHours" ("SourceReport");

-- Replace every year present in staging with what staging holds now.
-- Each punch gets the employee version in effect on its work date; punches
-- dated before the employee history starts get the employee's earliest
-- version, and punches for an employee missing from every roster get -1.
CREATE OR REPLACE FUNCTION "Fact"."LoadJobHours"() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    snapshot_through constant date := date '2025-01-31';   -- the reports app's SNAPSHOT_THROUGH_MONTH '2025-01'
    n_deleted   int;
    n_inserted  int;
    n_snapshot  int;
    n_flagged   int;
    years       int[];
BEGIN
    -- Punches: replace every year present in staging, for the punch sources only.
    SELECT array_agg(DISTINCT extract(year FROM "WorkDate")::int ORDER BY extract(year FROM "WorkDate")::int)
    INTO years
    FROM "Paylocity"."JobHours" WHERE "WorkDate" IS NOT NULL;

    DELETE FROM "Fact"."JobHours"
    WHERE "WorkYear" = ANY (years)
      AND "SourceReport" IN (SELECT "ReportKey" FROM "Paylocity"."JobHoursSource");
    GET DIAGNOSTICS n_deleted = ROW_COUNT;

    INSERT INTO "Fact"."JobHours"
        ("DateKey", "EmployeeKey", "EmployeeId", "WorkDate", "WorkYear", "JobCode", "JobNumber", "JobName",
         "SectionCode", "SectionNumber", "FunctionCode", "FunctionNumber", "TravelCode", "TravelLocation",
         "Hours", "SourceReport", "SourceFileId", "SourceSheetRow")
    SELECT coalesce(dd."DateKey", -1),
           coalesce(emp."EmployeeKey", -1),
           h."EmployeeId",
           h."WorkDate",
           extract(year FROM h."WorkDate")::int,
           h."JobCode", h."JobNumber", h."JobName",
           h."SectionCode", h."SectionNumber", h."FunctionCode", h."FunctionNumber",
           h."Travel",
           CASE WHEN upper(h."Travel") = 'TRAVEL' THEN 'Travel'
                WHEN h."Travel" = 'Not Defined'   THEN 'Concord'
                ELSE h."Travel" END,
           h."Hours",
           h."SourceReport", h."FileId", h."SheetRow"
    FROM "Paylocity"."JobHours" AS h
    LEFT JOIN "Dimension"."Date" AS dd ON dd."Date" = h."WorkDate"
    LEFT JOIN LATERAL (
        SELECT e."EmployeeKey"
        FROM "Dimension"."Employee" AS e
        WHERE e."EmployeeId" = h."EmployeeId" AND e."EmployeeKey" > 0
        ORDER BY (e."ValidFrom"::date <= h."WorkDate") DESC,                          -- versions in effect by then first
                 CASE WHEN e."ValidFrom"::date <= h."WorkDate" THEN e."ValidFrom" END DESC NULLS LAST,  -- the latest of those
                 e."ValidFrom"                                                         -- otherwise the earliest
        LIMIT 1
    ) AS emp ON true
    WHERE h."WorkDate" IS NOT NULL AND h."Hours" IS NOT NULL;
    GET DIAGNOSTICS n_inserted = ROW_COUNT;

    -- Migration snapshot (Hours Through 20250131.xlsx), already unpivoted by the staging
    -- view "Paylocity"."JobHoursSnapshot": lifetime hours per job and section-function
    -- through 2025-01-31, from before the punch feed. The source has no employee and no
    -- date, so Employee = Unknown (-1) and WorkDate = 2025-01-31 (Jon, 2026-10-04; Power BI
    -- did the same: Employee 0, Date 20250131). Replaced whole on every refresh.
    DELETE FROM "Fact"."JobHours" WHERE "SourceReport" = 'hours_through_20250131';
    INSERT INTO "Fact"."JobHours"
        ("DateKey", "EmployeeKey", "EmployeeId", "WorkDate", "WorkYear", "JobCode", "JobNumber", "JobName",
         "SectionCode", "SectionNumber", "FunctionCode", "FunctionNumber", "Hours",
         "SourceReport", "SourceFileId", "SourceSheetRow")
    SELECT to_char(s."ThroughDate", 'YYYYMMDD')::int, -1, NULL, s."ThroughDate", extract(year FROM s."ThroughDate")::int,
           s."JobCode", s."JobNumber", s."JobName",
           s."SectionCode", s."SectionNumber", s."FunctionCode", s."FunctionNumber", s."Hours",
           'hours_through_20250131', s."FileId", s."SheetRow"
    FROM "Paylocity"."JobHoursSnapshot" AS s;
    GET DIAGNOSTICS n_snapshot = ROW_COUNT;

    -- No double counting, the reports app's rule (actual-hours.ts, 2026-09-28): the
    -- snapshot already contains January 2025, and the punch feed starts 2025-01-06. So a
    -- punch dated on or before the snapshot's month counts only when its job has NO
    -- non-zero snapshot row. Per job, not per section: a 0 in the crosstab means no hours
    -- were booked there. Jobs the snapshot doesn't cover keep their January punches,
    -- since they're the only record of that work (Power BI's flat 2025-02-01 cut-over
    -- dropped them). Rows are flagged, not deleted.
    UPDATE "Fact"."JobHours" AS f
    SET "SupersededBySnapshot" = coalesce(f."SourceReport" <> 'hours_through_20250131'
                                  AND f."WorkDate" <= snapshot_through
                                  AND f."JobNumber" IN (SELECT "JobNumber" FROM "Paylocity"."JobHoursSnapshot"
                                                        WHERE "JobNumber" IS NOT NULL), false)  -- no job number: not superseded
    WHERE f."WorkYear" <= extract(year FROM snapshot_through)::int;
    SELECT count(*) INTO n_flagged FROM "Fact"."JobHours" WHERE "SupersededBySnapshot";

    RETURN jsonb_build_object('years_replaced', years, 'rows_removed', n_deleted, 'rows_loaded', n_inserted,
                              'snapshot_rows', n_snapshot, 'punches_superseded_by_snapshot', n_flagged);
END;
$$;

-- ── Refresh ─────────────────────────────────────────────────────────────────
-- Dimensions first, then facts (facts look up dimension keys). Called by the
-- loader at the end of each run, in one transaction: if anything fails, the
-- warehouse keeps its previous state.
CREATE OR REPLACE FUNCTION "Integration"."RefreshWarehouse"() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    employee  jsonb;
    job_hours jsonb;
BEGIN
    employee  := "Dimension"."LoadEmployee"();
    job_hours := "Fact"."LoadJobHours"();
    RETURN jsonb_build_object('employee', employee, 'job_hours', job_hours);
END;
$$;
