# Operations runbook — SDC Tools on SERVER-APP1

Everything here runs on one Windows Server box, `SERVER-APP1`, supervised by
pm2 from the production checkout at `D:\AI Projects\Centrailized library`.
pm2 runs under a service account: open a terminal as that account (or the
account that ran `pm2 start`) or `pm2 list` shows an empty table.

## The processes

| pm2 name | App | Port | Health | cwd |
|---|---|---|---|---|
| `sdc-updater-hub` | Server updater (monorepo + Scheduler + State Logic updaters in one process) | 4013 / 4014 triggers | log only | repo root |
| `sdc-assemblies` | Assemblies Library | 4001 | `GET /health` | `apps/assemblies` |
| `sdc-readiness` | Build Readiness | 4002 | `GET /health` | `apps/build-readiness` |
| `sdc-scheduler` | SDC Scheduler (separate repo) | 4003 | `GET /health` | `SDC_Scheduler` |
| `sdc-statelogic` | State Logic Builder | 4004 | `GET /health` | `apps/state-logic` |
| `sdc-calendar` | SDC Calendar | 4005 | `GET /api/health` | `apps/calendar` |
| `sdc-reports` | SDC Reports (Next.js) | 4006 | `GET /api/health` | `apps/reports` |

`docs/PORTS.md` is the port registry. Logs: `pm2 logs <name>`; files under
`%USERPROFILE%\.pm2\logs\`, rotated daily by `pm2-logrotate`.

## How code reaches production

1. A commit lands on `master` (via PR — see `BRANCH-PROTECTION.md`).
2. Within 5 minutes `scripts/sdc-main-updater.js` (inside `sdc-updater-hub`)
   sees the new SHA on GitHub, fetches, and checks out only the changed files
   that this repo owns. It refuses to act if the server's HEAD is ahead of or
   diverged from `origin/master` (that protects local work; it also means a
   local commit on the server **stops deploys** until it is pushed).
3. It runs `npm install` if a root `package.json` changed, rebuilds
   `apps/assemblies`, `apps/build-readiness` and `apps/calendar` when their files
   changed, and restarts `sdc-assemblies sdc-readiness sdc-calendar`.
4. Reports is special (`apps/reports/scripts/deploy.mjs`, design in
   `deploy-lib.mjs`). It keeps **two build folders**, `.next-a` and `.next-b`;
   the app serves the one named in `apps/reports/.active-dist`.
   - **Source-only change** (the usual case): the app **keeps running** while
     the new build is made in the spare folder. Then `pm2 stop`, free port 4006,
     point `.active-dist` at the new folder, `pm2 start`, and wait for
     `/api/health` to answer. Downtime is the few seconds that takes. A build
     that fails never touches the running app; a new build that does not come up
     is rolled back to the previous folder automatically.
   - **Changed `package.json`, `package-lock.json`, `prisma/schema.prisma` or
     `prisma/migrations/`**: these still need the app stopped (an install and
     `prisma generate` both fight the running app for files it holds open), so
     the order is `pm2 stop`, install, `prisma migrate deploy`, `prisma
     generate`, build, start. Expect ~60 s of downtime on 4006. The build still
     goes into the spare folder, so a failed build restarts the app on the
     build that was already serving.
   The updater loads its code when it starts, so the first Reports deploy after
   this arrived still ran the old stop-first flow. Run `pm2 restart
   sdc-updater-hub` once after it; every deploy after that uses the above.
5. State Logic and the Scheduler have their own updaters in the same hub,
   following their own upstream repos.

To deploy Reports by hand (same steps the updater takes; builds beside the
running app, then switches):

```bash
cd "D:\AI Projects\Centrailized library\apps\reports" && npm run deploy
```

It does not run `npm install` or the Prisma steps. After a dependency or schema
change, stop Reports first and run those by hand, then `npm run deploy`.
Individual steps: `node scripts/deploy.mjs build | activate | restart`.

## Restart, stop, start

```bash
pm2 restart sdc-assemblies            # any app except Reports
pm2 stop sdc-reports && pm2 start sdc-reports   # Reports: never bare restart (see below)
pm2 restart sdc-updater-hub           # after changing anything under scripts/
pm2 save                              # after add/delete so it survives a reboot
```

To see or change which build Reports serves: `apps/reports/.active-dist`
holds `.next-a` or `.next-b` (or `.next` before the first switch). Do not edit it
while the app is running; use `node scripts/deploy.mjs restart`, or stop the app,
change it, and start it.

Reports must be **stopped, then started**. A bare `pm2 restart` races the
previous `next start` for port 4006 and can leave a zombie holding the port
while pm2 reports success; `scripts/free-port.mjs` exists because of that.

## Health check, all apps

```bash
for p in 4001 4002 4003 4004; do curl -s -o /dev/null -w "$p %{http_code}\n" http://localhost:$p/health; done
for p in 4005 4006; do curl -s -o /dev/null -w "$p %{http_code}\n" http://localhost:$p/api/health; done
```

## Rollback

Revert the commit on `master` and push. The updater deploys the revert within
five minutes. To go back **immediately** on Reports, the previous build is still
on disk: stop Reports, put the other folder's name (`.next-a` / `.next-b`) in
`apps/reports/.active-dist`, run `node scripts/free-port.mjs 4006`, start Reports.
(Only the build before the current one is kept.)

Reverting the change that introduced the two-folder deploy is safe too: when
`apps/reports/scripts/deploy.mjs` is no longer in the tree, the updater (even
one that loaded its code before the revert) falls back to the original
stop-first steps, building into `.next`. Never force-push or reset `master`: the
updater only moves forward, and a rewritten history makes it skip every update. For Reports, a bad Prisma migration needs `npx prisma migrate
resolve --rolled-back <name>` before the revert deploys; the schema is the one
thing a revert does not undo on its own.

## Environment files

Each app reads `.env` from its own directory. They are not in git. The
`.env.example` beside each is the authoritative list of variables. Back them up
with the server; a fresh clone cannot start an app without them.

Reports reads Paylocity hours, the roster and position families from the PostgreSQL
DataWarehouse via `DATAWAREHOUSE_URL` (see `tools/data-warehouse/README.md`); the files
are no longer on the SFTP share.

## Desktop shell releases

Bumping `"version"` in `apps/shell/package.json` on `master` builds an
installer in GitHub Actions and publishes a Release; installed shells update
within about 30 minutes. Shells installed before 2026-09-13 (v2.1.0) point at
the retired personal repo and need one manual install of a current installer.

## Known sharp edges

- `git reset --hard` in `SDC_Scheduler/` every 2 minutes (its updater) wipes
  unpushed work there. Never edit the Scheduler in place on the server.
- The updater's "local HEAD is ahead" guard: if someone commits on the server
  without pushing, deploys silently stop. `pm2 logs sdc-updater-hub` says so.
- Port 4006 zombies — see Reports above.
- Total ETO (MSSQL) binding failures that look like an upstream outage are
  usually a bundling fault; see `apps/reports/DEVLOG.md` and
  `lib/totaleto-connection.ts`.
