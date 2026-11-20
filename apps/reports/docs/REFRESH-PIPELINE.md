# Refresh Pipeline

How data gets from upstream systems into this app's own database — on a schedule, and on
demand. For what each source actually is, see [INTEGRATIONS.md](INTEGRATIONS.md); for what
happens once data lands in the database, see [DATA-FLOW.md](DATA-FLOW.md).

## One shared entry point

Every trigger — server startup, the hourly timer, and the dashboard's "Refresh Data" button —
calls the same function: `refreshAllData()` in `src/lib/refresh-service.ts`. There is no
separate "manual refresh" code path that could drift from the scheduled one.

```mermaid
flowchart TD
    Start[Server boot] -->|once| RAD["refreshAllData()"]
    Timer["setInterval, 1 hour"] -->|SYNC_INTERVAL_MS| RAD
    Button["Refresh Data button"] -->|user click| RAD
    RAD --> Lock{Acquire RefreshLock<br/>MySQL row, 15-min stale timeout}
    Lock -->|held by another run| Skip[Report: already running]
    Lock -->|acquired| Run["runAllSyncs()"]
    Run --> S1[hours_actual]
    S1 --> S2[undefined_hours]
    S2 --> S3[etc_hours_worked]
    S3 --> S4[parts_cost]
    S4 --> S5[parts_cost_actual]
    S5 --> S6[standard_pools]
    S6 --> S7[totaleto_jobs]
    S7 --> S8[scheduler_team]
    S8 --> Done[Close RefreshRun row<br/>release lock]
    Done --> Broadcast["recordChanges() —<br/>realtime broadcast, no cellKey"]
```

## The Paylocity SFTP pull (asked-for refreshes only)

Every Paylocity step reads the DataWarehouse, and the warehouse holds only what its own
load (`tools/data-warehouse/ingest/paylocity_ingest.py`) has copied from the SFTP server. That
load is a scheduled task with its own schedule: hourly at :30 since 2026-11-16 (daily at
5:30am before that), per `"Integration"."Batch"`.

A refresh somebody asked for (the Refresh Data button, or `POST /api/integration/refresh`)
starts that same task first and waits for it, then runs the sources below, so it reads what is
on the SFTP server now instead of what the last scheduled run found. This app's own hourly and
startup passes do not start it: the load's own schedule covers the unattended case. See `src/lib/warehouse-ingest.ts`.

Turning it on in production, step by step: [DEPLOY-REFRESH-SFTP-PULL.md](DEPLOY-REFRESH-SFTP-PULL.md).

- **Setting:** `WAREHOUSE_INGEST_TASK` in `.env`, the task as Task Scheduler names it
  (`\DataWarehouse\Paylocity ingest`). Unset, the pull is skipped.
- **Permission:** the Windows account the app runs as must be allowed to start the task. The
  task still runs as `svc-datawarehouse`, so no SFTP or database password moves.
- **If it fails or is still running after 150s:** the refresh carries on with what the
  warehouse holds, is recorded as partial, and the button says why. A load that is still
  running is not stopped.
- **It is not a row in `SYNC_SOURCES`:** it would show as stale on the Dashboard between
  clicks. Its outcome is the first entry in the run's `steps` (source `warehouse_ingest`).

## Starting a refresh over HTTP

`/api/integration/refresh`, guarded by `Authorization: Bearer <REFRESH_API_TOKEN>` (its own
token; unset means every request is refused).

| Call | Answer |
|---|---|
| `POST /api/integration/refresh` | `202` at once; the refresh runs in the background. `409` if one is already running |
| `POST /api/integration/refresh?wait=1` | The full outcome when the refresh has finished (`200`, or `409` / `500`) |
| `POST /api/integration/refresh?pull=0` | The same refresh without the SFTP pull. Used by the load itself (below) |
| `GET /api/integration/refresh` | Whether one is running and on which stage, and how the last one ended |

It runs the same pass as the button, SFTP pull included, recorded with trigger `api`. It never
starts a new ETC month; only a person's click does.

### The load tells the app when it has new files

The warehouse load and this app's hourly pass run on unrelated clocks, so a file could wait up
to an hour for the load and most of another for the app. When a load run has loaded new files
and rebuilt the warehouse from them, `paylocity_ingest.py` calls
`POST /api/integration/refresh?pull=0` (`[reports_app]` in its `settings.toml`). `pull=0` is
what stops the two starting each other. A run that finds nothing, which is most of them, makes
no call. If the call fails, the load still succeeds and the hourly pass picks the rows up.

## Source order

Fixed and sequential, defined once in `src/lib/auto-sync.ts`'s `SYNC_SOURCES`:

1. `hours_actual` — Paylocity hours import
2. `undefined_hours` — rejected-punch aggregation (depends on step 1's rejects)
3. `etc_hours_worked` — writes `EtcEntry.hoursWorked` for the open ETC month
4. `parts_cost` — Total ETO AP-document pull → `EtcEntry` Parts Cost section
5. `parts_cost_actual` — Total ETO lifetime parts snapshot → Projects grid column
6. `standard_pools` — Standard Fees pool computation
7. `totaleto_jobs` — mirrors Total ETO's project list into the `Job` table
8. `scheduler_team` — mirrors the Scheduler app's team roster

Each step runs fully before the next starts — there is no parallelism between sources (there is
concurrency *within* a couple of individual steps, like the Job Hour Details page's own
TotalETO calls, but that's unrelated to this pipeline's own sequencing).

## Failure handling

Each source is wrapped in its own try/catch (the `step()` helper in `auto-sync.ts`). One
source failing records a `"failed"` status **for that source only** and the pipeline continues
to the next one — a Total ETO outage doesn't prevent the Paylocity hours import from running,
and vice versa.

**There is no retry policy**, deliberately — the code comment states it plainly: *"the interval
IS the retry."* A failed source will simply be attempted again on the next hourly pass (or the
next manual click). This trades faster recovery for simplicity; a source that fails
consistently for reasons the hourly retry can't fix (an expired credential, say) will fail
consistently every hour until a human intervenes — see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Cache invalidation / recalculation

There is no separate cache to invalidate — each sync step writes its result directly into the
app's own tables (`JobMonthlyActualHours`, `EtcEntry`, `Job`, etc.), and every page reads those
tables fresh on each request (Server Components, no data-layer cache). "Recalculation" is
simply the next read after the write — there's no derived/materialized table that needs an
explicit rebuild step.

## Broadcast / update flow

Three separate mechanisms tell a user a refresh happened, not one:

1. **The tab that clicked the button** gets the result synchronously as the return value of the
   `refreshApplicationData` Server Action, which also calls `revalidatePath` on the relevant
   pages.
2. **While a refresh is in flight**, any tab polls a dedicated route,
   `/api/refresh/status`, once a second — deliberately a route handler and not a second Server
   Action, since Next.js serializes Server Actions per client and a polling action would queue
   up behind the very refresh it's trying to check on.
3. **Every other connected tab** learns via the realtime broadcast: `refresh-service.ts` calls
   `recordChanges(...)` with no `cellKey` when a refresh completes, which every tab treats as
   "something changed, do a throttled full-page refetch" (see
   [REALTIME-SYNC.md](REALTIME-SYNC.md)) in addition to showing a toast/banner.

## Concurrency control

`RefreshLock` (a MySQL row, updated with a conditional `UPDATE`) ensures only one refresh runs
at a time across however many browser tabs might click the button simultaneously. The lock is
considered stale and reclaimable after 15 minutes, in case a previous run crashed without
releasing it.

## Freshness reporting

`recentRefreshRuns()` reads the last few `RefreshRun` rows for the dashboard's "last refreshed"
line; `currentRefresh()` reads the lock + in-progress run together to answer "is one running
right now, and on which step" for the status poller above. `PowerBiFreshness` separately tracks
per-source data-through dates for the freshness chips shown per source on the dashboard.
