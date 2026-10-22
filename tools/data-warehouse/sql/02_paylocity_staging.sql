-- DataWarehouse (PostgreSQL): Paylocity staging. One typed view per report, built
-- from the raw rows in "RawPaylocity"."FileRow".
--
-- Run after 01_schema.sql, as the database owner. Safe to re-run: functions and
-- views are CREATE OR REPLACE, the settings table is IF NOT EXISTS, and its seed
-- rows are only inserted when missing.
--
--   psql "host=localhost port=5432 dbname=DataWarehouse user=dw_loader" -v ON_ERROR_STOP=1 -f 02_paylocity_staging.sql
--
-- Staging stays faithful to the source: it converts text to proper types and
-- parses codes, but makes no business decisions. Matching jobs to Total ETO,
-- relabelling Travel, and applying position-family overrides happen in the
-- dimension and fact layers. Codes keep their original text next to the parsed
-- number, so nothing is lost.
--
-- Every view carries "FileId" and "SnapshotUtc" (when Paylocity produced the
-- file), so any row traces back to "Integration"."SourceFile".

CREATE SCHEMA IF NOT EXISTS "Paylocity";

-- ── Conversion helpers ──────────────────────────────────────────────────────
-- Each returns NULL for a value it can't convert, rather than failing the query.

CREATE OR REPLACE FUNCTION "Integration"."TryNumeric"(value text) RETURNS numeric
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT CASE WHEN pg_input_is_valid(btrim(value), 'numeric') THEN btrim(value)::numeric END
$$;

CREATE OR REPLACE FUNCTION "Integration"."TryTimestamp"(value text) RETURNS timestamp
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT CASE WHEN pg_input_is_valid(btrim(value), 'timestamp') THEN btrim(value)::timestamp END
$$;

CREATE OR REPLACE FUNCTION "Integration"."TryDate"(value text) RETURNS date
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT "Integration"."TryTimestamp"(value)::date
$$;

-- A clock time as text ('08:00 AM', '04:30 PM', '13:05') -> time of day.
CREATE OR REPLACE FUNCTION "Integration"."TryTime"(value text) RETURNS time
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT CASE WHEN pg_input_is_valid(btrim(value), 'time') THEN btrim(value)::time END
$$;

-- 'Yes' / 'No' (any case) -> true / false; anything else -> NULL.
CREATE OR REPLACE FUNCTION "Integration"."YesNo"(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE lower(btrim(value)) WHEN 'yes' THEN true WHEN 'no' THEN false END
$$;

-- A section or function code as a number: '10' -> 10, '010 - Complete Design & Build' -> 10.
-- 'Not Defined', blanks and anything else that isn't a number -> NULL.
-- Same rule as the reports app's normalizeSectionId / normalizeFunctionId.
CREATE OR REPLACE FUNCTION "Integration"."CodeNumber"(value text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE WHEN btrim(split_part(btrim(value), '-', 1)) ~ '^[0-9]{1,9}$'
                THEN btrim(split_part(btrim(value), '-', 1))::integer END
$$;

-- A job number with leading zeros removed: '0114' -> '114'. Only for codes that are
-- all digits; named categories ('2025 SERVICE', 'Not Defined') and machine-suffixed
-- codes ('1037-02') return NULL and are resolved against the job master later.
CREATE OR REPLACE FUNCTION "Integration"."JobNumber"(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE WHEN btrim(value) ~ '^[0-9]+$'
                THEN coalesce(nullif(ltrim(btrim(value), '0'), ''), '0') END
$$;

-- ── Employees ───────────────────────────────────────────────────────────────

-- Every daily snapshot of the roster: the history a slowly-changing employee
-- dimension is built from.
CREATE OR REPLACE VIEW "Paylocity"."EmployeeInformationSnapshot" AS
SELECT
    nullif(btrim(d."RowJson" ->> 'Employee Id'), '')              AS "EmployeeId",
    nullif(btrim(d."RowJson" ->> 'First Name'), '')               AS "FirstName",
    nullif(btrim(d."RowJson" ->> 'Last Name'), '')                AS "LastName",
    nullif(btrim(d."RowJson" ->> 'Job Title'), '')                AS "JobTitle",
    nullif(btrim(d."RowJson" ->> 'Supervisor''s Employee ID'), '') AS "SupervisorEmployeeId",
    "Integration"."YesNo"(d."RowJson" ->> 'Is Active')            AS "IsActive",
    nullif(btrim(d."RowJson" ->> 'Position Code'), '')            AS "PositionCode",
    nullif(btrim(d."RowJson" ->> 'Position Job Title'), '')       AS "PositionJobTitle",
    d."FileId",
    d."RemoteModifiedUtc"                                         AS "SnapshotUtc",
    d."FileId" = l."FileId"                                       AS "IsLatest"
FROM "RawPaylocity"."DataRow" AS d
LEFT JOIN "RawPaylocity"."LatestFile" AS l ON l."ReportKey" = d."ReportKey"
WHERE d."ReportKey" = 'employee_information';

-- The current roster: the latest snapshot only.
CREATE OR REPLACE VIEW "Paylocity"."EmployeeInformation" AS
SELECT "EmployeeId", "FirstName", "LastName", "JobTitle", "SupervisorEmployeeId", "IsActive",
       "PositionCode", "PositionJobTitle", "FileId", "SnapshotUtc"
FROM "Paylocity"."EmployeeInformationSnapshot"
WHERE "IsLatest";

-- ── Position families ───────────────────────────────────────────────────────

CREATE OR REPLACE VIEW "Paylocity"."PositionFamily" AS
SELECT
    nullif(btrim(d."RowJson" ->> 'Family Code'), '')            AS "FamilyCode",
    nullif(btrim(d."RowJson" ->> 'Family Name'), '')            AS "FamilyName",
    nullif(btrim(d."RowJson" ->> 'Position Code'), '')          AS "PositionCode",
    nullif(btrim(d."RowJson" ->> 'Title'), '')                  AS "Title",
    "Integration"."TryNumeric"(d."RowJson" ->> 'Total Headcount')::integer AS "TotalHeadcount",
    d."FileId",
    d."RemoteModifiedUtc"                                       AS "SnapshotUtc"
FROM "RawPaylocity"."DataRow" AS d
JOIN "RawPaylocity"."LatestFile" AS l USING ("FileId")
WHERE d."ReportKey" = 'position_families';

-- Our hand-maintained overrides file, same layout. Applying it (an override row
-- replaces Paylocity's rows for its position code) happens in the dimension.
CREATE OR REPLACE VIEW "Paylocity"."PositionFamilyOverride" AS
SELECT
    nullif(btrim(d."RowJson" ->> 'Family Code'), '')            AS "FamilyCode",
    nullif(btrim(d."RowJson" ->> 'Family Name'), '')            AS "FamilyName",
    nullif(btrim(d."RowJson" ->> 'Position Code'), '')          AS "PositionCode",
    nullif(btrim(d."RowJson" ->> 'Title'), '')                  AS "Title",
    "Integration"."TryNumeric"(d."RowJson" ->> 'Total Headcount')::integer AS "TotalHeadcount",
    d."FileId",
    d."RemoteModifiedUtc"                                       AS "SnapshotUtc"
FROM "RawPaylocity"."DataRow" AS d
JOIN "RawPaylocity"."LatestFile" AS l USING ("FileId")
WHERE d."ReportKey" = 'position_families_overrides';

-- ── Temp and contractor punches ─────────────────────────────────────────────

-- Paylocity's PunchDetail report for the TEMPS group ("Temp Punches.xls"): four
-- preamble rows, then the header on sheet row 5. Temps are not in the Job Hours
-- report, which is why this exists. The loader keys each row by the sheet's own header
-- text, so a header Paylocity changes is a missing key here, not a shifted column;
-- checks/temp_punches.sql flags that. Two headers carry a double space in the file
-- ('Regular Duration  (Hours)', 'Punch Out Time  (Rounded)'); they are matched as written.
--
-- The header row is set here, before the first file lands or as a one-off re-assertion.
-- Changing it for files already loaded needs them reloaded: see the README.
INSERT INTO "Integration"."SourceReport" ("Source", "ReportKey", "HeaderRow", "Notes")
VALUES ('paylocity', 'temp_punches', 5, 'PunchDetail, group TEMPS: header on sheet row 5')
ON CONFLICT ("Source", "ReportKey") DO UPDATE SET "HeaderRow" = EXCLUDED."HeaderRow", "Notes" = EXCLUDED."Notes";

-- Every row of the latest file, typed, as delivered. Source-faithful: no year gate, no
-- dropping of lunch rows or open punches, so the Data Management checks can list them.
-- The report has no Employee Id column today. If Paylocity adds one, it arrives here
-- under either spelling with no change; until then "EmployeeId" is NULL and the reports
-- app matches the name to its own roster.
CREATE OR REPLACE VIEW "Paylocity"."TempPunch" AS
WITH row_ AS (
    SELECT d."RowJson", d."FileId", d."SheetRow", d."RemoteModifiedUtc"
    FROM "RawPaylocity"."DataRow" AS d
    JOIN "RawPaylocity"."LatestFile" AS l USING ("FileId")
    WHERE d."ReportKey" = 'temp_punches'
),
typed AS (
    SELECT
        r."FileId", r."SheetRow", r."RemoteModifiedUtc",
        nullif(btrim(r."RowJson" ->> 'Last Name'), '')                  AS "LastName",
        nullif(btrim(r."RowJson" ->> 'Preferred / First Name'), '')     AS "FirstName",
        coalesce(nullif(btrim(r."RowJson" ->> 'Employee Id'), ''),
                 nullif(btrim(r."RowJson" ->> 'Employee ID'), ''))      AS "EmployeeId",
        "Integration"."TryDate"(r."RowJson" ->> 'Work Date')            AS "WorkDate",
        "Integration"."TryTime"(r."RowJson" ->> 'Punch In Time')        AS "PunchIn",
        "Integration"."TryTime"(r."RowJson" ->> 'Punch Out Time')       AS "PunchOut",
        "Integration"."TryNumeric"(r."RowJson" ->> 'Regular Duration  (Hours)') AS "RegularHours",
        "Integration"."TryNumeric"(r."RowJson" ->> 'OT1 Duration (Hours)')      AS "OvertimeHours",
        nullif(btrim(r."RowJson" ->> 'Jobs'), '')                       AS "JobCode",
        nullif(btrim(r."RowJson" ->> 'Jobs Name'), '')                  AS "JobName",
        nullif(btrim(r."RowJson" ->> 'MachineSec'), '')                 AS "SectionCode",
        nullif(btrim(r."RowJson" ->> 'Function'), '')                   AS "FunctionCode"
    FROM row_ AS r
)
SELECT
    t."EmployeeId",
    t."LastName",
    t."FirstName",
    nullif(btrim(coalesce(t."FirstName", '') || ' ' || coalesce(t."LastName", '')), '') AS "EmployeeName",
    t."WorkDate",
    t."PunchIn",
    t."PunchOut",
    (t."PunchIn" IS NOT NULL AND t."PunchOut" IS NULL)                  AS "IsOpen",
    t."RegularHours",
    t."OvertimeHours",
    -- A punch's hours are its regular plus overtime duration. Paylocity reports 0 for
    -- a lunch gap and for a punch with no Out. No regular duration at all means the column
    -- was not read (a renamed header), which is "unknown", not "0 hours worked": NULL, so
    -- checks/temp_punches.sql counts it instead of the hours quietly reading as nothing.
    CASE WHEN t."RegularHours" IS NULL THEN NULL
         ELSE t."RegularHours" + coalesce(t."OvertimeHours", 0) END AS "Hours",
    t."JobCode",
    "Integration"."JobNumber"(t."JobCode")                              AS "JobNumber",
    t."JobName",
    t."SectionCode",
    "Integration"."CodeNumber"(t."SectionCode")                         AS "SectionNumber",
    t."FunctionCode",
    "Integration"."CodeNumber"(t."FunctionCode")                        AS "FunctionNumber",
    t."FileId",
    t."SheetRow",
    t."RemoteModifiedUtc"                                               AS "SnapshotUtc"
FROM typed AS t;

-- ── Job hours ───────────────────────────────────────────────────────────────

-- Which file is authoritative for which years of punches. The files overlap
-- (Job_Hours_2025 runs into the first days of 2026, the same punches
-- Current_Job_Hours carries), and a punch has no ID to de-duplicate on, so each
-- year has exactly one owning file. Same rule as the reports app's
-- paylocity-sources.ts. Next year's archive file is one new row here.
CREATE TABLE IF NOT EXISTS "Paylocity"."JobHoursSource" (
    "ReportKey" text    PRIMARY KEY,
    "FromYear"  integer,           -- NULL = open-ended into the past
    "ToYear"    integer,           -- NULL = open-ended into the future
    "Notes"     text,
    CHECK ("FromYear" IS NULL OR "ToYear" IS NULL OR "FromYear" <= "ToYear")
);

-- How a report lays its punches out. 'job_hours' is the Job Hours report (one row per
-- employee, day, job and code, with Total Hours Worked). 'punch_detail' is Paylocity's
-- PunchDetail report: one row per clock-in/clock-out, durations instead of a total, and
-- names instead of an Employee Id (see "Paylocity"."TempPunch").
ALTER TABLE "Paylocity"."JobHoursSource" ADD COLUMN IF NOT EXISTS "Layout" text NOT NULL DEFAULT 'job_hours'
    CHECK ("Layout" IN ('job_hours', 'punch_detail'));

INSERT INTO "Paylocity"."JobHoursSource" ("ReportKey", "FromYear", "ToYear", "Layout", "Notes") VALUES
    ('current_job_hours', 2026, NULL, 'job_hours',    'Live file, replaced daily; owns the current year onward'),
    ('job_hours_2025',    2025, 2025, 'job_hours',    'Closed 2025 archive; its January 2026 rows duplicate current_job_hours and are dropped'),
    ('temp_punches',      2026, NULL, 'punch_detail', 'Temp and contractor punches (PunchDetail, group TEMPS). Additive: Paylocity''s Job Hours report does not carry these people')
ON CONFLICT ("ReportKey") DO NOTHING;

-- Every punch from the latest version of each owning file, within its years.
-- Hours Through 20250131 is not here: it's lifetime totals by job and section,
-- with no dates or employees, so it isn't punch data.
--
-- Two layouts, one shape. The Job Hours files come first; the temp punches
-- ("Paylocity"."TempPunch") are projected onto the same columns below, minus the
-- zero-hour rows (lunch gaps, open punches), which add nothing to a total and are
-- still visible in TempPunch itself. "EmployeeName" is NULL for the Job Hours files,
-- which carry an Employee Id instead.
CREATE OR REPLACE VIEW "Paylocity"."JobHours" AS
WITH punch AS (
    SELECT d."ReportKey", d."FileId", d."RemoteModifiedUtc", d."SheetRow", d."RowJson",
           "Integration"."TryDate"(d."RowJson" ->> 'Work Date') AS "WorkDate",
           s."FromYear", s."ToYear"
    FROM "RawPaylocity"."DataRow" AS d
    JOIN "RawPaylocity"."LatestFile" AS l USING ("FileId")
    JOIN "Paylocity"."JobHoursSource" AS s ON s."ReportKey" = d."ReportKey" AND s."Layout" = 'job_hours'
)
SELECT
    nullif(btrim(p."RowJson" ->> 'Employee Id'), '')            AS "EmployeeId",
    p."WorkDate",
    nullif(btrim(p."RowJson" ->> 'Jobs'), '')                   AS "JobCode",
    "Integration"."JobNumber"(p."RowJson" ->> 'Jobs')           AS "JobNumber",
    nullif(btrim(p."RowJson" ->> 'Jobs Name'), '')              AS "JobName",
    nullif(btrim(p."RowJson" ->> 'MachineSec'), '')             AS "SectionCode",
    "Integration"."CodeNumber"(p."RowJson" ->> 'MachineSec')    AS "SectionNumber",
    nullif(btrim(p."RowJson" ->> 'Function'), '')               AS "FunctionCode",
    "Integration"."CodeNumber"(p."RowJson" ->> 'Function')      AS "FunctionNumber",
    "Integration"."TryNumeric"(p."RowJson" ->> 'Total Hours Worked') AS "Hours",
    nullif(btrim(p."RowJson" ->> 'Travel'), '')                 AS "Travel",
    p."ReportKey"                                               AS "SourceReport",
    p."FileId",
    p."SheetRow",
    p."RemoteModifiedUtc"                                       AS "SnapshotUtc",
    NULL::text                                                  AS "EmployeeName"
FROM punch AS p
WHERE extract(year FROM p."WorkDate") >= coalesce(p."FromYear", -1)
  AND extract(year FROM p."WorkDate") <= coalesce(p."ToYear", 9999)
UNION ALL
SELECT
    t."EmployeeId", t."WorkDate", t."JobCode", t."JobNumber", t."JobName",
    t."SectionCode", t."SectionNumber", t."FunctionCode", t."FunctionNumber",
    t."Hours",
    NULL::text                                                  AS "Travel",
    'temp_punches'                                              AS "SourceReport",
    t."FileId", t."SheetRow", t."SnapshotUtc", t."EmployeeName"
FROM "Paylocity"."TempPunch" AS t
JOIN "Paylocity"."JobHoursSource" AS s ON s."ReportKey" = 'temp_punches' AND s."Layout" = 'punch_detail'
WHERE t."Hours" IS NOT NULL AND t."Hours" <> 0
  AND extract(year FROM t."WorkDate") >= coalesce(s."FromYear", -1)
  AND extract(year FROM t."WorkDate") <= coalesce(s."ToYear", 9999);

-- ── Paid expenses ───────────────────────────────────────────────────────────

-- Each daily file is a rolling window (about ten weeks of paid dates), so the
-- full history is every file combined, with the overlap between consecutive
-- files removed. Expense lines have no ID, so a line is identified by its full
-- content plus how many times that identical line appears within one file: two
-- genuinely identical lines in one file are kept as two, while the same line
-- repeated across daily files counts once.
CREATE OR REPLACE VIEW "Paylocity"."PaidExpense" AS
WITH line AS (
    SELECT d."FileId", d."RemoteModifiedUtc", d."RowJson",
           row_number() OVER (PARTITION BY d."FileId", d."RowJson" ORDER BY d."SheetRow") AS "Occurrence"
    FROM "RawPaylocity"."DataRow" AS d
    WHERE d."ReportKey" = 'paid_expenses_dsb'
),
distinct_line AS (
    SELECT DISTINCT ON ("RowJson", "Occurrence")
           "RowJson", "Occurrence", "FileId", "RemoteModifiedUtc",
           min("RemoteModifiedUtc") OVER (PARTITION BY "RowJson", "Occurrence") AS "FirstSeenUtc"
    FROM line
    ORDER BY "RowJson", "Occurrence", "RemoteModifiedUtc" DESC, "FileId" DESC
)
SELECT
    "Integration"."TryTimestamp"(l."RowJson" ->> 'Date Submitted')  AS "SubmittedAt",
    "Integration"."TryTimestamp"(l."RowJson" ->> 'Date Approved')   AS "ApprovedAt",
    "Integration"."TryDate"(l."RowJson" ->> 'Date Paid')            AS "PaidDate",
    nullif(btrim(l."RowJson" ->> 'Expense Report Status'), '')      AS "Status",
    nullif(btrim(l."RowJson" ->> 'Employee Id'), '')                AS "EmployeeId",
    nullif(btrim(l."RowJson" ->> 'Preferred/First Name'), '')       AS "FirstName",
    nullif(btrim(l."RowJson" ->> 'Last Name'), '')                  AS "LastName",
    nullif(btrim(l."RowJson" ->> 'Expense Report Job Code'), '')    AS "JobCode",
    "Integration"."JobNumber"(l."RowJson" ->> 'Expense Report Job Code') AS "JobNumber",
    nullif(btrim(l."RowJson" ->> 'Section # Code'), '')             AS "SectionCode",
    "Integration"."CodeNumber"(l."RowJson" ->> 'Section # Code')    AS "SectionNumber",
    nullif(btrim(l."RowJson" ->> 'Function Code'), '')              AS "FunctionCode",
    "Integration"."CodeNumber"(l."RowJson" ->> 'Function Code')     AS "FunctionNumber",
    nullif(btrim(l."RowJson" ->> 'Expense Report Name'), '')        AS "ExpenseReportName",
    nullif(btrim(l."RowJson" ->> 'Expense Title'), '')              AS "ExpenseTitle",
    "Integration"."TryNumeric"(l."RowJson" ->> 'Expense Amount')    AS "Amount",
    "Integration"."TryDate"(l."RowJson" ->> 'Transaction Date')     AS "TransactionDate",
    nullif(btrim(l."RowJson" ->> 'Expense Comment(s)'), '')         AS "Comment",
    l."FileId"                                                      AS "LastSeenFileId",
    l."FirstSeenUtc",
    l."RemoteModifiedUtc"                                           AS "LastSeenUtc"
FROM distinct_line AS l;

-- ── Hiring ──────────────────────────────────────────────────────────────────

-- Open positions in Paylocity Recruiting, from the latest file.
CREATE OR REPLACE VIEW "Paylocity"."HiringPosition" AS
SELECT
    nullif(btrim(d."RowJson" ->> 'Job ID'), '')                     AS "HiringJobId",
    nullif(btrim(d."RowJson" ->> 'Job Title'), '')                  AS "JobTitle",
    nullif(btrim(d."RowJson" ->> 'Hiring Department'), '')          AS "HiringDepartment",
    nullif(btrim(d."RowJson" ->> 'Hiring Managers'), '')            AS "HiringManagers",
    nullif(btrim(d."RowJson" ->> 'Team Members'), '')               AS "TeamMembers",
    nullif(btrim(d."RowJson" ->> 'Job Status'), '')                 AS "JobStatus",
    nullif(nullif(btrim(d."RowJson" ->> 'Job Sub Status'), ''), 'None') AS "JobSubStatus",
    "Integration"."TryTimestamp"(d."RowJson" ->> 'Job Published Date') AS "PublishedAt",
    d."FileId",
    d."RemoteModifiedUtc"                                           AS "SnapshotUtc"
FROM "RawPaylocity"."DataRow" AS d
JOIN "RawPaylocity"."LatestFile" AS l USING ("FileId")
WHERE d."ReportKey" = 'hiring_report_auto_export';

-- ── Migration snapshot: hours before Paylocity ──────────────────────────────

-- Hours Through 20250131.xlsx: lifetime hours per job and section-function,
-- through 2025-01-31, from before the Paylocity punch feed. A crosstab, one row
-- per job and one column per code, so it's unpivoted here into one row per job
-- and code. Only the "All Job Data" sheet is read: its "Old" sheet is a subset of
-- it (all 348 values identical, checked 2026-10-04), and reading both would count
-- 58,341 h twice. The codes ("10-211") are in the sheet's second header row, which
-- the loader stores as the first data row (SheetRow 2). Zero cells are dropped:
-- in this crosstab a zero means no hours booked, not a missing value.
CREATE OR REPLACE VIEW "Paylocity"."JobHoursSnapshot" AS
WITH snapshot_file AS (
    SELECT "FileId", "RemoteModifiedUtc"
    FROM "RawPaylocity"."LatestFile"
    WHERE "ReportKey" = 'hours_through_20250131'
),
code AS (
    SELECT c.key AS "ColumnName", btrim(c.value #>> '{}') AS "Code"
    FROM "RawPaylocity"."FileRow" AS r
    JOIN snapshot_file AS f USING ("FileId")
    CROSS JOIN LATERAL jsonb_each(r."RowJson") AS c
    WHERE r."SheetName" = 'All Job Data' AND r."SheetRow" = 2
),
cell AS (
    SELECT r."FileId", r."SheetRow", f."RemoteModifiedUtc",
           nullif(btrim(r."RowJson" ->> 'Job#'), '')        AS "JobCode",
           nullif(btrim(r."RowJson" ->> 'Description'), '') AS "JobName",
           c.key AS "ColumnName", c.value #>> '{}' AS "Value"
    FROM "RawPaylocity"."FileRow" AS r
    JOIN snapshot_file AS f USING ("FileId")
    CROSS JOIN LATERAL jsonb_each(r."RowJson") AS c
    WHERE r."SheetName" = 'All Job Data' AND r."SheetRow" >= 3 AND r."RowKind" = 'data'
)
SELECT
    cell."JobCode",
    "Integration"."JobNumber"(cell."JobCode")                    AS "JobNumber",
    cell."JobName",
    code."Code"                                                  AS "SectionFunctionCode",
    split_part(code."Code", '-', 1)                              AS "SectionCode",
    "Integration"."CodeNumber"(split_part(code."Code", '-', 1))  AS "SectionNumber",
    split_part(code."Code", '-', 2)                              AS "FunctionCode",
    "Integration"."CodeNumber"(split_part(code."Code", '-', 2))  AS "FunctionNumber",
    "Integration"."TryNumeric"(cell."Value")                     AS "Hours",
    date '2025-01-31'                                            AS "ThroughDate",
    cell."FileId",
    cell."SheetRow",
    cell."RemoteModifiedUtc"                                     AS "SnapshotUtc"
FROM cell
JOIN code ON code."ColumnName" = cell."ColumnName"
WHERE code."Code" ~ '^[0-9]+-[0-9]+$'
  AND cell."JobCode" IS NOT NULL
  AND coalesce("Integration"."TryNumeric"(cell."Value"), 0) <> 0;
