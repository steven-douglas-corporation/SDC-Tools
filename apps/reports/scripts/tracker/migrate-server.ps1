# Applies the Project Tracker's database migrations to the company PostgreSQL server, and makes
# sure the two logins the app needs exist.
#
# Run it yourself, in PowerShell, from a PC on the office network or the VPN:
#
#   powershell -ExecutionPolicy Bypass -File apps\reports\scripts\tracker\migrate-server.ps1
#
# It asks for your own database password with the typing hidden. That password is used once, on
# the server, and is not written anywhere. You need to be an administrator of SERVER-APP1 and a
# superuser in PostgreSQL.
#
# What it does, the same way `npm run db:tracker-migrate` does it for a development database:
#   1. Every .sql file in db\tracker\migrations, in name order, each one once and in its own
#      transaction. What has been applied is recorded in public.tracker_schema_migration, so
#      running this again applies only what is new. A file that fails is rolled back and
#      nothing after it runs.
#   2. Creates the logins tracker_app (what the app runs as) and tracker_forecast (what the
#      forecast job runs as) if they are missing. They are created WITHOUT a password, so
#      nothing can sign in as them until an administrator sets one:
#          ALTER ROLE tracker_app PASSWORD '...';
#      and gives it to the app through its .env (TRACKER_DATABASE_URL, and
#      TRACKER_ENGINE_DATABASE_URL for tracker_forecast). No password is ever in this file.
#
# It touches only the tracker schema, the tracker's own roles and that one bookkeeping table.
# The warehouse's schemas and logins are left alone.

param(
    [string]$Server   = 'SERVER-APP1.stevendouglas.local',
    [string]$Database = 'DataWarehouse',
    [string]$Login    = $env:USERNAME,
    [string]$Psql     = 'D:\DataWarehouse\pgsql\bin\psql.exe',
    # Prints the SQL that would be run and stops. Nothing is sent anywhere and no password is asked for.
    [switch]$PrintSql
)

$ErrorActionPreference = 'Stop'

$dir = Join-Path $PSScriptRoot '..\..\db\tracker\migrations'
$files = @(Get-ChildItem $dir -Filter '*.sql' | Where-Object { $_.Name -match '^\d{4}_.+\.sql$' } | Sort-Object Name)
if ($files.Count -eq 0) { throw "No migrations found in $dir" }

# One script for psql. Each migration is wrapped so that it is skipped when already applied.
$sql = New-Object Text.StringBuilder
[void]$sql.AppendLine('\set ON_ERROR_STOP on')
# psql writes a NOTICE ("already exists, skipping") to its error stream. Only real problems should
# come back, so notices are turned off for this session.
[void]$sql.AppendLine('SET client_min_messages = warning;')
[void]$sql.AppendLine(@'
CREATE TABLE IF NOT EXISTS public.tracker_schema_migration (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);
'@)
foreach ($f in $files) {
    $name = $f.Name
    [void]$sql.AppendLine("SELECT EXISTS (SELECT 1 FROM public.tracker_schema_migration WHERE name = '$name') AS tracker_migration_applied \gset")
    [void]$sql.AppendLine('\if :tracker_migration_applied')
    [void]$sql.AppendLine("\echo already applied: $name")
    [void]$sql.AppendLine('\else')
    [void]$sql.AppendLine('BEGIN;')
    [void]$sql.AppendLine([IO.File]::ReadAllText($f.FullName))
    [void]$sql.AppendLine("INSERT INTO public.tracker_schema_migration (name) VALUES ('$name');")
    [void]$sql.AppendLine('COMMIT;')
    # A migration may set a search path for its own convenience; it must not leak into the next.
    [void]$sql.AppendLine('RESET search_path;')
    [void]$sql.AppendLine("\echo applied: $name")
    [void]$sql.AppendLine('\endif')
}
[void]$sql.AppendLine(@"
DO `$do`$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_app') THEN
        CREATE ROLE tracker_app LOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_forecast') THEN
        CREATE ROLE tracker_forecast LOGIN;
    END IF;
END `$do`$;
GRANT tracker_service TO tracker_app;
GRANT tracker_engine TO tracker_forecast;
GRANT CONNECT ON DATABASE "$Database" TO tracker_app, tracker_forecast;
COMMENT ON ROLE tracker_app IS 'The reports app, for the Project Tracker. Reads everything in tracker, writes everything except forecasts.';
COMMENT ON ROLE tracker_forecast IS 'The Project Tracker forecast job. Reads everything in tracker, writes only forecasts.';
\echo logins ready: tracker_app, tracker_forecast
SELECT count(*) AS migrations_applied FROM public.tracker_schema_migration;
"@)

if ($PrintSql) { $sql.ToString(); return }

$secure = Read-Host "Database password for login $Login on $Server" -AsSecureString
$plain  = [Net.NetworkCredential]::new('', $secure).Password
if (-not $plain) { throw 'No password entered.' }

Invoke-Command -ComputerName $Server -ArgumentList $plain, $sql.ToString(), $Psql, $Login, $Database -ScriptBlock {
    param($password, $sql, $psql, $login, $database)
    # Through a file, not a pipe: Windows PowerShell re-encodes piped text, and psql must be
    # given exactly what is in the migration files.
    $file = Join-Path $env:TEMP ("tracker-migrate-" + [guid]::NewGuid().ToString('N') + ".sql")
    [IO.File]::WriteAllText($file, $sql, (New-Object Text.UTF8Encoding($false)))
    $env:PGPASSWORD = $password
    $env:PGCLIENTENCODING = 'UTF8'
    try {
        # Everything psql says comes back as plain text. Left alone, a line on its error stream
        # arrives here as an error, and this script stops on the first error: that once cut a run
        # off at a harmless notice. Whether it worked is decided by the exit code alone.
        $said = & $psql -h 127.0.0.1 -U $login -d $database -X -q -f $file 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
        $said
        if ($code -ne 0) { throw "psql ended with code $code. The migration that failed was rolled back and nothing after it ran." }
    } finally {
        Remove-Item Env:PGPASSWORD, Env:PGCLIENTENCODING -ErrorAction SilentlyContinue
        Remove-Item $file -ErrorAction SilentlyContinue
    }
}

Write-Host 'Done.'
