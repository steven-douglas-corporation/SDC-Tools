# Deployment

## Production build process

```bash
npm run deploy
```

This is `next build && node scripts/free-port.mjs 4006 && pm2 restart sdc-reports` — always
use this script, not a bare `pm2 restart`, for the reason in the next section.

First-time bring-up on a new box (not a redeploy): `pm2 start ecosystem.config.js && pm2 save`.

## The one thing that will bite you: PM2 does not reliably kill this process on Windows

`pm2 stop` / `pm2 restart` / `pm2 delete` can all report success while the old `next start`
process keeps the socket open — the new instance then crash-loops on `EADDRINUSE :::4006` every
few seconds, and PM2 keeps respawning it. **The dangerous part is that the old build keeps
serving the whole time**: `/api/health` stays `200`, the site looks fine, and the only symptom
is that your change isn't actually live.

`scripts/free-port.mjs` exists specifically to prevent this: it finds the exact process
listening on port 4006 (matched precisely off `netstat`, not by substring), kills it, waits for
the socket to clear, and **fails the deploy loudly (exit 1)** if a listener survives — on
purpose, because silently falling through to `pm2 restart` after a failed kill is exactly how
this bug reaches production unnoticed.

If you ever restart by hand instead of via `npm run deploy`: immediately run
`pm2 logs sdc-reports --err` and check for `EADDRINUSE`. If in doubt whether the new build
actually went live, compare `.next/BUILD_ID` on disk against the build id embedded in the
served HTML.

## Required runtime dependencies

- Node.js (version matching `next@16` requirements) and PM2, running under the interactive
  Windows user's session (not as a background service — see the PM2 estate note below).
- Network access to: this app's own MySQL, the Total ETO SQL Server, the Scheduler app's MySQL
  (if that integration is enabled), and Power BI/Fabric endpoints (only needed for the
  metadata fallback and CLI-only backfills — see [INTEGRATIONS.md](INTEGRATIONS.md)).
- Filesystem access to the OneDrive-synced Paylocity workbook path.
- **This app must run as a single, non-clustered PM2 process.** The realtime hub's in-memory
  presence/change state does not survive — or work correctly across — more than one instance.
  Do not add `instances` or `exec_mode: 'cluster'` to `ecosystem.config.js`. See
  [REALTIME-SYNC.md](REALTIME-SYNC.md).

## Environment configuration (names only)

See [DEVELOPMENT.md](DEVELOPMENT.md#environment-variables-names-only) for the full list — the
same variables apply in production, sourced from the server's own `.env` / PM2 environment
block rather than a developer's local file. Never commit or paste real values into any doc,
commit message, or chat.

## Database migration process

```bash
npx prisma migrate deploy
```

Applies migrations already committed to `prisma/migrations/` — does **not** generate a new
migration from schema drift (that's `migrate dev`, a development-only command). Run this before
restarting the app whenever a deploy includes schema changes; `next build` does not run it for
you.

## Scheduled jobs

There is no external cron/task scheduler — the only "scheduled job" is the in-process hourly
data refresh started by `src/instrumentation.ts` when the Next.js server boots (see
[REFRESH-PIPELINE.md](REFRESH-PIPELINE.md)). Restarting the app process restarts this timer
from zero; there's nothing external to reconfigure.

## Post-deployment verification

1. `pm2 logs sdc-reports --err` — confirm no `EADDRINUSE` loop.
2. Compare `.next/BUILD_ID` against the build id in the served page's HTML, to confirm the new
   build is actually the one being served (not the PM2-didn't-die failure mode above).
3. Hit `/api/health` — expect `{status:"ok", app:"sdc-projects-reports"}`. Note this endpoint
   being `200` is **not sufficient on its own** given the failure mode above; it only confirms a
   Next.js process is answering, not which build.
4. Sign in and load `/etc`, `/job-hours`, `/quoted` — confirm the grids render and the sidebar's
   version number (from `NEXT_PUBLIC_APP_VERSION`) matches what you expect.
5. If the deploy included a schema change, confirm `npx prisma migrate deploy` was run and the
   affected page(s) load without a Prisma "unknown column" error.

## Rollback

There's no automated rollback tooling — this is a small internal app on a single box, not a
blue/green or containerized deployment.

- **Code**: `git revert` the deploying commit(s) (or check out the previous commit), then run
  `npm run deploy` again.
- **Database**: Prisma migrations are forward-only by default in this project — there is no
  `migrate down` in routine use. Rolling back a schema change means writing and applying a new
  migration that undoes it, not reverting the migration file. Treat any migration that's already
  been deployed as immutable history, the same convention the DEVLOG history follows for
  documenting *what* changed rather than editing prior entries.
- Because the deploy script fails loudly rather than silently on the PM2 port issue (see above),
  a failed deploy generally leaves the **previous** build still running — there is often nothing
  to "roll back" if `npm run deploy` itself reported an error, since it means the new build never
  actually took over.
