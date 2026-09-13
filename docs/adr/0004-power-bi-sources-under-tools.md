# ADR 0004 — Power BI report sources live under `tools/powerbi/`

**Status:** Accepted, 2026-09-13

## Context

`SDC-PowerBI-DEV/` holds the Power BI Desktop project files for the Job Hours
and profitability reports (PBIP definition folders, TMDL semantic model), the
.NET MCP server that exposes the model over stdio, design mock-ups, and a dev
log. It is not a service: nothing listens on a port, pm2 does not run it, and
the Scheduler stopped spawning its MCP executable on 2026-08-26 when hours
moved to the Reports app's database (`SDC_Scheduler/.env` records the removal).
Its top-level, all-caps folder name was the last non-`apps/` shape in the tree.

## Decision

Move it to `tools/powerbi/`. `tools/` is for things that ship with the repo
but are not deployed applications: report sources, build helpers, one-off
migration scripts with lasting value.

## Consequences

- `.gitignore` entries for its caches, backups and `*.pbix` move with it.
- Power BI Desktop users open `tools/powerbi/<report>.pbip`; the `.pbix`
  binaries remain untracked.
- Local Claude Code tool permissions that named the old path
  (`.claude/settings.local.json`, untracked) simply stop matching; nothing
  operational depends on them.

## Rejected

- **Its own repository again**: it was one until 2026-09-03, and the split
  meant its dev log and the Reports app's ETC history diverged. The report
  definitions change with the data model they read; keeping them here keeps
  those changes in one PR.
- **`apps/powerbi`**: it is not an app. Putting it there would give it a pm2
  entry, a health check and a CI build job that all mean nothing.
