# Applications

Every runnable app and tooling folder in this workspace, what it does, and how it's deployed. See [PORTS.md](PORTS.md) for the port registry and [../ARCHITECTURE.md](../ARCHITECTURE.md) for how they fit together.

---

## Assemblies Library

- **Purpose:** SolidWorks CAD assembly search, preview, and vault file management.
- **Folder:** `apps/assemblies/`
- **Port:** 4001
- **Start command:** `node server/index.js` (workspace: `npm run start:assemblies` from repo root)
- **Production process:** PM2 `sdc-assemblies`, updated automatically by `sdc-updater-hub` (polls this monorepo's `master`, ~5 min)
- **Dependencies:** Express, `mysql2`, React/Vite frontend, PowerShell (`extract-thumbnail.ps1`) for SolidWorks thumbnails
- **Primary data sources:** MySQL `sdc_assemblies` (local); `\\stevendouglas.local\dfs\...\_Assembilies_Library_Application` (vault file share)

## Build Readiness Report

- **Purpose:** Live ETO project build status — parts, prints, sign-offs, readiness checklist per project.
- **Folder:** `apps/build-readiness/`
- **Port:** 4002
- **Start command:** `node server/index.js` (workspace: `npm run start:readiness` from repo root)
- **Production process:** PM2 `sdc-readiness`, updated automatically by the monorepo updater (`sdc-main-updater.js`, polls `steven-douglas-corporation/SDC-Tools` `master`, ~5 min), running inside `sdc-updater-hub`. It had its own updater until 2026-08-26 (`sdc-brr-updater.js`, pointed at a separate `Build_Readiness_Report` repo that had gone stale); that was retired because two updaters owned this directory from two different sources of truth
- **Dependencies:** Express, `mssql` (ETO), React/Vite frontend
- **Primary data sources:** Total ETO (on-prem MSSQL, read-only); SDC Scheduler's `/api/integration/project-dates` (build-start/ship dates — replaced the old Smartsheet integration)

## SDC Scheduler

- **Purpose:** Gantt/grid project scheduling, procurement/vendor PO tracking, job hours, SDC Assistant (Claude-powered chat).
- **Folder:** `SDC_Scheduler/` — **not moved**. Its own standalone git repo (`danbelliveau2/SDC_Scheduler`), deliberately excluded from this monorepo's git tracking. Dan (external collaborator) pushes directly to its `main`; production re-syncs via `git reset --hard origin/main` every 2 minutes.
- **Port:** 4003 (app), 4013 (updater manual trigger), 4100 (read-only MCP server)
- **Start command:** `node server.js` (workspace: `npm run start:scheduler` from repo root)
- **Production process:** PM2 `sdc-scheduler`; its updater runs inside `sdc-updater-hub`
- **Dependencies:** Express, Socket.io, `mysql2`, `mssql` (ETO), `@anthropic-ai/sdk`
- **Primary data sources:** MySQL `sdc_scheduler` (local); Total ETO (read-only); Power BI job hours via a subprocess call to `SDC-PowerBI-DEV`'s MCP exe

## State Logic Builder

- **Purpose:** Visual PLC state-machine editor (React Flow) exporting Allen-Bradley ControlLogix L5X files.
- **Folder:** `apps/state-logic/`
- **Port:** 4004
- **Start command:** `node server.js` (workspace: `npm run start:statelogic` from repo root)
- **Production process:** PM2 `sdc-statelogic`, updated automatically by its own updater (`server-auto-update.js`, polls `danbelliveau2/state_logic_builder` GitHub *Releases* — not every commit — ~5 min, replaces only `src/`, `public/`, `index.html`), running inside `sdc-updater-hub`. Also ships as a separate standalone Electron desktop installer (its own release pipeline, port 3131 locally) — a second, independent distribution channel from the PM2 web app.
- **Dependencies:** Express, `mysql2`, React/Vite + React Flow frontend
- **Primary data sources:** MySQL `sdc_statelogic` (local, with a local-JSON fallback); `\\stevendouglas.local\dfs\...\State Logic Diagrams\standards` (shared standards library)

## SDC Calendar

- **Purpose:** Company-wide calendar — events, birthdays, paydays, employee directory, read-only sync of SDC Scheduler tasks.
- **Folder:** `apps/calendar/`
- **Port:** 4005
- **Start command:** `node server/server.js` (from repo root: `npm run start:calendar`)
- **Production process:** PM2 `sdc-calendar`, updated automatically by `sdc-updater-hub` (monorepo watcher)
- **Dependencies:** Express, `mysql2`, `better-sqlite3` (for the read-only Scheduler bridge only), React/Vite frontend
- **Primary data sources:** MySQL `sdc_calendar` (local); read-only bridge into `SDC_Scheduler/scheduler.db` if present (production runs Scheduler on MySQL, so in practice this file doesn't exist and the bridge routes return `[]`)

## SDC Reports (ETC Planner)

- **Purpose:** Replaces three manually-maintained Excel workbooks with a live web app — Dashboard, Employees, Projects, Monthly ETC, Job Hour Details, Profitability, Hours, T&M, Build Readiness, Cash Flow Forecast.
- **Folder:** `sdc-etc-planner/` — tracked in this monorepo since 2026-09-03 (formerly its own standalone repo, `sdc-sheets`).
- **Port:** 4006 (renumbered from 3010, 2026-08-23 — see [PORTS.md](PORTS.md) for the shell-release step this still needs)
- **Start command:** `next start -p 4006`
- **Production process:** PM2 `sdc-etc-planner` (folded into the root `ecosystem.config.js` as part of this restructuring — previously ran from its own separate, broken `ecosystem.config.js`)
- **Dependencies:** Next.js 16 (App Router, Server Actions), Prisma, `mssql` (Total ETO), `mysql2` (read-only Scheduler mirror), NextAuth v5
- **Primary data sources:** Its own MySQL via Prisma (`DATABASE_URL`); Total ETO (read-only, mostly pre-synced); SDC Scheduler's MySQL (read-only team-roster mirror); a Paylocity Excel export on a OneDrive-synced path (`src/lib/paylocity-sources.ts`) — do not alter this logic casually, it's self-validating and was hardened after a real double-counting incident

## Electron Shell

- **Purpose:** Desktop launcher — one window with tiles for all 6 apps above, Azure AD (MSAL) login, auto-update.
- **Folder:** `apps/shell/`
- **Port:** none in production (desktop client, not a server); dev-mode Vite UI on 5173
- **Start command:** `npm run dev` (dev) / `electron-builder --win --publish always` (release)
- **Production process:** not PM2-managed — distributed as an installer via GitHub Releases; installed copies auto-update every ~30 min
- **Dependencies:** Electron, `@azure/msal-node`, `electron-updater`, React/Vite UI
- **How it talks to the apps:** `shell/electron/processManager.js` is a **pure thin client** — it only HTTP-health-polls each app's `/health` (or `/api/health`) endpoint on `SDC_SERVER_HOST` (falls back to `localhost` for local dev) and opens a `BrowserWindow` pointed at that URL. It does not spawn or `require()` any app in-process, despite each app still exporting a dormant `startServer({port})` for that no-longer-used convention.

## Power BI Dev

- **Purpose:** Power BI Desktop report source files (job hours, profitability) plus the MCP server that lets SDC Scheduler and Claude query them live via DAX.
- **Folder:** `SDC-PowerBI-DEV/` — tracked in this monorepo since 2026-09-03 (formerly its own standalone repo, `SDC-PowerBI`).
- **Port:** none — not a service. `mcp-server/publish/win-x64-new/sdc-powerbi-mcp.exe` is a stdio MCP server, spawned on demand as a subprocess (by SDC Scheduler's `lib/hoursApi.js`, or by Claude directly) — never run as a standalone daemon.
- **Production process:** none — no PM2 entry, nothing to keep running
- **Dependencies:** .NET 8 (MCP server source), Power BI Desktop (`.pbix`/`.pbip` files)
- **Primary data sources:** Power BI semantic model, published to the `SDC Reports` workspace

---

## Why three apps aren't inside `apps/`

SDC Scheduler, SDC Reports, and Power BI Dev are each their own independent git repository with their own remote and deploy/update mechanism, completely decoupled from this monorepo's own folder layout — production doesn't pull any of them via this repo. Physically relocating them would cost real coordination (an external collaborator's workflow for Scheduler, two separate CI/release pipelines) for zero functional benefit, so they stay at the workspace root, standardized in place instead.
