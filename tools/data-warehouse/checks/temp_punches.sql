-- Checks for the temp punches feed ("Temp Punches.xls", report key temp_punches).
-- Read-only. In pgAdmin, run one statement at a time: select it, press F5.
--
-- The "expect" figures are a BASELINE for the file as of 2026-10-22 04:04 (FileId 428).
-- The file grows every day, so later numbers will be higher; what must not change is the
-- relationship between the numbers (fact = staging, no unparsed rows, no missing keys).

-- 1. The latest file, and how old it is. Alert when it is more than about 2 days old:
--    the load keeps serving the last file it loaded if the report stops arriving.
SELECT l."FileId", l."RemotePath", l."RemoteModifiedUtc", l."RowsLoaded",
       (now() AT TIME ZONE 'utc') - l."RemoteModifiedUtc" AS "Age"
FROM "RawPaylocity"."LatestFile" AS l
WHERE l."ReportKey" = 'temp_punches';

-- 2. Header drift: keys the staging view reads that the latest file no longer has.
--    Expect NO rows. A row here means Paylocity renamed or dropped a column, and the
--    matching value is silently NULL in "Paylocity"."TempPunch" until the view is updated.
--    Note the double spaces in two of the names: they are in the file.
WITH expected (key) AS (
    VALUES ('Last Name'), ('Preferred / First Name'), ('Work Date'), ('Punch In Time'), ('Punch Out Time'),
           ('Regular Duration  (Hours)'), ('OT1 Duration (Hours)'), ('Jobs'), ('Jobs Name'), ('MachineSec'), ('Function')
),
seen AS (
    SELECT DISTINCT k.key
    FROM "RawPaylocity"."DataRow" AS d
    JOIN "RawPaylocity"."LatestFile" AS l USING ("FileId")
    CROSS JOIN LATERAL jsonb_object_keys(d."RowJson") AS k (key)
    WHERE d."ReportKey" = 'temp_punches'
)
SELECT e.key AS "MissingKey" FROM expected AS e LEFT JOIN seen AS s USING (key) WHERE s.key IS NULL;

-- 3. Columns in the file that nothing reads yet. Informational. When HR adds the Employee
--    Id column it shows up here as 'Employee Id' / 'Employee ID' (the view already reads both).
WITH known (key) AS (
    VALUES ('Last Name'), ('Preferred / First Name'), ('Work Date'), ('Punch In Time'), ('Punch Out Time'),
           ('Punch In Time (Rounded)'), ('Punch Out Time  (Rounded)'), ('Regular Duration  (Hours)'),
           ('OT1 Duration (Hours)'), ('Jobs'), ('Jobs Name'), ('Function'), ('Function Name'),
           ('MachineSec'), ('MachineSec Name')
)
SELECT DISTINCT k.key AS "UnreadKey"
FROM "RawPaylocity"."DataRow" AS d
JOIN "RawPaylocity"."LatestFile" AS l USING ("FileId")
CROSS JOIN LATERAL jsonb_object_keys(d."RowJson") AS k (key)
WHERE d."ReportKey" = 'temp_punches' AND k.key NOT IN (SELECT key FROM known);

-- 4. Values the view could not read. Expect zeros in every column.
SELECT count(*)                                                AS "Rows",
       count(*) FILTER (WHERE "WorkDate" IS NULL)              AS "NoDate",
       count(*) FILTER (WHERE "PunchIn" IS NULL)               AS "NoPunchIn",
       count(*) FILTER (WHERE "Hours" IS NULL)                 AS "NoHours",
       count(*) FILTER (WHERE "EmployeeName" IS NULL)          AS "NoName"
FROM "Paylocity"."TempPunch";

-- 5. Staging and the fact agree. Expect equal pairs. (Baseline 2026-10-22: 679 rows, 2869.67 h.)
SELECT (SELECT count(*) FROM "Fact"."JobHours" WHERE "SourceReport" = 'temp_punches')               AS "FactRows",
       (SELECT count(*) FROM "Paylocity"."TempPunch" WHERE "Hours" <> 0 AND "WorkDate" IS NOT NULL) AS "StagingRows",
       (SELECT round(sum("Hours"), 2) FROM "Fact"."JobHours" WHERE "SourceReport" = 'temp_punches') AS "FactHours",
       (SELECT round(sum("Hours"), 2) FROM "Paylocity"."TempPunch" WHERE "Hours" <> 0 AND "WorkDate" IS NOT NULL) AS "StagingHours";

-- 6. Hours by month: what has a job and a phase, and what does not.
--    Baseline 2026-10-22: 06 40.00 | 07 444.32 | 08 584.89 | 09 880.59 + 57.85 | 10 685.92 + 176.10.
--    The "missing" column is the list HR fixes in Paylocity.
SELECT to_char("WorkDate", 'YYYY-MM') AS "Month",
       round(coalesce(sum("Hours") FILTER (WHERE "JobCode" IS NOT NULL AND "SectionCode" IS NOT NULL AND "FunctionCode" IS NOT NULL), 0), 2) AS "Resolvable",
       round(coalesce(sum("Hours") FILTER (WHERE "JobCode" IS NULL OR "SectionCode" IS NULL OR "FunctionCode" IS NULL), 0), 2)                AS "MissingJobOrPhase"
FROM "Paylocity"."TempPunch"
GROUP BY 1 ORDER BY 1;

-- 7. Hours by person. Baseline 2026-10-22: 8 people, 2869.67 h in total.
SELECT "EmployeeName", "EmployeeId", round(sum("Hours"), 2) AS "Hours", min("WorkDate") AS "First", max("WorkDate") AS "Last"
FROM "Paylocity"."TempPunch"
GROUP BY 1, 2 ORDER BY 1;

-- 8. Punches with no Out (still open, or a missed punch). They carry 0 hours until Paylocity
--    closes them. Baseline 2026-10-22: 8.
SELECT "EmployeeName", "WorkDate", "PunchIn", "JobCode", "FunctionCode", "SheetRow"
FROM "Paylocity"."TempPunch" WHERE "IsOpen" ORDER BY "WorkDate", "EmployeeName";

-- 9. Rows with hours but no job, section or function: what the reports app lists under
--    Undefined Hours and on the Data Management tab. Person, day, times, what is missing.
SELECT "EmployeeName", "WorkDate", "PunchIn", "PunchOut", "Hours",
       CASE WHEN "JobCode" IS NULL THEN 'no job' END AS "NoJob",
       CASE WHEN "SectionCode" IS NULL THEN 'no phase' END AS "NoPhase",
       CASE WHEN "FunctionCode" IS NULL THEN 'no function' END AS "NoFunction",
       "SheetRow"
FROM "Paylocity"."TempPunch"
WHERE "Hours" <> 0 AND ("JobCode" IS NULL OR "SectionCode" IS NULL OR "FunctionCode" IS NULL)
ORDER BY "EmployeeName", "WorkDate", "PunchIn";

-- 10. Double-count watch. Someone in both the temp report and a Job Hours report on the same
--     day, matched by Employee Id. Expect NO rows. This can only find anything once the temp
--     report carries an Employee Id: until then "EmployeeId" is NULL and nothing matches.
SELECT t."EmployeeId", t."WorkDate", sum(t."Hours") AS "TempHours", sum(o."Hours") AS "JobHoursHours"
FROM "Fact"."JobHours" AS t
JOIN "Fact"."JobHours" AS o
  ON o."EmployeeId" = t."EmployeeId" AND o."WorkDate" = t."WorkDate" AND o."SourceReport" <> 'temp_punches'
WHERE t."SourceReport" = 'temp_punches' AND t."EmployeeId" IS NOT NULL
GROUP BY 1, 2 ORDER BY 2, 1;
