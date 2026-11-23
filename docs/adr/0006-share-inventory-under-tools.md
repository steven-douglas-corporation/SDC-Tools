# ADR 0006 — The share inventory lives under `tools/share-inventory/`, and the Brain has one design

**Status:** Accepted, 2026-11-23

## Context

"SDC Brain" was being described in three places that had drifted apart:

- `tools/data-warehouse/ROADMAP.md` in this repo: the warehouse, the measure
  catalog, vectors and tags, and the tools an assistant calls (Phases 1–6).
- The SDC Pipelines page (<https://claude.ai/artifact/VvudJqpSYySCvKxs3bCXZZ>):
  each lifecycle, the software behind it, and where its data lands in the
  warehouse.
- A separate `SDC-Brain` repository: the share crawler, plus planning documents
  ported from a whiteboard session. Those said the platform was not chosen,
  proposed a separate graph database, and described the warehouse's model as
  "not yet inspected" — all three out of date against the two sources above.

The `SDC-Brain` repository's code is three small standard-library Python
packages (`inventory`, `mining`, `findings`). In the Pipelines page they are
one of the warehouse's sources: the file scan of the shares.

## Decision

- Move the three packages and their tests to `tools/share-inventory/`, next to
  `tools/data-warehouse/`, and retire the `SDC-Brain` repository.
- The Brain has one design, in two parts that do not repeat each other: the
  warehouse roadmap says how it is built, the Pipelines page says what feeds
  it. Where they disagree, the Pipelines page is the newer statement and the
  roadmap is corrected to match.
- The whiteboard documents are not carried over. The few points they made that
  the roadmap lacked (sensitivity is never decided by a model alone, an
  assistant reads before it is allowed to write, AI does not edit design files)
  are added to the roadmap.
- The engineering standards plan comes across as
  `docs/engineering-rules-plan.md`. It is a plan, not rule content.

## Consequences

- A change to the warehouse and to the code that feeds or reads it can be one
  pull request.
- The folder keeps its own rules (`tools/share-inventory/CLAUDE.md`): standard
  library only, and no crawled data, findings or real names in git. The repo's
  root `.gitignore` already ignores SQLite files; the folder's own
  `.gitignore` adds its report names.
- Everyone with access to this repo can read `findings/rules.py`, which
  describes what SDC treats as sensitive. The crawled data and the findings
  themselves stay outside git, as before.
- The inventory's default data folder is still `%LOCALAPPDATA%\SDC-Brain`, so
  the existing database keeps working.
- CI does not run Python tests today (the warehouse loader's are not run
  either). Until it does, these are run by hand.
- The code was copied in at `SDC-Brain` commit `d3de067`
  (`feat/exposure-findings`) with the two name fixes from `3e7b2ee`
  (`chore/dev-practices`), not subtree-merged. The earlier history contains a
  real customer name and a real share path, and copying keeps both out of this
  repo's history.

## Rejected

- **Keep `SDC-Brain` as its own repository**: a second set of branch rules, CI
  and review for a small team, and a standing invitation for a second design
  document.
- **Move the warehouse into `SDC-Brain`**: the same single-repo benefit, but it
  moves the larger, live thing to the smaller repo and away from Reports,
  which reads it.
- **Engineering rule content in this repo**: rules and PLC lessons are approved
  by discipline leads, not developers, and are read by assistants as standing
  instructions. Where they live is still open; it is not here.
