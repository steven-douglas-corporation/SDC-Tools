-- DataWarehouse (PostgreSQL): facts, and the refresh that loads every
-- dimension and fact.
--
-- Run after 03_dimensions.sql, as the database owner. Safe to re-run: tables
-- are only created when missing, and functions are CREATE OR REPLACE.

CREATE SCHEMA IF NOT EXISTS "Fact";

-- ── Job hours ───────────────────────────────────────────────────────────────
-- Grain: one Paylocity punch row (employee, work date, job, section, function,
-- travel) as delivered. Punches have no ID in Paylocity, so loads replace whole
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

-- Replace every year present in staging with what staging holds now.
-- Each punch gets the employee version in effect on its work date; punches
-- dated before the employee history starts get the employee's earliest
-- version, and punches for an employee missing from every roster get -1.
CREATE OR REPLACE FUNCTION "Fact"."LoadJobHours"() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    n_deleted  int;
    n_inserted int;
    years      int[];
BEGIN
    SELECT array_agg(DISTINCT extract(year FROM "WorkDate")::int ORDER BY extract(year FROM "WorkDate")::int)
    INTO years
    FROM "Paylocity"."JobHours" WHERE "WorkDate" IS NOT NULL;

    DELETE FROM "Fact"."JobHours" WHERE "WorkYear" = ANY (years);
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

    RETURN jsonb_build_object('years_replaced', years, 'rows_removed', n_deleted, 'rows_loaded', n_inserted);
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
