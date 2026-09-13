# Contributing to SDC Tools

This repository is both the source and the production checkout on `SERVER-APP1`.
Master is deployed automatically within five minutes of a push. Treat every
commit to master as a deploy, because it is one.

## The layout

| Path | What | Runs as |
|---|---|---|
| `apps/assemblies` | Assemblies Library, Express + Vite/React | pm2 `sdc-assemblies` :4001 |
| `apps/build-readiness` | Build Readiness Report, Express + Vite/React | pm2 `sdc-readiness` :4002 |
| `apps/state-logic` | State Logic Builder, Express + Vite/React (vendored fork) | pm2 `sdc-statelogic` :4004 |
| `apps/calendar` | SDC Calendar, Express + Vite/React | pm2 `sdc-calendar` :4005 |
| `apps/reports` | SDC Reports, Next.js + Prisma | pm2 `sdc-reports` :4006 |
| `apps/shell` | Desktop launcher, Electron | published installer |
| `SDC_Scheduler/` | SDC Scheduler — **separate repo**, ignored here | pm2 `sdc-scheduler` :4003 |
| `tools/powerbi` | Power BI report sources and the MCP server | not a service |
| `packages/` | Code shared by two or more apps | — |
| `scripts/` | Server updater, release and repo-wide checks | pm2 `sdc-updater-hub` |
| `docs/` | Architecture, ports, runbook, decisions (`docs/adr`) | — |

## Branching

- `master` is production. Nothing lands there except through a pull request
  with green CI and a review (see `docs/BRANCH-PROTECTION.md`).
- Branch names: `feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`.
  CI runs on every push to those prefixes.
- Keep a pull request to one app or one concern. The updater rebuilds and
  restarts only the apps whose files changed, so a focused PR is a smaller
  production event.

## Before you push

Every app answers the same three commands. Run them in the app you touched:

```bash
npm run lint     # ESLint, errors fail CI, warnings are visible but do not
npm test         # unit tests that need no database, network or running server
npm run build    # where the app has a build (Vite clients, Next.js)
```

At the repo root, `npm run lint:configs` checks that every app's ESLint config
still matches the canonical copy in `packages/eslint-config/`.

## Code conventions

- Two-space indentation, LF line endings, UTF-8 (`.editorconfig`,
  `.gitattributes`). Prettier settings live in `.prettierrc.json`; `npm run
  format` formats an app. Formatting is not enforced on legacy files yet, so do
  not reformat a file you are not otherwise changing.
- ESLint severity: `error` is a runtime bug, `warn` is hygiene. Fix warnings in
  code you touch; do not silence them repo-wide.
- Node 22 LTS (`.nvmrc`). Production currently runs a newer Node; the floor is
  22.
- Comments explain *why*, with the date and the incident or request when there
  is one. This repo's comments are its institutional memory; `apps/reports/DEVLOG.md`
  is the model.

## Workspaces and lockfiles

`apps/assemblies`, `apps/build-readiness` and `apps/state-logic` are npm
workspace members: `npm install` or `npm ci` run inside them acts on the ROOT
`package-lock.json`, and they have no lockfile of their own. Add a dependency to
one of them with `npm install <pkg> --workspace apps/<name>` from the root, so
the root lock moves with it. Calendar, Shell, Reports and the Build Readiness
client are standalone projects with their own lockfiles.

## Environment and secrets

Each app reads its own `.env` from its directory. Never commit one. Add every
new variable to the app's `.env.example` with a placeholder and a one-line
description, and to `docs/RUNBOOK.md` if operations needs to set it.

## Databases and migrations

Reports uses Prisma. Add a migration with `npx prisma migrate dev --name
<what-changed>` and commit the migration folder; the updater runs `prisma
migrate deploy` before it builds. The other apps use MySQL or SQLite with
schema owned in code; document any schema change in the PR.

## Releasing the desktop shell

Bumping `"version"` in `apps/shell/package.json` on master builds and publishes
a public installer to GitHub Releases, and every installed shell updates itself.
That is a release. Do it deliberately, in its own commit
(`chore: release vX.Y`), with the change list in `CHANGELOG.md`.

## Decisions

Anything that changes the shape of the repo, the deploy path, or a cross-app
contract gets an ADR in `docs/adr/` — a page saying what was decided, why, and
what was rejected. Existing ones explain the current layout.
