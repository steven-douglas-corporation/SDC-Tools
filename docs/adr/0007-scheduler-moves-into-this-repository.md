# ADR 0007 — SDC Scheduler moves into this repository

**Status:** Proposed, 2026-11-24. Supersedes [ADR 0002](0002-scheduler-stays-a-separate-repository.md). Becomes Accepted when the import PR and this one are merged.

## Context

ADR 0002 kept the Scheduler as a nested repository ignored by this one. It rejected a subtree merge because the Scheduler's own updater (`SDC_Scheduler/scripts/server-auto-update.js`) ran `git reset --hard origin/main` every two minutes, because its pm2 process runs as `NT AUTHORITY\SYSTEM`, and because moving it changed the habits of its external author as much as the plumbing.

The two repositories are being merged so the Scheduler is reviewed, backed up and deployed with the other apps. The import keeps the folder at `SDC_Scheduler/`, the path that pm2 (`sdc-scheduler`, port 4003), the npm workspace entry and the scripts already use, and keeps the Scheduler's full history (556 commits at import).

## Decision

`SDC_Scheduler/` is a normal tracked folder of this repository. It is deployed by `sdc-main-updater` like `apps/assemblies`, `apps/build-readiness` and `apps/calendar`.

- The Scheduler's own updater is no longer started. `scripts/sdc-updater-hub.js` stops loading it. The file stays in `SDC_Scheduler/scripts/` as history and must not be run: with the nested `.git` gone, its git commands would act on this repository.
- `scripts/sdc-main-updater.js` no longer skips the Scheduler's paths, installs dependencies when `SDC_Scheduler/package.json` or its lockfile changes, and restarts `sdc-scheduler` when files under `SDC_Scheduler/` change.
- The root `.gitignore` no longer lists `SDC_Scheduler/`.

## Consequences

- A normal clone of SDC-Tools contains the Scheduler. The "clone it separately into `SDC_Scheduler/`" step is gone from the README.
- The updater and pm2 concerns from ADR 0002 are handled by the script changes above. The hub's Scheduler updater already restarts `sdc-scheduler` through the SYSTEM-owned pm2 today, and `sdc-main-updater` runs in the same hub process, so its restart uses the same route. That is inferred from the existing setup and is confirmed only once it runs on the server.
- Integration between the Scheduler and the other apps stays over HTTP (`/api`), the `sdc_session` cookie contract and the read-only MCP server on port 4100. Nothing in this repository imports from `SDC_Scheduler/`.
- The root `package.json` workspace entry for `SDC_Scheduler` stays for now.
- Cutover on the live server is a manual sequence, in this order: merge the import PR; run `git reset -- SDC_Scheduler` in the server's working tree to clear the files the old updater skipped; restart the updater hub so it loads the new scripts; move the nested `SDC_Scheduler/.git` out of the folder and keep it as a backup; restart `sdc-scheduler` and check it.
- Six Scheduler files change from CRLF to LF line endings on the server because this repository forces LF. Their content is the same.

## Open

- How the Scheduler's external author contributes after the merge (pull requests into this repository, or another route) is not decided here.
- After the cutover, the old `danbelliveau2/SDC_Scheduler` repository should be set to read-only and kept as a rollback until the team agrees it can be archived.
