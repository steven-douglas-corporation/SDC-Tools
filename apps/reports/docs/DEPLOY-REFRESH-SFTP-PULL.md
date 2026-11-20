# Deploying the SFTP pull on refresh

How to turn on the three things PR #293 adds, on the production server (SERVER-APP1). What
they are and why is in [REFRESH-PIPELINE.md](REFRESH-PIPELINE.md); this page is only the
rollout.

**Status when written (2026-11-20): none of these steps has been run on the server.** The
paths come from `ecosystem.config.js` and `tools/data-warehouse/README.md`. Step B2 and step
C4 are the first real tests of the feature.

## What turns on what

Merging deploys the code and changes nothing by itself. Each part stays off until its own
setting exists, so the stages below can be done on different days.

| Part | What it does | Turned on by |
|---|---|---|
| Button pull | Refresh Data starts the warehouse's Paylocity load and waits for it before refreshing | `WAREHOUSE_INGEST_TASK` in the Reports `.env` |
| Endpoint | `POST /api/integration/refresh` starts the same refresh without a browser | `REFRESH_API_TOKEN` in the Reports `.env` |
| Load tells the app | After a load that brought in new files, the app refreshes at once | New `paylocity_ingest.py`, `[reports_app]` in the live `settings.toml`, and the token stored for the load's account |

## Manifest

Everything this release touches.

| Item | Where | How it gets there |
|---|---|---|
| Reports app code (everything the PR changes under `apps/reports`) | `D:\AI Projects\Centrailized library\apps\reports` | Automatic: the updater deploys `master` within a few minutes of the merge |
| `WAREHOUSE_INGEST_TASK` | Reports `.env` | By hand (stage B) |
| `REFRESH_API_TOKEN` | Reports `.env` | By hand (stage B) |
| Right to start the task `\DataWarehouse\Paylocity ingest` | Task Scheduler, for the account the Reports app runs as | By hand, only if step B2 fails (step B3) |
| `paylocity_ingest.py` | `D:\DataWarehouse\ingest\` | By hand (stage C). The updater does **not** deploy this file |
| `[reports_app]` section | `D:\DataWarehouse\ingest\settings.toml` (the live file, separate from the repo's copy) | By hand (stage C) |
| The token, for the load | Windows Credential Manager of `svc-datawarehouse`: service `reports-refresh-api`, user `paylocity_ingest` | By hand (stage C) |

Not changed: no database migration, no new port, no firewall rule, no new Windows service, no
change to the load's schedule. `RefreshRun.trigger` gains the value `api`, which fits the
existing column.

## Before you start

- An administrator session on SERVER-APP1.
- The password for `svc-datawarehouse` (stage C only).
- A token. Generate one in PowerShell and put it in the team password manager. Hex only, so it
  is safe in `.env` and on a command line:

```powershell
$b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

## Stage A: merge

Merge PR #293. The updater redeploys Reports. Check the app still answers:

```powershell
curl.exe http://localhost:4006/api/health
```

Nothing else should look different yet: Refresh Data behaves as before, and the endpoint
answers `503 refresh_api_not_configured`.

## Stage B: the button pull and the endpoint

**B1. Add the settings.** In `D:\AI Projects\Centrailized library\apps\reports\.env`, add two
lines. No quotes around the task name; the backslashes and the space are fine as written.

```
WAREHOUSE_INGEST_TASK=\DataWarehouse\Paylocity ingest
REFRESH_API_TOKEN=<the token>
```

Restart so the app reads them. From `apps\reports`, and not a bare `pm2 restart` (see
[DEPLOYMENT.md](DEPLOYMENT.md) for why):

```powershell
npm run deploy
```

**B2. Test the button.** Sign in to Reports and press Refresh Data. Expect it to take about
10 to 20 seconds longer than before, and the toast to include one of:

- `Paylocity SFTP: no new files.`
- `Paylocity SFTP: N new files copied, M loaded (R rows).`

If the toast says `Could not start the scheduled task …`, do B3 and press it again.

**B3. Only if B2 failed: let the app's account start the task.** Find the account the app runs
as (PM2 runs in the interactive Windows user's session), in an admin PowerShell:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; "$($o.Domain)\$($o.User)  $($_.CommandLine)" }
```

Then grant that account read-and-run on the task. Replace the account on the first line:

```powershell
$account = 'SERVER-APP1\the-account'
$sid = (New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value
$svc = New-Object -ComObject Schedule.Service; $svc.Connect()
$task = $svc.GetFolder('\DataWarehouse').GetTask('Paylocity ingest')
$task.SetSecurityDescriptor($task.GetSecurityDescriptor(0xF) + "(A;;GRGX;;;$sid)", 0)
```

The grant is lost if the task is deleted and registered again. The task keeps running as
`svc-datawarehouse`; this only allows the other account to start it.

**B4. Test the endpoint.** This should return JSON with `running` and `lastRun`:

```powershell
curl.exe -H "Authorization: Bearer <the token>" http://localhost:4006/api/integration/refresh
```

`401` means the token does not match. `503` means the app has not picked up
`REFRESH_API_TOKEN` (check the `.env` line and that the deploy in B1 finished).

## Stage C: the load tells the app

This stage replaces the script that fills the warehouse. Do it between runs (the load starts
at :30 past each hour and takes under 30 seconds), and not just before 5:30am.

**C1. Copy the script, keeping the old one.** After the merge, the updater's checkout has the
new file:

```powershell
Copy-Item D:\DataWarehouse\ingest\paylocity_ingest.py D:\DataWarehouse\ingest\paylocity_ingest.py.bak
Copy-Item "D:\AI Projects\Centrailized library\tools\data-warehouse\ingest\paylocity_ingest.py" D:\DataWarehouse\ingest\
```

**C2. Add the setting.** In `D:\DataWarehouse\ingest\settings.toml`, just above `[paths]`:

```toml
[reports_app]
refresh_url = "http://localhost:4006/api/integration/refresh?pull=0"
timeout_seconds = 15
```

Keep `?pull=0`. Without it, the app starts the load again and the two trigger each other.

**C3. Store the token for the load's account.** Open a window as that account:

```
runas /user:SERVER-APP1\svc-datawarehouse cmd
```

In that window (the `/pass` prompt ignores pasting, so the token goes on the command line;
close the window afterwards):

```
cmdkey /generic:reports-refresh-api /user:paylocity_ingest /pass:<the token>
cmdkey /list
```

The `reports-refresh-api` entry must not say "Saved for this logon only".

**C4. Run the load once and check it.** In Task Scheduler, run `\DataWarehouse\Paylocity
ingest`. Then confirm the newest batch succeeded:

```sql
SELECT "BatchId", "StartedAt", "Status", "Counts", "ErrorMessage"
FROM "Integration"."Batch" ORDER BY "BatchId" DESC LIMIT 3;
```

A run with no new files makes no call to the app, so this only proves the new script still
loads. The call itself is first exercised by the next run that loads a file, normally 5:30am.
The morning after, look in `D:\DataWarehouse\logs\paylocity_ingest.log` for:

| Log line | Meaning |
|---|---|
| `reports app refresh: started (HTTP 202)` | Working |
| `reports app refresh: not needed: the app is already refreshing…` | Working; a refresh was already under way and reads the same files |
| `reports app refresh: not sent: no token stored…` | C3 was not done for this account |
| `reports app refresh: failed: the app answered HTTP 401` | The stored token differs from `REFRESH_API_TOKEN` |
| `reports app refresh: failed: …` (anything else) | The app was unreachable at `refresh_url` |

None of these fails the load. The app's own hourly refresh still picks the rows up.

## Rolling back

Each part turns off without a code change.

| To turn off | Do this |
|---|---|
| Button pull | Remove `WAREHOUSE_INGEST_TASK` from the Reports `.env`, then `npm run deploy` |
| Endpoint | Remove `REFRESH_API_TOKEN` from the Reports `.env`, then `npm run deploy` |
| Load tells the app | Remove `refresh_url` from the live `settings.toml` (takes effect on the next run) |
| The new load script | Copy `paylocity_ingest.py.bak` back over `paylocity_ingest.py` |
| Everything | Revert the merge commit; the updater redeploys. The load script still has to be copied back by hand |

## What to expect afterwards

- Refresh Data takes about 10 to 20 seconds longer, because it waits for the load. Loads took 9
  seconds on average with no files and at most 22 seconds with files (98 runs, 2026-11-06 to
  2026-11-20, from `"Integration"."Batch"`).
- A pull that fails makes that refresh "partial": a red toast naming the Paylocity pull, with
  everything else refreshed from what the warehouse already held.
- A click-triggered load that fails counts like a failed scheduled one: the Data Sync card
  turns red until the next good run.
- Reports refreshes once or twice more a day, right after the morning loads.
