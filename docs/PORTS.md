# Port Registry

This is the single source of truth for every port used by SDC Tools in production on `SERVER-APP1`. Application code and PM2 config should reference these values (via `ecosystem.config.js` env blocks) rather than hardcoding ports elsewhere.

Five of these six ports were **not renumbered** as part of the 2026-08 monorepo restructuring — each is baked into the currently-installed desktop shell (`apps/shell/electron/processManager.js`). Changing one costs a shell version bump, an installer release, waiting out the ~30-minute auto-update poll across every installed desktop copy, and a matching Windows Firewall rule change — not worth it for a cosmetic renumbering.

**SDC Reports is the one exception**, deliberately renumbered `3010 → 4006` on 2026-08-23 to bring it in line with the rest of the 400x block. That one *does* require the shell release described above — `apps/shell/package.json` was bumped to `1.8.1` and `processManager.js` updated, but shipping it (commit, push, let CI build the installer) is a separate, deliberate action, not yet done as of this writing. Until that release rolls out, any desktop shell still on `1.8.0` or earlier will keep health-checking Reports on the old port 3010 and show that tile as unreachable — open port 4006 in Windows Firewall before releasing.

## Application ports

| Port | App | PM2 process | Health check | Notes |
|-----:|-----|-------------|--------------|-------|
| 4001 | Assemblies Library | `sdc-assemblies` | `GET /health` | |
| 4002 | Build Readiness Report | `sdc-readiness` | `GET /health` | |
| 4003 | SDC Scheduler | `sdc-scheduler` | `GET /health` | Own git repo, external collaborator (Dan) |
| 4004 | State Logic Builder | `sdc-statelogic` | `GET /health` | |
| 4005 | SDC Calendar | `sdc-calendar` | `GET /api/health` | |
| 4006 | SDC Reports (ETC Planner) | `sdc-reports` | `GET /api/health` | Own git repo (`sdc-sheets`), separate Next.js deploy. Renumbered from 3010 — see above. |

Power BI Dev (`tools/powerbi/`) has **no port** — it is not an HTTP service. It's a folder of Power BI Desktop files plus a subprocess-invoked MCP executable (`mcp-server/publish/win-x64-new/sdc-powerbi-mcp.exe`) that SDC Scheduler's `lib/hoursApi.js` spawns on demand over stdio. It never binds a port.

The Electron shell itself is a desktop client, not a server — it has no production listening port. Its dev-mode Vite server uses the default `5173`.

## Support / infrastructure ports (localhost-only unless noted)

| Port | Purpose | Owner |
|-----:|---------|-------|
| 4100 | Read-only MCP database server | `SDC_Scheduler/mcp/sdc-db-server.mjs` |
| 4013 | Manual trigger — `POST /trigger` re-checks SDC Scheduler's external repo immediately | `SDC_Scheduler/scripts/server-auto-update.js` (runs inside `sdc-updater-hub`) |
| 4014 | Manual trigger — `POST /trigger` re-checks State Logic Builder's external repo immediately | `apps/state-logic/scripts/server-auto-update.js` (runs inside `sdc-updater-hub`) |

All four updaters (monorepo, Build Readiness, Scheduler, State Logic) run inside one PM2 process, `sdc-updater-hub` — see [DEPLOYMENT.md](../ARCHITECTURE.md#auto-update-pipeline) for what each one watches and how often.

## Reserved

`3000–3019` and `4007–4019` are unused today and reserved for future SDC web applications, per the original standardization request. Nothing currently claims them — check this file and `ecosystem.config.js` before assigning a new one.

## Local development

Several apps default to a different port when `PORT` isn't set (their code fallback, not the production value):

| App | Code fallback (dev only) |
|-----|---------------------------|
| Assemblies Library | 3001 (Vite dev proxy target) |
| Build Readiness Report | 3000 |
| SDC Scheduler | 3000 |
| SDC Calendar | 5174 (Vite dev server; API still 4005) |

These only matter for standalone local dev — every production PM2 process has `PORT` set explicitly in `ecosystem.config.js` and always wins.
