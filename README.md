# SDC Tools

**Stevens Douglas Corporation — engineering applications suite**

Six internal web applications behind one Windows desktop launcher. Each app is
a Node.js service on its own port on the company server `SERVER-APP1`; the
Electron shell is a thin client that signs the user in, shows the dashboard,
keeps itself updated, and opens each app over HTTP.

| App | Path | Port | pm2 process | Stack |
|---|---|---:|---|---|
| Assemblies Library | `apps/assemblies` | 4001 | `sdc-assemblies` | Express, Vite + React, Azure SQL |
| Build Readiness Report | `apps/build-readiness` | 4002 | `sdc-readiness` | Express, Vite + React, Total ETO (MSSQL), Smartsheet |
| SDC Scheduler | `SDC_Scheduler/` (separate repo) | 4003 | `sdc-scheduler` | Express, Socket.io, MySQL |
| State Logic Builder | `apps/state-logic` | 4004 | `sdc-statelogic` | Express, Vite + React Flow, Azure SQL |
| SDC Calendar | `apps/calendar` | 4005 | `sdc-calendar` | Express, Vite + React, MySQL |
| SDC Reports | `apps/reports` | 4006 | `sdc-reports` | Next.js 16, Prisma, MySQL, Total ETO |
| Desktop shell | `apps/shell` | — | published installer | Electron, Vite + React, MSAL |

Not services: `tools/powerbi` (Power BI report sources and the MCP server),
`packages/` (code shared by two or more apps), `scripts/` (server updater and
repo checks), `docs/` (architecture, ports, runbook, decision records).

## Read these first

| Document | What it answers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the shell, the apps, auth, updates and databases fit together |
| [docs/APPLICATIONS.md](docs/APPLICATIONS.md) | What each app does, its data sources, its owner |
| [docs/PORTS.md](docs/PORTS.md) | The port registry, including support ports |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operating production: deploy path, restarts, health, rollback |
| [docs/BRANCH-PROTECTION.md](docs/BRANCH-PROTECTION.md) | The GitHub settings that keep unreviewed code off production |
| [docs/adr/](docs/adr/) | Why the repo is shaped the way it is |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Branching, the three commands every app answers, conventions |
| [CHANGELOG.md](CHANGELOG.md) | Notable changes by shell version |
| [SECURITY.md](SECURITY.md) | Reporting problems; what must never be committed |

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | 22 LTS (`.nvmrc`); production currently runs newer, the floor is 22 |
| npm | 10+ |
| pm2 | latest, production only (`npm install -g pm2`) |
| MySQL 8 | Scheduler, Calendar, Reports |

## Getting started

```bash
git clone https://github.com/steven-douglas-corporation/SDC-Tools.git
cd SDC-Tools
npm install                       # root + workspace apps
npm run install:all               # the apps that are not workspaces (calendar server, shell)
npm install --prefix apps/reports
```

The Scheduler is a separate repository (see
[ADR 0002](docs/adr/0002-scheduler-stays-a-separate-repository.md)); clone it
into `SDC_Scheduler/` if you need it locally.

Copy each app's `.env.example` to `.env` and fill it in. Then run one app:

```bash
npm run dev:assemblies            # dev:build-readiness, dev:state-logic, dev:calendar,
npm run dev:reports               # dev:scheduler, dev:shell
```

`npm run dev` starts the Electron shell against Vite on 5173; it talks to the
apps on `SDC_SERVER_HOST` (or `localhost` when unset).

## Quality gates

Every app answers the same three commands, and CI runs them on every push and
pull request (`.github/workflows/ci.yml`):

```bash
npm run lint      # ESLint — errors fail CI, warnings are shown
npm test          # unit tests; no database, network or running server needed
npm run build     # Vite clients, the Next.js app, the shell renderer
```

The JavaScript apps share one ESLint rule set
([packages/eslint-config](packages/eslint-config/README.md)); `npm run
lint:configs` at the root fails when an app's copy drifts. Reports has its own
TypeScript + Next configuration and the largest suite (2,200+ tests).

## How production is deployed

`master` is production. A push to it is picked up within five minutes by the
server updater (`scripts/sdc-main-updater.js`, pm2 `sdc-updater-hub`), which
checks out the changed files, rebuilds the affected apps, and restarts their
pm2 processes. Reports gets a stop → migrate → build → start sequence of its
own. Details and the by-hand equivalents are in
[docs/RUNBOOK.md](docs/RUNBOOK.md).

Bumping `"version"` in `apps/shell/package.json` on `master` builds and
publishes a desktop installer to GitHub Releases; installed shells update
themselves from there.

## Repository layout

```
apps/                 one directory per deployable app (own package.json, .env, lint/test/build)
  assemblies/  build-readiness/  calendar/  reports/  shell/  state-logic/
SDC_Scheduler/        separate repo, ignored here (ADR 0002)
tools/powerbi/        Power BI report sources, MCP server, design mock-ups
packages/             shared code — only what two or more apps import today
  eslint-config/      canonical ESLint rules, copied into each JS app
  design-system/      shared tokens and primitives
scripts/              server updater, release helpers, repo-wide checks
docs/                 architecture, ports, runbook, ADRs, reference documents
ecosystem.config.js   pm2 process definitions for SERVER-APP1
```

## License

Proprietary — Stevens Douglas Corporation. See [LICENSE.md](LICENSE.md).
