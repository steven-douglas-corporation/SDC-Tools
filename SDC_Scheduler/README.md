# SDC Project Scheduler

Web-based project scheduler for SDC Automation. Tasks, predecessors, multi-machine Gantt, per-project finances, audit trail, comments + @mentions, Total ETO procurement integration, and an AI assistant backed by Claude.

Single-page client (`public/app.js`) talks to an Express server (`server.js`) backed by MySQL (`mysqlDb.js`). Socket.io broadcasts task / team / settings updates so all open browser tabs refresh in real time.

---

## Quick start

```bash
git clone https://github.com/steven-douglas-corporation/SDC-Tools.git
cd SDC-Tools/SDC_Scheduler
npm install            # the Scheduler is an npm workspace of SDC-Tools; deps install at the repo root
cp .env.example .env        # fill in MYSQL_* at minimum; all other vars are optional
node server.js
# → http://localhost:3000
```

MySQL must be running and the database must exist before first boot. `db.js` creates all tables automatically on startup.

### Enable login

```bash
# Create the first admin
node create-admin.js --email you@sdcautomation.com --name "Your Name" --password "yourpass"

# Set AUTH_ENABLED=true in .env, then restart
node server.js
```

JWT tokens last 7 days. Without `AUTH_ENABLED=true` everyone is treated as admin.

### Enable Total ETO procurement drawer

Fill the `ETO_*` vars in `.env`. On boot the server calls `/api/eto/status`; if the bridge connects, the procurement drawer icon appears in the toolbar for projects that have a matching ETO job number.

### Enable AI chatbot

Set `ANTHROPIC_API_KEY` in `.env`. The chatbot icon in the toolbar opens a panel backed by `agent.js` — it can query the scheduler database and answer natural-language questions about tasks, projects, and dates.

### Enable email notifications

Fill `SMTP_*` in `.env`. Without those vars, @mentions still get logged to the `notification_log` table; with them set, mentions in comments trigger an email to the mentioned user.

---

## What's in here

| Path | What it is |
|---|---|
| `server.js` | Express app, all `/api/*` routes, cascade scheduler |
| `db.js` | MySQL schema bootstrap — creates all tables on startup |
| `mysqlDb.js` | MySQL connection pool (`mysql2/promise`) |
| `auth.js` | JWT middleware (`requireAuth`, `requireRole`) |
| `etoDb.js` | Total ETO bridge — read-only mssql connection to ERP server |
| `agent.js` | Claude AI assistant — tool-use loop, queries scheduler DB |
| `ops.js` | Reliability helpers: DB backups, health status, shared state |
| `backfillProjects.js` | Boot-time job: links orphan task-tabs to their ETO job numbers |
| `cronJobs.js` | Scheduled work (weekday-9am email digest) |
| `emailService.js` | Mention emails + dedupe via `notification_log` |
| `create-admin.js` | One-off script to seed the first user |
| `public/index.html` | Single-page shell |
| `public/app.js` | Everything-file: render, state, drag, edit, save |
| `public/auth-ui.js` + `auth-ui.css` | Login modal + user pill |
| `public/comments-ui.js` | Per-task 💬 badge + slide-in panel |
| `public/realtime-ui.js` | Socket.io client + invalidate handlers |
| `public/presence-ui.js` | "Who's editing" avatars |
| `public/phases.js` | `HIERARCHY` constant — section / department / sub-dep tree |
| `public/release-notes.js` | Rev history (only Dan bumps this) |
| `mcp/sdc-db-server.mjs` | MCP server — exposes scheduler DB to Claude via stdio |
| `mcp/dxt/` | Packaged DXT extension (rebuild with `npx @anthropic-ai/dxt pack`) |
| `scripts/server-auto-update.js` | Retired (ADR 0007): the Scheduler's old own updater. No longer started; do not run it. Deployment is `sdc-main-updater` (see Production deployment) |
| `CLAUDE.md` | Working rules for Claude when editing this codebase |
| `ARROW_ROUTING_RULES.md` | Arrow / predecessor routing reference |
| `ARCHITECTURE.md` | Deeper system design |
| `CONTRIBUTING.md` | Branch / commit / PR conventions |

---

## Features

- **Hierarchy-aware scheduling.** Tasks live in sections (10 / 40 / 50) → departments → sub-departments. Sub-section headers in the grid + colored Gantt bars match the same hierarchy.
- **Predecessor graph with lag.** `5FS +1w`, `12SS -3d` etc. Server cascades start/end dates whenever you change a duration or a predecessor.
- **Work-day Gantt.** Weekends compressed out. Monday header labels, T/W/Th/F dashed lines. Bars stay on full days, never sub-day.
- **Multi-machine support.** Per-project machine sub-tabs, machine-colored bar borders, clone-machine flow that duplicates tasks with predecessor remapping.
- **Baseline snapshot.** Capture the original plan; drift chips show ahead / behind against baseline.
- **Quote vs Schedule modal.** Per-discipline comparison of estimated vs scheduled hours. Sales workspaces collapse the 10 detailed buckets into 5 combined ones.
- **Total ETO procurement drawer.** Links a project to its ETO job number; shows BOM readiness broken down by vendor and PO line. Requires `ETO_*` env vars and a matching job number on the project.
- **AI assistant.** Natural-language chatbot powered by Claude. Can query tasks, projects, dates, and schedules. Requires `ANTHROPIC_API_KEY`.
- **Audit trail.** Every task create / update / delete logs to `task_history` with full before / after JSON.
- **Comments + @mentions.** Per-row 💬 badge opens a slide-in panel. @Name autocompletes against `team_members`; mentions trigger optional email.
- **Real-time sync.** Open two browser tabs — edits in one show up in the other within a second.
- **Optimistic concurrency.** Two users editing the same row → second save returns 409 + the latest server row instead of silent overwrite.
- **Role-based access.** `viewer` / `editor` / `admin`. Set per user via `create-admin.js`. With `AUTH_ENABLED=false` everyone is treated as admin.
- **Automated backups.** `ops.js` runs `mysqldump` on a schedule; dumps land in `backups/` (gitignored) with configurable retention.

---

## Stack

- **Server**: Node 22, Express, `mysql2` (MySQL), `mssql` (Total ETO read-only), Socket.io, `@anthropic-ai/sdk`, jsonwebtoken, bcryptjs, nodemailer, node-cron.
- **Client**: vanilla JS — no framework. Frappe Gantt for the chart. SheetJS for xlsx import/export.
- **Persistence**: MySQL is the primary store. Total ETO (read-only mssql) is queried for procurement data.
- **MCP**: `mcp/sdc-db-server.mjs` exposes the scheduler DB as an MCP tool server for use with Claude Desktop or DXT.

---

## Configuration reference

All env vars except `MYSQL_*` are optional. Defaults shown below.

### Core

| Var | Default | Effect |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `AUTH_ENABLED` | `false` | Require JWT on every `/api/*` |
| `JWT_SECRET` | dev-only string | Used to sign tokens — **set this in prod** |

### MySQL (required)

| Var | Default | Effect |
|---|---|---|
| `MYSQL_HOST` | `localhost` | MySQL server hostname |
| `MYSQL_PORT` | `3306` | MySQL port |
| `MYSQL_USER` | `root` | MySQL user |
| `MYSQL_PASSWORD` | — | MySQL password |
| `MYSQL_DATABASE` | `sdc_scheduler` | Database name |

### Total ETO bridge (optional — enables procurement drawer)

| Var | Default | Effect |
|---|---|---|
| `ETO_HOST` | — | SQL Server hostname for Total ETO |
| `ETO_DATABASE` | — | ETO database name |
| `ETO_PORT` | `1433` | SQL Server port |
| `ETO_DOMAIN` | — | Windows domain for NTLM auth |
| `ETO_USER` | — | ETO login user |
| `ETO_PASSWORD` | — | ETO login password |

### Anthropic AI assistant (optional — enables chatbot)

| Var | Default | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API key |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model ID |
| `ANTHROPIC_MAX_TOKENS` | `1024` | Max tokens per response |

### Email (optional)

| Var | Default | Effect |
|---|---|---|
| `SMTP_HOST` | — | Enable email when set |
| `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | Standard SMTP config |
| `APP_URL` | `http://localhost:3000` | Used in mention email links |

### Backups (optional)

| Var | Default | Effect |
|---|---|---|
| `BACKUP_DIR` | `./backups` | Where mysqldump files land |
| `BACKUP_KEEP_DAYS` | `14` | Days before old dumps are deleted |
| `MYSQLDUMP_PATH` | `mysqldump` | Path to mysqldump binary if not on PATH |

---

## Production deployment (PM2)

This folder is part of the SDC-Tools repository (ADR 0007, 2026-11-25), and PM2 manages the scheduler as `sdc-scheduler` (port 4003). It is deployed like the other SDC-Tools apps:

- **`sdc-main-updater`** (running inside `sdc-updater-hub`) polls SDC-Tools `master` every 5 min. When `master` moves it checks out the changed files, runs `npm install` if `SDC_Scheduler/package.json` or its lockfile changed, and restarts `sdc-scheduler` when any file under `SDC_Scheduler/` changed. The other apps it owns restart too.
- The old `sdc-scheduler-updater` (polling `danbelliveau2/SDC_Scheduler`) and the `sdc-scheduler-repo-sync` job are retired. Pushing to the old repository no longer deploys anything.

There is no manual update trigger any more (the old one on port 4013 is gone). To check for an update immediately, restart `sdc-updater-hub` with `pm2` as the account that owns it.

---

## Working rules (for anyone editing this)

Read `CLAUDE.md`. The short version:

1. **Never bump the rev** in `public/release-notes.js`. Only Dan does that.
2. **Never tell anyone to open dev tools.** Use visible UI, in-app toasts, or just fix the thing.
3. **Never commit without being asked.**
4. **Never claim it works without verifying.**
5. **Keep the personal view aligned with the main Schedule view.** Same patterns, same layout, same row alignment.
