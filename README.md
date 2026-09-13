# SDC Tools

**Stevens Douglas Corp. — Engineering Applications Suite**

SDC Tools is a Windows desktop application (Electron) that bundles six internal engineering web apps into a single unified launcher. Each app runs as its own Node.js server on a dedicated port on the company server (`SERVER-APP1`); the Electron shell is a thin client that provides a dashboard, authentication, auto-update, and one-click access to every app over HTTP.

See [docs/APPLICATIONS.md](docs/APPLICATIONS.md) for what each app does and [docs/PORTS.md](docs/PORTS.md) for the full port registry. [ARCHITECTURE.md](ARCHITECTURE.md) covers how the pieces fit together in detail.

---

## Applications

| App | Port | Description |
|-----|------|-------------|
| **Assemblies Library** | 4001 | SolidWorks CAD assembly search, preview & vault management |
| **Build Readiness Report** | 4002 | Live ETO project build status — parts, prints, sign-offs |
| **SDC Scheduler** | 4003 | Gantt scheduling, procurement tracking, job hours, SDC Assistant |
| **State Logic Builder** | 4004 | Visual PLC state-machine editor → Allen-Bradley L5X export |
| **SDC Calendar** | 4005 | Company-wide calendar — events, birthdays, paydays, Scheduler sync |
| **SDC Reports** (ETC Planner) | 4006 | Replaces the manual ETC/Job-Cost Excel workbooks with a live shared app |

Every app owns its own local MySQL database, except Build Readiness Report (reads Total ETO directly) and SDC Reports (Prisma-managed MySQL). See [ARCHITECTURE.md § Databases](ARCHITECTURE.md#databases).

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 22 LTS |
| npm | 10+ |
| PM2 | latest (`npm install -g pm2`) |

---

## Quick Start (Development)

```bash
# 1. Clone the repo
git clone https://github.com/steven-douglas-corporation/SDC-Tools.git
cd SDC-Tools

# 2. Install all workspace dependencies
npm install

# 3. Set up environment files (see Environment Variables section below)

# 4. Run the Electron shell in dev mode (connects to SERVER-APP1 backends)
npm run dev
```

`npm run dev` starts Vite on port 5173 for hot-reload, then launches Electron. Each sub-app is reached over HTTP on its port on `SERVER-APP1` (or `localhost` if `SDC_SERVER_HOST` is unset). To run a single app standalone for local development:

```bash
npm run dev:assemblies       # or dev:build-readiness, dev:scheduler, dev:state-logic,
                              # dev:calendar, dev:shell, dev:reports
```

`SDC_Scheduler` and `sdc-etc-planner` are each their own independent git repository — clone/pull them separately; they aren't part of this repo's git history (see [ARCHITECTURE.md](ARCHITECTURE.md)).

---

## Server Setup (PM2 — SERVER-APP1)

All six backends run on the company server via PM2:

```bash
# First-time setup on SERVER-APP1
npm install
pm2 startOrRestart ecosystem.config.js
pm2 save
pm2 startup   # follow printed command to auto-start on boot
```

**Backend auto-updates are fully automatic.** One PM2 process, `sdc-updater-hub`, runs four independent pollers (merged from four separate PM2 apps into one process for operational simplicity):

| Poller | Watches | Interval | Manual trigger |
|--------|---------|----------|----------------|
| Monorepo (`sdc-main-updater.js`) — incl. Assemblies, **Build Readiness**, Calendar | `steven-douglas-corporation/SDC-Tools` `master` | 5 min | — |
| SDC Scheduler | `danbelliveau2/SDC_Scheduler` `main` | 2 min | `POST :4013/trigger` |
| State Logic Builder | `danbelliveau2/state_logic_builder` GitHub Releases | 5 min | `POST :4014/trigger` |

SDC Reports has no live auto-updater — deploy it with `npm run deploy` from inside `sdc-etc-planner/` (see the warning in `ecosystem.config.js` about a measured Windows PM2 restart bug for that app specifically before restarting it any other way).

---

## Environment Variables

Every app loads its own `.env` from its own folder via `dotenv` — copy each `.env.example` to `.env` in place and fill in real values. Never commit a filled-in `.env`.

### Assemblies Library (`apps/assemblies/.env`)
```env
PORT=4001
SHARED_BASE=\\stevendouglas.local\dfs\Company\Job Folder\_Assembilies_Library_Application
DELETE_PASSWORD=your_delete_password
DRIVE_N=N:/
DRIVE_L=L:/
ALLOWED_ORIGIN=http://127.0.0.1:4001
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_mysql_password
MYSQL_DATABASE=sdc_assemblies
# SDC_SESSION_SECRET / SDC_SSO_ENABLED — see "Centralized login" below
```

### Build Readiness Report (`apps/build-readiness/.env`)
```env
PORT=4002
ETO_HOST=SERVER-APP1.stevendouglas.local
ETO_DATABASE=SDC
ETO_USER=your_user
ETO_PASSWORD=your_password
ETO_DOMAIN=stevendouglas
ETO_PORT=1433
# Build-start/ship dates now come from SDC Scheduler's own integration API —
# MUST match SDC_Scheduler/.env's READINESS_SHARED_TOKEN
SCHEDULER_URL=http://localhost:4003
READINESS_SHARED_TOKEN=your_shared_token
```
Note: the code falls back to port **3000** if `PORT` is unset — production always sets `PORT=4002` explicitly via `ecosystem.config.js`, so this only matters on a fresh checkout run standalone.

### SDC Scheduler (`SDC_Scheduler/.env`)
```env
# MySQL — primary database (required)
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=sdc_scheduler

AUTH_ENABLED=true
JWT_SECRET=your_jwt_secret

# ETO on-prem SQL Server (optional — procurement + job hours features)
ETO_HOST=SERVER-APP1.stevendouglas.local
ETO_DATABASE=SDC
ETO_USER=your_user
ETO_PASSWORD=your_password
ETO_DOMAIN=stevendouglas
ETO_PORT=1433

# Anthropic Claude API (optional — SDC Assistant AI feature)
ANTHROPIC_API_KEY=your_key

# Base URL for links in outbound emails — omit and they silently point at
# localhost:3000 instead (a real bug fixed 2026-08-23)
APP_URL=http://SERVER-APP1:4003
```
The code's own fallback port is **3000** (this is also `.claude/launch.json`'s local dev preview port) — production always overrides it to **4003** via `ecosystem.config.js`.

### State Logic Builder (`apps/state-logic/.env`)
```env
PORT=4004
STANDARDS_DIR=N:\AI Folder\State Logic Diagrams\standards
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=sdc_statelogic
```

### SDC Calendar (`apps/calendar/.env`)
```env
PORT=4005
SERVER_IP=SERVER-APP1
FRONTEND_URL=http://SERVER-APP1:4005
ALLOWED_ORIGINS=http://SERVER-APP1:4005
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=sdc_calendar
# SMARTSHEET_API_TOKEN / TEAMS_WEBHOOK_URL — optional integrations
```

### SDC Reports (`sdc-etc-planner/.env`)
See that repo's own `.env.example` — it manages a much larger, Next.js/Prisma-specific set (`DATABASE_URL`, `AUTH_SECRET`, Total ETO + Power BI service-principal creds, the Paylocity workbook path, and the Scheduler integration variables). Not duplicated here since it's a separate repo with its own deploy.

### Shell (`apps/shell/.env`)
```env
SDC_SERVER_HOST=SERVER-APP1
AZURE_TENANT_ID=your_tenant_id
AZURE_CLIENT_ID=your_client_id
```

### Centralized login (SSO) — currently dormant everywhere
```env
SDC_SESSION_SECRET=your_shared_sso_secret
# SDC_SSO_ENABLED=true
```
Same secret value across Scheduler (which mints sessions) and Assemblies/Build Readiness/State Logic/Calendar (which only verify). `SDC_SSO_ENABLED` defaults off/unset in every app — no behavior change until deliberately turned on.

---

## Releasing a New Shell Version

Releases are **fully automated** via GitHub Actions:

1. Bump `"version"` in `apps/shell/package.json`
2. Commit and push to `master`

```bash
git add apps/shell/package.json
git commit -m "chore: release v1.9.0"
git push
```

GitHub Actions detects the version change, builds the Windows NSIS installer, and publishes it to GitHub Releases. Every installed copy silently downloads and installs the update on next quit (within ~30 minutes of release).

> **Backend updates** (Assemblies, Build Readiness, Scheduler, State Logic, Calendar) do **not** need a new shell release — the auto-updaters in `sdc-updater-hub` handle them independently. SDC Reports is deployed manually (`npm run deploy`).

---

## Project Structure

```
Centralized library/
├── apps/
│   ├── shell/                       Electron launcher (main process + React UI)
│   ├── assemblies/                  Assemblies Library
│   ├── build-readiness/             Build Readiness Report
│   ├── state-logic/                 State Logic Builder
│   └── calendar/                    SDC Calendar
│
├── SDC_Scheduler/                    Own repo (danbelliveau2/SDC_Scheduler) — not moved
├── sdc-etc-planner/                  SDC Reports — own repo (sdc-sheets) — not moved
├── SDC-PowerBI-DEV/                  Power BI project — own repo — not moved, not a service
│
├── packages/                         Shared code (nothing extracted yet — see packages/README.md)
├── docs/
│   ├── APPLICATIONS.md
│   └── PORTS.md
│
├── scripts/
│   ├── sdc-updater-hub.js            Runs all 4 backend auto-updaters in one PM2 process
│   └── sdc-main-updater.js
│
├── .github/workflows/
│   ├── release.yml                   Build + publish installer on shell version bump
│   └── ci.yml                        Per-app PR checks
│
├── ecosystem.config.js               PM2 process definitions for SERVER-APP1
├── .env.example                      Environment variable reference (names only)
├── .gitignore
├── package.json                      npm workspaces root
└── ARCHITECTURE.md                   Full architecture reference
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 35, electron-builder, electron-updater |
| Launcher UI | React 18, Vite 5 |
| Sub-app servers | Node.js 22, Express 4 (SDC Reports: Next.js 16) |
| Sub-app frontends | React/Vite (Assemblies, State Logic, Build Readiness, Reports), Vanilla JS (Scheduler, Calendar's legacy fallback) |
| Databases | MySQL `mysql2` (Assemblies, Scheduler, State Logic, Calendar), Prisma/MySQL (Reports), Total ETO on-prem MSSQL (Build Readiness, Scheduler, Reports — read-only) |
| Authentication | Azure AD MSAL (shell), plus a dormant shared-cookie SSO layer across 5 apps and a separate NextAuth login for Reports |
| CI/CD | GitHub Actions → GitHub Releases (shell installer only; backends self-update) |
| Process management | PM2 (SERVER-APP1) |

---

*Stevens Douglas Corp. — Internal tooling. Not for public distribution.*
