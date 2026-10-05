# Data warehouse

Phase 1 of the data warehouse: Paylocity report files copied from the SFTP
server (SERVER-DC1, 10.0.0.6) into the `DataWarehouse` PostgreSQL database on
SERVER-APP1, once a day, and modelled into Kimball dimensions and facts. Later
phases add Total ETO (the job master) and the app databases.

What comes next (operations, the full model from Power BI, a measure catalog,
semantic search): [ROADMAP.md](ROADMAP.md).

```
sql/      01_schema.sql             tracking tables ("Integration") and raw layer ("RawPaylocity")
          02_paylocity_staging.sql  typed staging views ("Paylocity")
          03_dimensions.sql         "Dimension"."Date", "Dimension"."Employee" and its load
          04_facts.sql              "Fact"."JobHours", its load, and "Integration"."RefreshWarehouse"()
          05_access.sql             read-only login for the reports app (reports_app)
          (all safe to re-run; apply in order)
ingest/   paylocity_ingest.py, its settings and tests
```

Schemas are grouped by layer: raw schemas start with `Raw` (`"RawPaylocity"`, later
`"RawTotalEto"`), staging schemas are named after the source (`"Paylocity"`), and the
model is `"Dimension"` and `"Fact"`. It's all one database on purpose: Postgres can't
join across databases in a query.

## Layers

| Layer | Schema | What it holds |
|---|---|---|
| Raw | `"RawPaylocity"` | `"FileRow"`: every row of every file as delivered, as JSON keyed by the sheet's own headers. Never interpreted, so a new or changed report never breaks the load |
| Staging | `"Paylocity"` | One view per report, typed (dates, numbers, true/false) with parsed codes beside the original text. Source-faithful: no business rules beyond picking the authoritative file for each year of hours |
| Dimensions | `"Dimension"` | `"Date"` (2015–2035) and `"Employee"`: full history, a new version whenever a tracked attribute changes, soft delete when someone leaves the roster. Every dimension has an Unknown row, key -1 |
| Facts | `"Fact"` | `"JobHours"`: one row per Paylocity punch, keyed to the employee version in effect on the work date, Travel relabelled (Not Defined → Concord, TRAVEL → Travel). Loaded by replacing whole years, since punches have no ID |

**In medallion terms** (the same layering, different vocabulary):

| Medallion | Here | Why it's this |
|---|---|---|
| Bronze | `"RawPaylocity"` + the file archive | As delivered, append-only, every version kept |
| Silver | `"Paylocity"` staging views | Typed, cleaned, source rules applied. Views, not tables: the data is small, so nothing needs storing, but the layer still exists so parsing and source fixes live in one place |
| Gold | `"Dimension"` + `"Fact"` | The Kimball dimensional model people and tools query |
| (outside the layers) | `"Integration"` | Load tracking, settings and refresh functions |

The schemas keep their descriptive names rather than Bronze/Silver/Gold; this table is the translation.

The loader refreshes dimensions and facts at the end of every run by calling
`"Integration"."RefreshWarehouse"()`, all or nothing. To refresh by hand:
`SELECT "Integration"."RefreshWarehouse"();`

**Employee history** starts at the first roster in Paylocity's current report layout
(2026-10-02 14:31 UTC), set in `"Integration"."DimensionLoad"`. Earlier rosters had a
different position column, which would have looked like a position change for everyone.
Hours dated before the history starts are keyed to the employee's earliest version.

Still to come: a job dimension matched to Total ETO's job master (punches keep
`"JobCode"` / `"JobNumber"` until then), and the position-family dimension. Eight position
codes sit in more than one family, so that dimension needs a decision on how to handle them.

Staging views: `"EmployeeInformation"` (current roster), `"EmployeeInformationSnapshot"`
(every daily roster), `"JobHours"`, `"PaidExpense"` (all daily files combined, overlap
removed), `"PositionFamily"`, `"PositionFamilyOverride"`, `"HiringPosition"`. Which file owns
which years of hours is the `"Paylocity"."JobHoursSource"` table; add a row when a new
yearly archive file appears.

## Naming

Schemas, tables and columns are PascalCase, which in Postgres means **every
reference is double-quoted**:

```sql
SELECT "ReportKey", "RowsLoaded" FROM "Integration"."SourceFile" WHERE "Status" = 'loaded';
```

Unquoted, Postgres lowercases the name (`Integration.SourceFile` becomes `integration.sourcefile`)
and reports that it doesn't exist. Values (report keys like `current_job_hours`,
statuses like `loaded`) are data and stay lowercase. The database name is quoted
in SQL too (`"DataWarehouse"`), but not in connection strings.

## Where things are on SERVER-APP1

| What | Where |
|---|---|
| PostgreSQL 17 | `D:\DataWarehouse\pgsql` (binaries), `D:\DataWarehouse\pgdata` (data), port 5432 on `localhost` and `10.0.0.7` |
| Deployed loader | `D:\DataWarehouse\ingest` |
| Files | `D:\DataWarehouse\paylocity\incoming` and `\archive\yyyy\mm\<folder>` |
| Logs | `D:\DataWarehouse\logs` |
| Passwords | Windows Credential Manager of the account running the job: `datawarehouse-postgres` (logins `postgres`, `dw_loader`) and `datawarehouse-paylocity-sftp` (login `paylocity`) |

## Access

**People sign in with their Windows account** (no Postgres password) from the office
network (`10.0.0.0/24`), connecting to `10.0.0.7:5432`, database `DataWarehouse`, with
their Windows account name as the login (e.g. `dbelliveau`). Who has access is
`sql/06_people.sql`; to add someone, add a line there and re-run it as a superuser.

| Login | Who | Rights | Signs in with |
|---|---|---|---|
| `jculp` | Jon Culp | Superuser | Windows from the network; password on the server itself |
| `mvest`, `sbemberkar`, `dbelliveau` | Moses Vest, Shashank Bemberkar, Dan Belliveau | Superuser | Windows |
| `dw_loader` | The loader | Owns the database and its objects | Password |
| `reports_app` | The reports app | Read-only | Password |
| `postgres` | Built-in admin | Superuser | Password, on the server only |

### Connecting from your PC

Postgres has no instance names (nothing like SQL Server's `SERVER\INSTANCE`). A server is
a **host and port**, and you pick a **database** on it:

| Setting | Value |
|---|---|
| Host | `SERVER-APP1.stevendouglas.local` (or `10.0.0.7`) |
| Port | `5432` |
| Database | `DataWarehouse` (capital D and W) |
| Username | your Windows account name, e.g. `mvest`, without `STEVENDOUGLAS\` |
| Password | leave blank: Windows sign-in |

- **pgAdmin 4:** Register → Server → Connection tab with the values above, password blank.
- **DBeaver:** New connection → PostgreSQL, the values above, password blank, then on the
  **Driver properties** tab set `gsslib` to `sspi`.
- **psql:** `psql "host=SERVER-APP1.stevendouglas.local port=5432 dbname=DataWarehouse user=mvest"`
- **Python (psycopg):** `psycopg.connect(host="SERVER-APP1.stevendouglas.local", dbname="DataWarehouse", user="mvest")`

Remember the naming rule: PascalCase names need double quotes, e.g. `SELECT * FROM "Fact"."JobHours" LIMIT 10;`.

How Windows sign-in is wired (server config files in `D:\DataWarehouse\pgdata`, not in git):
- `pg_hba.conf`: `host all +windows_users 10.0.0.0/24 sspi map=windows`, ahead of the
  password rule, so members of `windows_users` use Windows sign-in from the network.
- `pg_ident.conf`: `windows /^(.*)@STEVENDOUGLAS$ \1` turns `jdoe@STEVENDOUGLAS` into login `jdoe`.
- Clients: pgAdmin and `psql` use it automatically. DBeaver needs the connection's driver
  property `gsslib` set to `sspi`. If sign-in fails from a PC (it works from the server), the
  likely fix is a one-time Kerberos registration by a domain admin:
  `setspn -S POSTGRES/SERVER-APP1.stevendouglas.local SERVER-APP1` (once Postgres runs as a service).

**Network access in general:** password logins work from `10.0.0.0/24` too. The built-in
`postgres` admin is refused from the network and only works on the server itself.
To make sure Windows Firewall lets the connections in, run in an admin PowerShell:

```powershell
New-NetFirewallRule -DisplayName "PostgreSQL DataWarehouse (5432)" -Direction Inbound -Protocol TCP -LocalPort 5432 -RemoteAddress 10.0.0.0/24 -Action Allow -Profile Domain,Private
```

Passwords for the password logins: `python -m keyring get datawarehouse-postgres <login>`,
run as the Windows account that stored them.

## What a run does

| Step | What happens |
|---|---|
| 1. Copy | Every file on the SFTP server not seen before is downloaded to incoming, checked (size matches, the file didn't change on the server mid-copy), hashed and recorded |
| 2. Remote delete | Only if `delete_after_download` is on, and only after step 1 succeeded and the file still hasn't changed on the server. Reports in `keep_on_server` are never deleted |
| 3. Load | Each spreadsheet goes into `"RawPaylocity"."FileRow"`, one `jsonb` row per sheet row. PDFs are `skipped`; a file whose exact bytes were already loaded is a `duplicate` |
| 4. Archive | Loaded, skipped and duplicate files move from incoming to archive |
| 5. Refresh | `"Integration"."RefreshWarehouse"()` loads the dimensions and facts from staging, all or nothing |
| 6. Purge | Archived files older than `archive_days` (365) are deleted; their rows stay in the database. PDFs, which are never loaded, are kept forever (`unloaded_archive_days = 0`) |

Every file is tracked in `"Integration"."SourceFile"` and every run in `"Integration"."Batch"`. A
file that fails to load stays in incoming and is retried next run, and the run
exits non-zero so the scheduled task shows as failed. New reports need no code
change: their first file adds a row to `"Integration"."SourceReport"`.

## This database is now the only home of the Paylocity data

As of 2026-10-04 (Jon's decision):

- **Remote delete is on.** Every file is removed from the SFTP server once its copy is
  checked and recorded (301 files deleted on the first run). Only
  `Position_Families_Overrides.xlsx` stays, because it's hand-maintained (`keep_on_server`).
- **The Power Automate flow that copied SFTP files to SharePoint is turned off.** The
  copies in the `SDC-PowerBIIntegration` site are frozen as of that date.

Anything that read the files from either place is broken and has to read from this
database instead:

| Consumer | What it read | Status |
|---|---|---|
| Reports app (`apps/reports`), hours import | `\\SERVER-DC1\ClientApps\SFTP\hours\` (`JOB_HOURS_LOCAL_PATH`) | Repointed to `"Fact"."JobHours"` when `DATAWAREHOUSE_URL` is set. **Broken until deployed** |
| Reports app, hourly roster sync | `...\employees\Employee_Information.xlsx` (`PAYLOCITY_EMPLOYEES_LOCAL_PATH`) | Repointed to `"Dimension"."Employee"` (current rows). **Broken until deployed** |
| Reports app, position families | `...\position_family_reports\Position_Families.xlsx` | Repointed to `"Paylocity"."PositionFamily"`. **Broken until deployed** |
| Reports app, position-family overrides | `...\Position_Families_Overrides.xlsx` | Still works (file kept on the server) |
| Power BI "Job Hours Report - Management Level" | SharePoint `SDC-PowerBIIntegration` workbooks | **Frozen** at 2026-10-04; being retired |
| `apps/reports/scripts/etl_job_hours.py`, `check-graph-auth.ts` | SharePoint via Microsoft Graph | Manual scripts; stale, retire |
| ETC Planner `.env` `JOB_HOURS_LOCAL_PATH` | OneDrive copy of the SharePoint folder | Setting unused by its code; remove |

Power BI also reads Job Sales, Job Ledger and Project Planner workbooks from that
SharePoint site. Those aren't on the SFTP server, so check whether the same flow fed them.

## Open item: backups (not set up yet)

Nothing under `D:\DataWarehouse` is backed up, and since the 2026-10-04 cut-over it holds
the only copies of the Paylocity data: the database (`pgdata`) and the original files
(`paylocity\archive`). A disk failure on SERVER-APP1 would lose that history for good.

Recommended (logged 2026-10-04, not yet done):

1. **Nightly database dump**, after the 06:30 load, e.g. 07:30:
   `pg_dump -h localhost -U postgres -Fc -f <backup folder>\DataWarehouse_yyyymmdd.dump DataWarehouse`
   (custom format: compressed, restorable table by table with `pg_restore`).
2. **Copy the archive folder** (`D:\DataWarehouse\paylocity\archive`) to the same backup location.
3. **The backup location must be off this machine:** a file share on another server, or cloud
   storage. Keep at least 30 daily dumps plus month-end dumps for a year.
4. **Test a restore** into a scratch database once, then quarterly.

## Setup still to do (needs an admin PowerShell)

The reports app reads with the read-only `reports_app` login (`sql/05_access.sql`); its password is in Credential Manager under `datawarehouse-postgres` / `reports_app` and goes into the app's `.env` as `DATAWAREHOUSE_URL`.

PostgreSQL currently runs as a plain process started by `pg_ctl`, so it stops if
the server restarts. To make it a Windows service, using the same data, nothing
rebuilt:

```powershell
# 1. Stop the running process (no admin needed)
D:\DataWarehouse\pgsql\bin\pg_ctl.exe -D D:\DataWarehouse\pgdata stop

# 2. In an admin PowerShell: let the service account use the data, register, start
icacls D:\DataWarehouse\pgdata /grant "NT AUTHORITY\NetworkService:(OI)(CI)F"
D:\DataWarehouse\pgsql\bin\pg_ctl.exe register -N DataWarehousePostgres -U "NT AUTHORITY\NetworkService" -D D:\DataWarehouse\pgdata -S auto -o "-p 5432"
Start-Service DataWarehousePostgres
```

Then schedule the daily run (06:30, after the last Paylocity export lands at ~06:01).
It runs as the account whose Credential Manager holds the passwords:

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\Python314\python.exe" -Argument 'D:\DataWarehouse\ingest\paylocity_ingest.py --settings D:\DataWarehouse\ingest\settings.toml' -WorkingDirectory D:\DataWarehouse\ingest
$trigger = New-ScheduledTaskTrigger -Daily -At 6:30am
Register-ScheduledTask -TaskPath "\DataWarehouse\" -TaskName "Paylocity ingest" -Action $action -Trigger $trigger -User "STEVENDOUGLAS\jculp" -Password (Read-Host "Password for STEVENDOUGLAS\jculp")
```

Later, move the task to a service account: store both passwords in its Credential
Manager (`python -m keyring set <service> <login>` while logged in as it) and
re-register the task as that account.

## Day to day

```sql
-- Recent runs
SELECT "BatchId", "StartedAt", "FinishedAt", "Status", "Counts", "ErrorMessage"
FROM "Integration"."Batch" ORDER BY "BatchId" DESC LIMIT 20;

-- Anything stuck or failed
SELECT "FileId", "ReportKey", "RemotePath", "Status", "ErrorMessage", "LocalPath"
FROM "Integration"."SourceFile" WHERE "Status" IN ('downloaded', 'failed');

-- The latest file of each report
SELECT * FROM "RawPaylocity"."LatestFile";

-- Read a report's rows
SELECT d."RowJson" ->> 'Employee Id' AS "EmployeeId",
       d."RowJson" ->> 'Job Title'   AS "JobTitle"
FROM "RawPaylocity"."DataRow" AS d
JOIN "RawPaylocity"."LatestFile" AS l USING ("FileId")
WHERE d."ReportKey" = 'employee_information';
```

**Reload a report with a different header row** (e.g. `temp_labor`, a printed report
whose header isn't row 1): set its `"HeaderRow"`, then set its files back to
`downloaded`. The next run reloads them from wherever they are, unless purged:

```sql
UPDATE "Integration"."SourceReport" SET "HeaderRow" = 8 WHERE "Source" = 'paylocity' AND "ReportKey" = 'temp_labor';
UPDATE "Integration"."SourceFile" SET "Status" = 'downloaded'
WHERE "Source" = 'paylocity' AND "ReportKey" = 'temp_labor' AND "Status" = 'loaded' AND "PurgedAt" IS NULL;
```

**Deploy a code change:** copy `ingest\paylocity_ingest.py` to `D:\DataWarehouse\ingest\`.
`D:\DataWarehouse\ingest\settings.toml` is the live settings file, so carry changes over by hand.

**Try it without touching anything:**
```powershell
python ingest\paylocity_ingest.py --dry-run            # list the SFTP server only
python ingest\paylocity_ingest.py --inspect file.xlsx  # how a local file would load
python -m unittest discover -s ingest                  # tests
```
