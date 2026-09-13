# Development

Local setup and day-to-day workflows. For production deployment, see
[DEPLOYMENT.md](DEPLOYMENT.md). For how to run and structure tests, see
[TESTING.md](TESTING.md).

## Local setup

1. Install dependencies: `npm install`
2. `cp .env.example .env` and fill in real values (ask a teammate — none are documented here on
   purpose).
3. Point `DATABASE_URL` at a MySQL instance and run the Prisma migrations (see below).
4. `npm run dev` — starts on **port 4006**.

### Environment variables (names only)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | This app's own MySQL connection (Prisma) |
| `AUTH_SECRET` | NextAuth session signing; also used to derive the password-gate cookies |
| `AUTH_URL` | The externally-visible URL NextAuth should use for callbacks |
| `TOTALETO_DB_USER`, `TOTALETO_DB_PASSWORD` | Total ETO (MSSQL) domain credentials |
| `PBI_TENANT_ID`, `PBI_CLIENT_ID`, `PBI_CLIENT_SECRET` | Power BI / Fabric service principal |
| `PBI_WORKSPACE_ID`, `PBI_DATASET_ID` | Which Power BI dataset to query (legacy paths only) |
| `JOB_HOURS_LOCAL_PATH` | Filesystem path to the OneDrive-synced Paylocity workbook |
| `HOURS_SOURCE` | Override to force `power_bi` instead of the workbook (rare — CLI/debug use) |
| `JOB_COST_INVENTORY_FOLDER` | Folder scanned for Lisa's monthly `*inventory*.xlsx` workbook (Job Cost Explorer's %Complete/Sales$) — defaults to a hardcoded OneDrive path if unset |
| `HIRING_POSITIONS_LOCAL_PATH` | Filesystem path to the Paylocity Recruiting export read live on every `/employees` render — defaults to a hardcoded OneDrive path if unset |
| `SCHEDULER_DATABASE_URL` | Read-only MySQL into the sibling Scheduler app's database |
| `SCHEDULER_SHARED_TOKEN` | Bearer token for the two apps' server-to-server integration routes |
| `SCHEDULER_BASE_URL` | Where to send a user for the Scheduler-SSO handoff |
| `CONFIRM_PASSWORD` | Per-gate override of the shared "button password" for Reopen Month (falls back to a shared default if unset) — Projects/Standard Sheet/Audit Log access is a role check now (`src/lib/permissions.ts`), not a password |
| `ETC_DEPARTMENT_OWNERS` | Configures which signed-in users may tick off which department's ETC sign-off |
| `NEXT_PUBLIC_APP_VERSION` | Displayed in the sidebar |

[`.env.example`](../.env.example) at the repo root has every one of these as an empty
key -- copy it to `.env` and fill in real values (ask a teammate).
**Never commit real values for any of these.**

## Install / start / build

```bash
npm install        # install dependencies
npm run dev         # dev server, port 4006, Turbopack
npm run build       # production build
npm start           # run the production build, port 4006
npm run lint         # eslint
npm test            # run the test suite
```

Two isolated dev variants exist for running a second instance without clobbering the first's
build cache: `npm run dev:preview` / `dev:preview2` (each sets `NEXT_DIST_DIR` to its own
`.next-preview*` folder). Several more launch profiles (`apps/reports-verify`, `-verify2`,
`-verify3`, `-perf`) are defined in `.claude/launch.json` for isolated verification/performance
work — each on its own port with its own dist directory; `-perf` specifically runs a **production
build** (`next start`), since dev-server timings aren't meaningful for performance comparisons.

## Database setup / Prisma workflow

- Schema: `prisma/schema.prisma` (MySQL, 23 models).
- Apply migrations: `npx prisma migrate dev` (creates a new migration from schema changes,
  applies it) or `npx prisma migrate deploy` (applies existing migrations only — see
  [DEPLOYMENT.md](DEPLOYMENT.md)).
- Regenerate the client after a schema change: `npx prisma generate`.
- **Windows gotcha**: `npx prisma generate` can fail with `EPERM` if a running `next dev`/`next
  start` process still holds `node_modules/.prisma` open. Stop the server first.
- Seed an admin user: `npx tsx prisma/seed.ts <email> <password> [name]` — not wired to an npm
  script, run it directly.
- A few tables (`MonthlyReportSubmission`, `DepartmentEtcCompletion`, `RefreshRun`) have had
  columns added directly via SQL in the past, ahead of a formal migration — if `prisma migrate
  diff` ever proposes *dropping* a column you know is live, check whether this is the cause
  before running it; the fix is declaring the column in the schema, not migrating it away.

## Testing commands

See [TESTING.md](TESTING.md) for what's actually covered. Quick reference:

```bash
npm test                              # full suite
npx tsx --test tests/etc.test.ts       # a single file
npx tsc --noEmit                       # typecheck (tests are included in this project's tsconfig)
```

## Common development workflows

- **Adding a new grid column or KPI**: start from `lib/etc.ts` (or the relevant `lib/*.ts`
  formula module) for the calculation, add a test in `tests/`, then wire it into the
  component. Don't duplicate a formula into a component — every existing one is a shared
  function precisely so the grid, the KPI cards, and the export can't disagree.
- **Adding a new Server Action**: put it in the relevant `lib/*-actions.ts` file (or create one
  named after the feature), mark the file `"use server"`, and call it from a client component.
- **Touching anything under `lib/etc.ts`, `lib/monthly-report.ts`, or the realtime hub**: these
  are the most business-logic-dense, most carefully-tested files in the app (see
  [ETC-BUSINESS-LOGIC.md](ETC-BUSINESS-LOGIC.md) and [REALTIME-SYNC.md](REALTIME-SYNC.md)) —
  run the full test suite, not just a spot check, before considering a change to them done.
- **Verifying a UI change**: this app requires a signed-in session for every page, so a
  from-scratch preview needs a real login. See `docs/` for any environment-specific notes your
  team keeps on this.
