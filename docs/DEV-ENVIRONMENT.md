# Development environment

How to run **your own build** of SDC Reports on your own machine, against a
throwaway database, without touching production or any company system.

> **Scope.** This covers **SDC Reports** (`apps/reports`), the app that owns a
> MySQL database through Prisma and holds Employees, Projects, Monthly ETC, the
> Standard Sheet, Hours, Job Cost, Build Readiness and Cash Flow. Other apps are
> listed under [What is not covered](#what-is-not-covered).

- **Time to first login:** about 10 minutes, most of it `npm install`.
- **Needs:** Node 22+, Docker Desktop, Git. Nothing else, and no company VPN,
  credentials or network shares.
- **Test data:** [DEV-TEST-DATA.md](DEV-TEST-DATA.md) — including a guide you can
  hand to an AI assistant to build larger datasets.

---

## 1. Quick start

From the repo root:

```bash
git clone https://github.com/steven-douglas-corporation/SDC-Tools.git
cd SDC-Tools
git switch -c feat/my-change master        # always work on a branch off master

# 1. the database
docker compose -f docker-compose.dev.yml up -d --wait

# 2. the app
cd apps/reports
npm install
cp .env.dev.example .env                   # see the warning below if you already have a .env
npx prisma migrate deploy                  # create the tables (all migrations)
npm run db:seed-dev                        # baseline data + one login per role
npm run dev                                # http://localhost:4006
```

Sign in at <http://localhost:4006> with any of these (password **`devpass123`**):

| Email | Role | Use it to test |
|---|---|---|
| `elt@dev.local` | ELT | everything — the all-access role |
| `manager@dev.local` | MANAGER | manager-level editing, ETC submission |
| `pm@dev.local` | PM | project-execution pages |
| `sales@dev.local` | SALES | what Sales can and cannot see |
| `all@dev.local` | ALL | the lowest-privilege role |

> **Already have an `apps/reports/.env`?** `cp -n` leaves it alone, which is
> what you want. Move it aside (`mv .env .env.prod-like`) before copying the dev
> profile, and move it back when you are done. **Never** run the seed or the dev
> server with production values in `.env`; see [Safety](#4-safety-what-stops-a-dev-build-reaching-production).

### Daily use

```bash
docker compose -f docker-compose.dev.yml up -d      # start the database (data persists)
npm run dev --prefix apps/reports                   # start the app
docker compose -f docker-compose.dev.yml down       # stop the database, keep the data
docker compose -f docker-compose.dev.yml down -v    # stop and DELETE the data (full reset)
```

**Reset to a clean baseline:** `down -v`, then `up -d --wait`, `prisma migrate
deploy`, `npm run db:seed-dev`. The seed is also safe to re-run on its own; it
rewrites only the rows it owns.

After pulling changes that add a migration, run `npx prisma migrate deploy`
again. After editing `schema.prisma`, use `npx prisma migrate dev --name <what>`.

---

## 2. Development vs production

| | Production | Your dev environment |
|---|---|---|
| Where it runs | `SERVER-APP1`, PM2, auto-deployed from `master` within ~5 min | Your machine, started by hand |
| Port | 4006 | 4006 (same, so links and the shell behave) |
| Database | MySQL on the server, real company data | MySQL 8 in Docker, `127.0.0.1:3317`, database `sdc_reports_dev`, **seeded fake data** |
| Sign-in | Entra ID SSO via the Scheduler broker, plus credentials | Credentials only (`*@dev.local`) |
| Total ETO parts lines (parts cost, left-to-invoice, parts list) | Live SQL Server over the LAN | **Faked**: generated PO lines (`SDC_DEV_FAKE_ETO=1`, see [DEV-TEST-DATA.md](DEV-TEST-DATA.md#3-faux-eto-and-bom-data)) |
| Total ETO BOM tree, job mirror, cash-flow queries | Live SQL Server | **Not connected**; BOM dashboard is seeded instead |
| Power BI / Fabric | Service principal | **Not connected** |
| DataWarehouse (Postgres) | Hours, roster, position families | **Not connected**; hours are seeded directly |
| Paylocity / inventory workbooks | Files on the share | **Not read**; paths unset |
| Scheduler integration | Live | **Off**; Scheduler is a separate repo |
| Hourly auto-refresh + *Refresh Data* | On | **Off** (`SDC_DEV_DISABLE_SYNC=1`) |
| `NODE_ENV` | `production` (built with `next build`) | `development` (Turbopack, hot reload) |
| Deploys | Merge to `master` | **Nothing you do here deploys.** Open a pull request |

The practical consequence: in production a page is filled by a sync from a
company system; in dev **you put the rows in the database yourself**. That is
what the seed and [DEV-TEST-DATA.md](DEV-TEST-DATA.md) are for.

---

## 3. The pieces

| File | What it is |
|---|---|
| [`docker-compose.dev.yml`](../docker-compose.dev.yml) | One MySQL 8 container. Loopback-only, port 3317, `--lower-case-table-names=1` |
| [`apps/reports/.env.dev.example`](../apps/reports/.env.dev.example) | The dev profile. Every real-system credential is left blank on purpose |
| [`apps/reports/prisma/seed-dev.ts`](../apps/reports/prisma/seed-dev.ts) | Baseline dataset. Deterministic, idempotent, refuses non-local databases |
| `SDC_DEV_DISABLE_SYNC` | The switch in `instrumentation.ts` and `refresh-service.ts` that stops the auto-refresh |
| `SDC_DEV_FAKE_ETO` | Serves generated parts lines from [`src/lib/dev-fake-eto.ts`](../apps/reports/src/lib/dev-fake-eto.ts) instead of querying Total ETO |
| [`prisma/dev-data/build-readiness.ts`](../apps/reports/prisma/dev-data/build-readiness.ts) | Faux BOM / Build Readiness snapshots |

**Why `--lower-case-table-names=1`.** Reports' migrations were generated on
Windows MySQL, which lowercases table names (`user` for `User`). Linux MySQL
defaults to case-sensitive and that setting can only be chosen when the data
directory is first created. If you ever see `Table 'sdc_reports_dev.user'
doesn't exist`, your volume was created without it: `down -v` and start again.

**Why port 3317.** Clear of a MySQL already on 3306 and of the Scheduler's own
dev containers (3306/3307, in `SDC_Scheduler/docker-compose.local.yml`).

### What the baseline seed creates

12 employees with a reporting line across PM, mechanical, controls, build and
wire teams; 7 jobs (Custom, Duplicate, Hybrid, Service, Complete, non-billable);
quoted/actual/ETC hours for 7 sections per job; punch-level hours for the three
previous months; ETC entries for those months **locked** and the current month
**open**. Every name contains `DEV`, so it can never be mistaken for real data.

---

## 4. Safety: what stops a dev build reaching production

1. **No credentials.** Total ETO, Power BI, the DataWarehouse and the Scheduler
   are only reachable if you put their credentials in `.env`. The dev profile
   leaves them blank. Do not add them.
2. **The sync switch.** `SDC_DEV_DISABLE_SYNC=1` stops the hourly pass and makes
   *Refresh Data* refuse. Without it the app tries every source on boot and
   a sync can overwrite or purge seeded rows.
3. **The seed refuses non-local databases.** It exits unless the host in
   `DATABASE_URL` is `localhost`, `127.0.0.1` or `[::1]`.
4. **The database is bound to loopback** (`127.0.0.1:3317`), so nobody else on
   the network can reach it, and its root password is a throwaway.
5. **Nothing here deploys.** The production updater only follows `master` in the
   production checkout. Your clone is a separate directory.

Rules of thumb: never copy a production `.env` into a dev clone; never point
`DATABASE_URL` at `SERVER-APP1`; never commit `.env`, a database dump or a
spreadsheet (see [SECURITY.md](../SECURITY.md)).

---

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `port is already allocated` on 3317 | Something else holds it. Change both numbers in `docker-compose.dev.yml` and `DATABASE_URL` |
| `Can't reach database server at 127.0.0.1:3317` | Container not up: `docker compose -f docker-compose.dev.yml ps`; start Docker Desktop |
| `Table '…user' doesn't exist` | Volume created without lowercase table names: `down -v`, start again |
| `Refusing to seed: DATABASE_URL host is …` | Your `.env` points somewhere other than localhost. Good. Fix it |
| `EPERM` from `prisma generate` (Windows) | A running `next dev` holds `node_modules/.prisma`. Stop it first |
| Sign-in loops back to the login page | `AUTH_URL` does not match the URL in your browser (including the port) |
| Panels say a source is unavailable / empty | Expected for sources that are not faked: Power BI, the warehouse, the BOM tree. Seed the table instead |
| *Refresh Data* says it is disabled | Expected: `SDC_DEV_DISABLE_SYNC=1` |
| Tests | `npm test --prefix apps/reports` needs no database and no Docker |

---

## 6. What is not covered

| App | Why | What it would need |
|---|---|---|
| SDC Scheduler | Separate repository (ADR 0002); has its own `docker-compose.local.yml` and MySQL | Clone it into `SDC_Scheduler/`; its README and compose file are authoritative |
| Calendar | MySQL, but no schema bootstrap in the repo to build a database from | A schema export from production, with data removed |
| Assemblies Library, State Logic Builder | Azure SQL and UNC file shares | An Azure SQL dev database and share |
| Build Readiness Report (standalone) | Reads Total ETO (SQL Server) | A SQL Server container and a copy of the views it queries |
| Desktop shell | Electron + Entra ID login | An Entra test tenant |
| Linking Reports ↔ Scheduler locally | Needs both stacks and shared tokens | See the Scheduler's compose notes; use a different Reports DB port than 3307 |

These are gaps in what is *documented here*, not things that cannot be done.
