# ADR 0001 — One repository, one `apps/` directory, one deploy path

**Status:** Accepted, 2026-09-13 (formalising the 2026-08 restructuring and the 2026-09 moves)

## Context

SDC Tools began as six separate personal repositories, each with its own
updater polling GitHub and restarting its own pm2 process. The repositories
were merged into one in August 2026, but two apps (Reports, Power BI) were
folded in later and kept their original top-level folder names, so the tree
had three shapes: `apps/<name>`, `sdc-etc-planner/`, `SDC-PowerBI-DEV/`.

## Decision

- Every deployable application lives under `apps/<kebab-name>/` and is an
  independent npm project with its own lockfile, `.env`, and `lint` / `test` /
  `build` scripts.
- Non-service projects live under `tools/` (Power BI report sources and the
  MCP server).
- Code shared by two or more apps lives under `packages/`, and only when it is
  actually imported by two apps today (`packages/README.md`).
- One updater (`scripts/sdc-main-updater.js`) deploys the whole repo from
  `master`; per-app updaters exist only for code owned by an external
  repository (Scheduler, State Logic upstream).
- The repository is the production checkout. That is a constraint we accept
  for now (single server, small team) and design around: the updater refuses
  to deploy over local work, and `docs/RUNBOOK.md` documents the consequences.

## Consequences

- A new app is `apps/<name>` plus one pm2 entry, one CI job, one Dependabot
  entry, one line in `docs/PORTS.md`.
- Paths are stable inputs to pm2 (`cwd`), the updater (`prefix` lists) and CI
  (`working-directory`). Moving an app is a coordinated change to all three,
  done with the process stopped — see ADR 0003 for the one time it was done.

## Rejected

- One repo per app with a meta-repo of submodules: the six updaters were the
  problem, not the solution.
- npm workspaces hoisting every app into one root `node_modules`: the apps
  pin different majors of Vite, Electron and React; the root workspace list is
  kept only for the apps that already tolerate hoisting.
