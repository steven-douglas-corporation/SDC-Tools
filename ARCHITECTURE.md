# SDC Tools — Architecture

## Table of Contents
1. [High-Level Overview](#high-level-overview)
2. [Electron Shell](#electron-shell)
3. [How the Shell Talks to the Apps](#how-the-shell-talks-to-the-apps)
4. [Databases](#databases)
5. [Authentication](#authentication)
6. [Auto-Update Pipeline](#auto-update-pipeline)
7. [IPC Contract (Electron ↔ Renderer)](#ipc-contract-electron--renderer)
8. [Sub-App Details](#sub-app-details)
9. [Release & CI/CD](#release--cicd)
10. [Directory Layout](#directory-layout)

---

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Electron Shell (thin client)             │
│                                                               │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │  BrowserWindow    │    │     processManager.js         │   │
│  │  (React UI)       │◄──►│  HTTP health-polls each app   │   │
│  └──────────────────┘    │  opens a BrowserWindow at its  │   │
│                           │  URL — never spawns anything   │   │
│                           └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │  HTTP (GET /health)
                              ▼
        ┌──────────────────────────────────────────────────┐
        │              SERVER-APP1  (PM2)                   │
        │  assemblies :4001   readiness  :4002              │
        │  scheduler  :4003   statelogic :4004               │
        │  calendar   :4005   etc-planner:4006               │
        └──────────────────────────────────────────────────┘
         │            │            │            │
         ▼            ▼            ▼            ▼
   MySQL (local, one DB per app)   Total ETO (MSSQL, read-only)
```

All six apps are independent, always-on Node.js processes managed by PM2 on `SERVER-APP1`. The Electron shell is a **pure thin client** — it never spawns or `require()`s any app. It just polls each app's health endpoint and, when the user clicks a tile, opens a `BrowserWindow` pointed at that app's URL on the server.

---

## Electron Shell

### Entry Point — `apps/shell/electron/main.js`

Responsibilities:
- Creates the `BrowserWindow` (launcher UI)
- Initialises `processManager` and starts polling all 6 apps
- Handles Azure AD authentication via MSAL
- Registers IPC handlers (status, logs, open-app, restart, stop, update)
- Sets up `electron-updater` for auto-updates (checks every 30 min)
- Drives the SDC Reports SSO hand-off on open (see [Authentication](#authentication))

### Process Manager — `apps/shell/electron/processManager.js`

```
ProcessManager
├── configs: { [id]: { port, url, healthPath, ... } }   static per-app config
├── _statuses: Map<id, 'starting'|'running'|'error'|'stopped'>
└── _logs: Map<id, string[]>                             buffered log lines for the UI
```

Its own header comment says it plainly: *"Backends run on the company server PC managed by PM2. This module pings their health endpoints and reports status to the UI. No processes are spawned locally — the Electron shell is a pure thin client."*

**What it actually does, every 20 seconds per app:**
1. `GET http://{SDC_SERVER_HOST}:{port}{healthPath}` (host defaults to `localhost` for local dev)
2. 2xx–4xx → `running`; timeout or network error → `error`
3. Pushes a status-change event to the renderer

**Why this replaced in-process loading:** every app still exports a dormant `startServer({port})` from an earlier design where the shell would `require()` each app directly into its own process. That convention is unused today — nothing in the shell calls it. Keeping the export costs nothing; don't assume it's load-bearing.

---

## How the Shell Talks to the Apps

Each app remains an ordinary standalone Express server, started by PM2 with its own `PORT` env var (`ecosystem.config.js`). The shell has zero special integration beyond HTTP health checks and, for SDC Reports specifically, a one-time SSO hand-off token so opening that tile doesn't prompt for a second login (see [Authentication](#authentication)).

There is no shared in-process runtime, no `resources/apps/` bundling of backend code into the installer, and no packaged-app path resolution — the current `electron-builder.yml` bundles only `electron/**`, the built launcher UI, icons, and its own `package.json`/`.env`. Backends are never bundled; they run wherever PM2 runs them.

---

## Databases

There is **no shared Azure SQL instance** today — each app owns its own local MySQL database on `SERVER-APP1` (`localhost:3306`), migrated off Azure SQL/SQLite between 2026-05 and 2026-06-11 after recurring login/availability issues with the shared Azure SQL server:

| App | Database | Driver |
|---|---|---|
| Assemblies Library | `sdc_assemblies` | `mysql2` |
| Build Readiness Report | *(none of its own)* | — reads Total ETO directly |
| SDC Scheduler | `sdc_scheduler` | `mysql2` |
| State Logic Builder | `sdc_statelogic` (+ local-JSON fallback) | `mysql2` |
| SDC Calendar | `sdc_calendar` | `mysql2` |
| SDC Reports | its own MySQL DB, via Prisma | `@prisma/client` |

Two apps also read a second, external database read-only:

- **Total ETO** (on-prem SQL Server, `SERVER-APP1.stevendouglas.local:1433`, database `SDC`) — read-only source of truth for jobs/parts/prints. Used directly by Build Readiness Report and SDC Scheduler (`lib/etoDb.js`), and by SDC Reports (raw `mssql` queries, mostly pre-synced).
- **SDC Scheduler's own MySQL**, read read-only by SDC Reports (`SCHEDULER_DATABASE_URL`, mirrors the team roster) and by SDC Calendar (a `better-sqlite3` bridge to a `scheduler.db` SQLite file that, in production, doesn't exist — Scheduler runs MySQL-only in production, so that bridge's routes currently always return `[]`; it only matters for local dev setups that still use SQLite).

**Why MySQL over the old shared Azure SQL:** each app gets an independent, always-reachable local database with no cross-app schema coupling or shared-login failure mode; no native driver mismatch risk in the (now-dormant) in-process Electron loading path.

---

## Authentication

Two layers exist, and most apps only implement one of them:

**1. Shell login (Azure AD via MSAL)** — the shell itself authenticates the user against Azure AD (Authorization Code + PKCE, loopback redirect). If `AZURE_TENANT_ID` isn't set, it auto-authenticates as `Dev Mode`.

**2. Centralized SDC Tools SSO (`sdc_session` cookie)** — added 2026-08-20, currently **dormant everywhere** (`SDC_SSO_ENABLED` defaults off in every app's `.env`). When enabled: SDC Scheduler acts as the identity broker (`routes/ssoCentral.js`), minting a JWT signed with a secret shared across Assemblies, Build Readiness, State Logic, and Calendar (each verifies it via an identical, currently-duplicated `sdcSessionAuth.js` — see [packages/README.md](packages/README.md)). SDC Reports is deliberately **not** part of this shared cookie — it has its own separate NextAuth (Credentials-only) login, reached instead through a purpose-built one-time SSO hand-off token that Scheduler mints and the shell drives when the Reports tile opens (`apps/shell/electron/main.js`, `apps/shell/electron/sdcSession.js`).

Until `SDC_SSO_ENABLED` is turned on, every app behaves exactly as it does today — no login-flow change happens as a side effect of this doc update.

---

## Auto-Update Pipeline

Two independent update mechanisms exist — don't confuse them:

### Desktop shell (OTA installer)

```
Developer bumps version in apps/shell/package.json
        │
git push → master
        │
GitHub Actions (windows-latest runner) — .github/workflows/release.yml
        ├── check-version: compare HEAD vs HEAD~1
        ├── Build apps/shell's Vite UI, electron-builder --publish always
        └── Uploads SDC-Tools-Setup-<version>.exe + latest.yml to GitHub Releases
                │
                ▼
        Installed copies poll every 30 min, silently download,
        show a "Restart & Install" banner — never auto-installs on quit.
```

### Backend servers (live, no shell release needed)

One PM2 process, `sdc-updater-hub`, runs three independent pollers in a single Node process (merged from separate PM2 apps for operational simplicity — each poller's own error handling is unchanged):

| Poller | Watches | Interval | Manual trigger | Scope of what it overwrites |
|---|---|---|---|---|
| `sdc-main-updater.js` | `steven-douglas-corporation/SDC-Tools` (this monorepo's `master`) | 5 min | — | Everything **except** paths owned by the two updaters below; selective `git checkout` per changed file, `git reset --soft`; rebuilds the Assemblies and Build Readiness Vite bundles when their sources change; restarts `sdc-assemblies`, `sdc-readiness`, `sdc-calendar`. Only fast-forwards — it skips the update when local `HEAD` is ahead of or diverged from the remote |
| `server-auto-update.js` (inside `SDC_Scheduler/scripts/`) | `danbelliveau2/SDC_Scheduler` `main` | 2 min | `POST :4013/trigger` | **Whole repo**, `git reset --hard origin/main` — any local uncommitted change here is destroyed within 2 minutes |
| `server-auto-update.js` (inside `apps/state-logic/scripts/`) | `danbelliveau2/state_logic_builder` GitHub *Releases* (not every commit) | 5 min | `POST :4014/trigger` | `src/`, `public/`, `index.html` only — `server.js`/DB files/`.env` preserved |

`sdc-etc-planner` (SDC Reports) and `SDC-PowerBI-DEV` have no live auto-updater — they're deployed manually (`npm run deploy` for Reports; Power BI Desktop publish for the PBI project).

---

## IPC Contract (Electron ↔ Renderer)

The preload script exposes `window.shellAPI` to the React renderer:

| Method | Direction | Description |
|--------|-----------|--------------|
| `getStatus()` | renderer → main | Returns current status of all apps |
| `onStatusChange(cb)` | main → renderer | Push updates when any app status changes |
| `openApp(id)` | renderer → main | Opens the app in a new BrowserWindow |
| `retryApp(id)` | renderer → main | Retries a failed app |
| `stopAll()` / `restartAll()` | renderer → main | Stops/restarts health polling (does **not** touch the remote PM2 processes) |
| `getLogs(id)` / `onAppLog(cb)` | both | Buffered/live health-check log lines |
| `getAppVersion()` | renderer → main | Returns current shell version string |
| `onUpdateStatus(cb)` / `updateDownload()` / `updateInstall()` | both | Shell's own OTA update lifecycle |
| `getLaunchOnStartup()` / `setLaunchOnStartup(v)` | both | Windows startup toggle |
| `authGetStatus()` / `authLogin()` / `authLogout()` | both | Shell's own Azure AD (MSAL) session |
| `getNotifications()` / `onNotificationsUpdated(cb)` | both | Notification center |

---

## Sub-App Details

### Assemblies Library (port 4001)
- **Backend**: Express + `mysql2` → `sdc_assemblies`
- **Frontend**: React + Vite, built to `client/dist/`, served statically
- **Key feature**: Fuzzy search — broad SQL `LIKE` filter → JS scoring + pagination
- **Sync**: file-system scanner syncs the SolidWorks vault directory to MySQL on schedule

### Build Readiness Report (port 4002)
- **Backend**: Express + `mssql` (Total ETO, read-only)
- **Frontend**: React served statically
- **Key feature**: ETO project readiness checklist. Build-start/ship dates now come from SDC Scheduler's own integration API (`SCHEDULER_URL`), replacing an earlier Smartsheet integration that's been fully removed.

### SDC Scheduler (port 4003)
- **Backend**: Express + Socket.io + MySQL (`mysql2` pool, `lib/mysqlDb.js`) — routes split across 12 files in `routes/`, shared logic in `lib/`
- **Frontend**: Vanilla JS single-page app (`public/app.js`, ~26k lines)
- **ETO integration**: read-only `lib/etoDb.js` feeds procurement BOM, vendor PO sync, job hours
- **Key features**: Gantt scheduling (predecessor FS/SS/FF/SF + lag), procurement drawer, vendor PO tracking, Power BI job-hours chart, SDC Assistant (Claude AI), Socket.io presence
- **Not moved** in the 2026-08 restructuring — own standalone git repo, external collaborator (Dan) owns the frontend files

### State Logic Builder (port 4004)
- **Backend**: Express + `mysql2` → `sdc_statelogic` (local-JSON fallback if MySQL is unreachable)
- **Frontend**: React + Vite, React Flow canvas
- **Key feature**: visual PLC state-machine editor exporting Allen-Bradley ControlLogix L5X
- Also ships as a **separate standalone Electron desktop installer** (its own release pipeline, local port 3131) — independent of the PM2 web app above

### SDC Calendar (port 4005)
- **Backend**: Express + `mysql2` → `sdc_calendar`
- **Frontend**: React + Vite (plus a legacy vanilla-JS `frontend/` fallback)
- **Key feature**: company-wide calendar, employee directory, read-only Scheduler task overlay

### SDC Reports / ETC Planner (port 4006, renumbered from 3010 on 2026-08-23)
- **Backend**: Next.js 16 Server Actions + Prisma (own MySQL), raw `mssql`/`mysql2` for the two external read-only sources
- **Frontend**: Next.js App Router, ag-Grid, ECharts
- **Key feature**: replaces three manually-maintained Excel workbooks (Project Planner Data Control, End of Month ETC, Standard Fees) with a live shared app; reads Paylocity job-hours exports from a OneDrive-synced folder via a self-validating year-range source table (`src/lib/paylocity-sources.ts`) — do not alter this casually
- **Not moved** — own standalone git repo (`sdc-sheets`)

### Power BI Dev (no port)
- Power BI Desktop source files (`.pbix`/`.pbip`) plus a .NET 8 MCP server, published as a self-contained exe and spawned **on demand** (stdio, not a daemon) by SDC Scheduler's `lib/hoursApi.js` to run DAX queries
- **Not moved** — own standalone git repo (`SDC-PowerBI`), not a service

---

## Release & CI/CD

### `.github/workflows/release.yml`
```
Trigger: push to master where apps/shell/package.json version changed
Runner:  windows-latest

Steps:
  1. check-version (ubuntu)   — fast diff, sets should_release output
  2. build-and-release (win)  — only if should_release == true
     a. Checkout
     b. Setup Node 22
     c. Write apps/shell/.env from GitHub Secrets
     d. npm install (apps/shell only — deliberately excluded from the root
        npm workspace so electron-builder resolves its own local electron binary)
     e. npm run build (Vite launcher UI)
     f. electron-builder --win --publish always
     g. Upload the installer as a 90-day workflow artifact
```

### `.github/workflows/ci.yml`
- Runs on every push/PR, one job per app, each scoped to its own `apps/<name>` (or `SDC_Scheduler`) working directory
- Installs deps and runs whatever build/test/syntax-check that app defines

---

## Directory Layout

```
Centralized library/
│
├── apps/
│   ├── shell/                       Electron launcher (main process + React UI)
│   │   ├── electron/
│   │   │   ├── main.js              Entry — BrowserWindow, IPC, auto-updater, SSO hand-off
│   │   │   ├── processManager.js    Thin HTTP health-poll client (no spawning)
│   │   │   ├── auth.js              Azure AD (MSAL) authentication
│   │   │   ├── sdcSession.js        Shared-cookie sign-out + Reports SSO hand-off
│   │   │   ├── preload.js / appPreload.js
│   │   ├── src/                     React launcher UI (Vite)
│   │   ├── electron-builder.yml     Installer config — bundles electron/dist/icons only
│   │   └── package.json
│   │
│   ├── assemblies/                  Assemblies Library (Express + React/Vite + MySQL)
│   ├── build-readiness/             Build Readiness (Express + React, ETO SQL)
│   ├── state-logic/                 State Logic Builder (Express + React/Vite + MySQL)
│   └── calendar/                    SDC Calendar (Express + React/Vite + MySQL)
│
├── SDC_Scheduler/                    Own standalone repo (danbelliveau2/SDC_Scheduler) — NOT moved
├── sdc-etc-planner/                  SDC Reports — own standalone repo (sdc-sheets) — NOT moved
├── SDC-PowerBI-DEV/                  Power BI project — own standalone repo — NOT moved, not a service
│
├── packages/
│   └── README.md                     Convention doc; no shared code extracted yet
│
├── docs/
│   ├── APPLICATIONS.md               Every app: purpose, port, start command, data sources
│   └── PORTS.md                      Definitive port registry
│
├── scripts/
│   ├── sdc-updater-hub.js            Runs all 4 backend auto-updaters in one PM2 process
│   └── sdc-main-updater.js           Monorepo-level updater (assemblies/readiness/calendar)
│
├── .github/workflows/
│   ├── release.yml                   Build + publish installer on shell version bump
│   └── ci.yml                        Per-app PR checks
│
├── ecosystem.config.js               PM2 process definitions for SERVER-APP1 (7 apps)
├── .env.example                      Environment variable reference (names only)
├── .gitignore
├── package.json                      npm workspaces root
└── ARCHITECTURE.md                   ← this file
```
