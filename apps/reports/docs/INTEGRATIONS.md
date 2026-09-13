# Integrations

Every external system this app talks to, what it's used for, and how it fails. For the
scheduled/manual pipeline that drives most of these, see
[REFRESH-PIPELINE.md](REFRESH-PIPELINE.md). No secret values appear below — only environment
variable **names**; see [DEVELOPMENT.md](DEVELOPMENT.md) for the full list.

## Paylocity (via OneDrive-synced Excel)

- **Source**: a payroll hours export workbook (`Current_Job_Hours.xlsx`), maintained outside
  the app and synced to this server through OneDrive. The app reads it directly off disk at
  `JOB_HOURS_LOCAL_PATH` (`src/lib/paylocity-workbook.ts`) — this is a filesystem read, not a
  Graph/SharePoint API call.
- **Purpose**: the source of truth for hours actually worked, per job/section/month.
- **Refresh behavior**: identified by content hash, not filename or modified time (Lisa
  replaces the file under the same name each time), so re-running the import against an
  unchanged file is a no-op. Runs as one step of the shared refresh pipeline — at server
  startup, hourly, and on manual "Refresh Data".
- **Failure handling**: row-level faults (bad date, non-numeric hours, unknown job, unmapped
  section) are skipped and logged as a typed `RejectedPunch`, never silently dropped — these are
  what surface as Undefined Hours. Whole-file faults (missing/empty/corrupt file, a OneDrive
  placeholder that hasn't hydrated yet, missing headers, zero valid rows) abort the import and
  leave the last good data on screen; the failure is still recorded to the `PaylocityImport`
  audit table either way.
- **Code**: `src/lib/paylocity-workbook.ts` (parsing), `src/lib/hours-feed.ts` (workbook vs.
  Power BI selection by month), `src/lib/paylocity-import.ts` (transaction + audit wrapper),
  `src/lib/sections.ts` (`mapPunchToColumns` — the one place a raw labor code becomes a grid
  column).

## Total ETO

- **Source**: the company's ERP, a SQL Server database, reached directly via the `mssql`
  package with domain credentials (`TOTALETO_DB_USER`/`TOTALETO_DB_PASSWORD`). Never written to.
- **Purpose**: parts cost (AP document lines), purchase orders, and the full engineering BOM
  tree for Procurement.
- **Refresh behavior**: mostly pre-synced into the app's own tables on the refresh schedule
  (`src/lib/sync-totaleto.ts`'s functions, called from `auto-sync.ts`). The one exception is the
  **Job Hour Details / Procurement page**, which queries Total ETO live, per selected job, on
  every render — too much per-job detail to pre-sync for every job.
- **Failure handling**: a real incident measured `getJobPartsCost`/`getJobBom` hanging 100+
  seconds against a slow (not down) Total ETO, holding the whole page render open. Both calls on
  that page are now wrapped in `src/lib/with-timeout.ts`'s `withTimeoutOrNull` with a 12-second
  budget (chosen as roughly 4× the healthy 1–3s response time) and run concurrently rather than
  sequentially. This bounds the *page render*, not the underlying query — a timed-out query
  keeps running in the background and simply isn't waited for. The page's existing empty
  states ("Parts Cost is unavailable", a Procurement `EmptyState`) are what render when this
  fires; no separate UI was needed. Elsewhere (the sync pipeline's own calls), there is no such
  timeout — a hung sync step there is isolated by the pipeline's own failure handling instead
  (see [REFRESH-PIPELINE.md](REFRESH-PIPELINE.md)).
- **Code**: `src/lib/sync-totaleto.ts`, `src/lib/job-bom.ts`, `src/lib/with-timeout.ts`.

## Power BI / Fabric

- **Status**: legacy, not primary. Hours now come from the Paylocity workbook above; parts cost
  comes from Total ETO directly. Power BI is not required for the normal user flow to work.
- **Still live in the request path**: `runDax()` (`src/lib/powerbi-client.ts`) is called on
  **every refresh pass** by `buildColumnResolver()` (`src/lib/job-hours-source.ts`) to get the
  section-code metadata map — static metadata, not the hours themselves — and falls back to a
  hardcoded alias table if Power BI is unreachable.
- **CLI-only paths**: full historical hours backfill (`fetchJobHoursRowsWithIssues`,
  `scripts/backfill-etc-history.ts`) and Fabric warehouse queries
  (`src/lib/fabric-warehouse.ts`) are reachable only via an explicit `HOURS_SOURCE=power_bi`
  environment override or by running a script directly — there is no UI button for these
  anymore (the "Sync History" button was deliberately removed; the capability stays available
  from the command line).
- **Job Cost Explorer** (`/job-cost-explorer`, integrated from a separate standalone app —
  see DEVLOG §80) queries `runDax()` for exactly one thing Power BI is still the only source
  of: Sales Price, as a fallback when the job isn't in the hand-maintained inventory snapshot.
  Everything else that tool used to get from Power BI (jobs, hours, parts cost) is instead
  read from this app's own data — see `src/lib/job-cost-source.ts`.
- **Auth**: app-only service principal (`PBI_TENANT_ID`/`PBI_CLIENT_ID`/`PBI_CLIENT_SECRET`),
  with a fallback to a delegated MSAL token cache.
- **Known risk**: a single client secret backs three things (Power BI DAX, the Fabric
  warehouse, and a Graph-based hours-sync fallback), and its expiry date was, as of the last
  check, unknown — see `docs/POWERBI-CONTINUITY.md`.

## Authentication provider

- **NextAuth v5** (beta), JWT session strategy, **one provider: Credentials** (email/password,
  bcrypt-hashed against the `User` table). Sign-up and password change are self-service
  (`src/app/login/actions.ts`).
- **⚠ Documentation drift**: `docs/ENTRA-SSO-SETUP.md` and a comment in
  `src/app/login/page.tsx` both describe Microsoft Entra SSO as the current sign-in method.
  It is not — `src/lib/auth.ts` registers only the Credentials provider today; Entra was wired
  in at one point and later reverted back to credentials-only, and those two references were
  never updated to match. Treat `lib/auth.ts` as ground truth, not those docs, until they're
  corrected.
- **Code**: `src/lib/auth.ts`, `src/app/login/`.

## SDC Scheduler (sibling internal app)

- **What it is**: a separate internal app (its own Express server + MySQL database) for
  project scheduling. Not a third-party vendor — built and maintained by the same team.
- **Two directions**:
  - **Read-only pull**: `src/lib/scheduler-db.ts` connects directly to the Scheduler's MySQL
    (`SCHEDULER_DATABASE_URL`) to mirror its team roster (`team_members`) into this app's
    Employee grouping. Fails closed (empty result) if the connection string isn't configured.
  - **Server-to-server push/pull**: `src/app/api/integration/employees/route.ts` (GET roster,
    PATCH a discipline change) and `src/app/api/integration/jobs/route.ts` /
    `[jobId]/route.ts` (GET job list/detail) — both guarded by a bearer token
    (`SCHEDULER_SHARED_TOKEN`), consumed by the Scheduler app itself, and explicitly exempted
    from the browser session middleware since these are machine-to-machine calls.
  - A third piece, `src/lib/scheduler-sso.ts`, hands an already-signed-in ETC user off to the
    Scheduler app's own login via a homegrown HMAC-signed short-lived assertion — this is an
    internal SSO between the two sibling apps, not a Microsoft/external identity provider.
- **Code**: `src/lib/scheduler-db.ts`, `src/lib/scheduler-link.ts`, `src/lib/scheduler-sso.ts`,
  `src/lib/scheduler-api-auth.ts`, `src/app/api/integration/*`.

## Summary table

| Integration | Protocol | Direction | Required for core app to work? |
|---|---|---|---|
| Paylocity | Filesystem read (OneDrive-synced .xlsx) | In only | Yes — the hours source |
| Total ETO | mssql (SQL Server) | In only, live + synced | Yes — parts cost, BOM |
| Power BI / Fabric | REST (DAX) + SQL | In only | No — metadata fallback exists; historical-only otherwise |
| Auth | NextAuth Credentials | N/A | Yes |
| SDC Scheduler | mysql2 (read) + HTTP (bearer token) | Both | No — degrades to empty roster mirror if unset |
