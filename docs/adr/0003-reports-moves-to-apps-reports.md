# ADR 0003 — Reports moves from `sdc-etc-planner/` to `apps/reports/`, pm2 `sdc-reports`

**Status:** Accepted, 2026-09-13

## Context

The Reports app (Next.js + Prisma, port 4006) was folded into the monorepo on
2026-09-03 under its historical folder name `sdc-etc-planner`, with a pm2
process of the same name, an absolute `cwd` in `ecosystem.config.js`, and its
own deploy step in the updater keyed on the `sdc-etc-planner/` prefix. Every
other app lives under `apps/`.

## Decision

- Directory: `apps/reports/`.
- pm2 process: `sdc-reports` (was `sdc-etc-planner`).
- `ecosystem.config.js` `cwd` becomes a relative `./apps/reports`, like the
  other apps.
- The updater's Reports step keys on `apps/reports/`; the app's own
  `npm run deploy` stops and starts `sdc-reports`.
- CI `working-directory`, Dependabot directory, `docs/PORTS.md`, and the root
  `dev:reports` script follow.

## How the move is performed

The whole directory (including the untracked `.env`, `node_modules`, and the
built `.next`) is renamed on disk, then `git add -A` records the rename. That
requires the process to be **stopped first**: Windows refuses to rename a
directory that is a running process's working directory. Sequence:

```bash
pm2 stop sdc-etc-planner
# rename + commit (done in the repo)
pm2 delete sdc-etc-planner
pm2 start ecosystem.config.js --only sdc-reports
pm2 save
```

`pm2 restart` is not enough: a changed `cwd` is only read on `start`.

## Consequences

- One layout for every app, and the updater's special case is now a prefix
  rename rather than a top-level exception.
- Anyone with a bookmark to the old folder or process name needs the new one;
  `apps/reports/DEVLOG.md` keeps its history intact (git follows the rename).
- The port (4006), the database, the `.env`, and the URL the desktop shell opens
  are unchanged; users notice nothing but the ~60 s stop/start.
