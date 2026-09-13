# ADR 0002 — SDC Scheduler stays a separate repository, nested and ignored

**Status:** Accepted, 2026-09-13

## Context

`SDC_Scheduler/` is authored and owned by an external collaborator
(danbelliveau2/SDC_Scheduler). It has its own updater in `sdc-updater-hub`
which `git fetch`es its remote and hard-resets the checkout every two minutes,
and its own release cadence. It runs as pm2 `sdc-scheduler` on port 4003 from
that directory, and other apps talk to it only over HTTP.

## Decision

The Scheduler remains a nested, independent git repository at
`SDC_Scheduler/`, ignored by this repository's `.gitignore`. It is not a
submodule, not a subtree, and not a workspace we build. This repo owns only the
pm2 entry that runs it and the updater that follows its upstream.

## Consequences

- A fresh clone of SDC-Tools does not contain the Scheduler; `README.md`
  documents cloning it separately into `SDC_Scheduler/`.
- Nothing in this repo may import from `SDC_Scheduler/`. Integration is HTTP
  (its `/api`), the `sdc_session` cookie contract, and the read-only MCP server
  it exposes on 4100.
- The root `package.json` workspace entry for `SDC_Scheduler` is legacy and is
  scheduled for removal once nothing relies on the hoisted install.

## Rejected

- **Git submodule**: pins a commit; the updater's hard-reset-to-upstream model
  would fight the pin every two minutes.
- **Subtree merge into this repo**: makes Dan's history ours and turns every
  upstream sync into a merge with conflict potential on a live production tree.
