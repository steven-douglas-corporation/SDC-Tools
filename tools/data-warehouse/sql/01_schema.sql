-- DataWarehouse (PostgreSQL): load tracking ("Integration") and the Paylocity raw layer
-- ("RawPaylocity").
--
-- Run against the "DataWarehouse" database as its owner (dw_loader). Safe to
-- re-run: every object uses IF NOT EXISTS or CREATE OR REPLACE, and nothing is
-- dropped or deleted.
--
--   psql "host=localhost port=5432 dbname=DataWarehouse user=dw_loader" -v ON_ERROR_STOP=1 -f 01_schema.sql
--
-- Naming: schemas, tables and columns are PascalCase, so every reference must
-- be double-quoted ("Integration"."SourceFile"."FileId"). Unquoted, Postgres lowercases
-- the name and won't find the object. Values (report keys, statuses) stay
-- lowercase; they're data, not names. Login roles (dw_loader) stay lowercase
-- so they work unquoted in connection strings.

CREATE SCHEMA IF NOT EXISTS "Integration";
CREATE SCHEMA IF NOT EXISTS "RawPaylocity";

-- One row per run of a load job.
CREATE TABLE IF NOT EXISTS "Integration"."Batch" (
    "BatchId"      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "JobName"      text        NOT NULL,
    "StartedAt"    timestamptz NOT NULL DEFAULT now(),
    "FinishedAt"   timestamptz,
    "Status"       text        NOT NULL DEFAULT 'running'
                               CHECK ("Status" IN ('running', 'succeeded', 'failed')),
    "Counts"       jsonb,
    "ErrorMessage" text,
    "RunBy"        text        NOT NULL DEFAULT current_user,
    "Host"         text        NOT NULL DEFAULT coalesce(inet_client_addr()::text, 'local')
);

-- One row per report (a file name with its version stamp removed). New reports
-- are added the first time a file for them arrives.
CREATE TABLE IF NOT EXISTS "Integration"."SourceReport" (
    "Source"      text        NOT NULL,
    "ReportKey"   text        NOT NULL,
    "LoadEnabled" boolean     NOT NULL DEFAULT true,
    "HeaderRow"   integer     NOT NULL DEFAULT 1 CHECK ("HeaderRow" >= 1),
    "FirstSeenAt" timestamptz NOT NULL DEFAULT now(),
    "Notes"       text,
    PRIMARY KEY ("Source", "ReportKey")
);

-- One row per file version copied from a source, followed through
-- downloaded -> remote delete -> loaded -> archived -> purged.
CREATE TABLE IF NOT EXISTS "Integration"."SourceFile" (
    "FileId"            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "BatchId"           bigint      NOT NULL REFERENCES "Integration"."Batch" ("BatchId"),
    "Source"            text        NOT NULL,
    "ReportKey"         text        NOT NULL,
    "RemotePath"        text        NOT NULL,
    "RemoteSize"        bigint      NOT NULL,
    "RemoteModifiedUtc" timestamp   NOT NULL,          -- naive UTC, as the server reports it
    "Sha256"            char(64)    NOT NULL,
    "LocalPath"         text        NOT NULL,          -- incoming, then archive
    "Status"            text        NOT NULL
                        CHECK ("Status" IN ('downloaded', 'loaded', 'duplicate', 'skipped', 'failed')),
    "DuplicateOfFileId" bigint      REFERENCES "Integration"."SourceFile" ("FileId"),
    "RowsLoaded"        integer,
    "ErrorMessage"      text,
    "DownloadedAt"      timestamptz NOT NULL DEFAULT now(),
    "RemoteDeletedAt"   timestamptz,
    "LoadedAt"          timestamptz,
    "ArchivedAt"        timestamptz,
    "PurgedAt"          timestamptz,
    FOREIGN KEY ("Source", "ReportKey") REFERENCES "Integration"."SourceReport" ("Source", "ReportKey")
);

CREATE INDEX IF NOT EXISTS "IX_SourceFile_Version"
    ON "Integration"."SourceFile" ("Source", "RemotePath", "RemoteSize", "RemoteModifiedUtc");
CREATE INDEX IF NOT EXISTS "IX_SourceFile_Sha256" ON "Integration"."SourceFile" ("Source", "Sha256");
CREATE INDEX IF NOT EXISTS "IX_SourceFile_Status"
    ON "Integration"."SourceFile" ("Source", "Status", "ReportKey", "RemoteModifiedUtc");

-- Every non-blank row of every sheet of every loaded Paylocity file. Rows above
-- the header are 'preamble' and the header itself is 'header' (JSON arrays, as
-- in the sheet); rows below are 'data' (JSON objects keyed by the sheet's own
-- header text, blank cells left out).
CREATE TABLE IF NOT EXISTS "RawPaylocity"."FileRow" (
    "FileId"    bigint  NOT NULL REFERENCES "Integration"."SourceFile" ("FileId"),
    "SheetName" text    NOT NULL,
    "SheetRow"  integer NOT NULL,
    "RowKind"   text    NOT NULL CHECK ("RowKind" IN ('preamble', 'header', 'data')),
    "RowJson"   jsonb   NOT NULL,
    PRIMARY KEY ("FileId", "SheetName", "SheetRow")
);

-- The newest loaded file of each Paylocity report.
CREATE OR REPLACE VIEW "RawPaylocity"."LatestFile" AS
SELECT "ReportKey", "FileId", "RemotePath", "RemoteModifiedUtc", "RowsLoaded", "LoadedAt"
FROM (
    SELECT f."ReportKey", f."FileId", f."RemotePath", f."RemoteModifiedUtc", f."RowsLoaded", f."LoadedAt",
           row_number() OVER (PARTITION BY f."ReportKey"
                              ORDER BY f."RemoteModifiedUtc" DESC, f."FileId" DESC) AS "Newest"
    FROM "Integration"."SourceFile" AS f
    WHERE f."Source" = 'paylocity' AND f."Status" = 'loaded'
) AS ranked
WHERE "Newest" = 1;

-- Data rows joined to the file they came from: the start of typed staging,
-- e.g. "RowJson" ->> 'Employee Id'.
CREATE OR REPLACE VIEW "RawPaylocity"."DataRow" AS
SELECT f."ReportKey", f."FileId", f."RemotePath", f."RemoteModifiedUtc",
       r."SheetName", r."SheetRow", r."RowJson"
FROM "RawPaylocity"."FileRow" AS r
JOIN "Integration"."SourceFile" AS f ON f."FileId" = r."FileId"
WHERE r."RowKind" = 'data';
