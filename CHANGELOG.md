# Changelog

All notable changes to SDC Tools. Desktop shell versions are the headings;
server apps deploy continuously from `master` and are listed under the shell
version current at the time. Per-app detail lives in each app's own log
(`apps/reports/DEVLOG.md`, `apps/calendar/CHANGELOG.md`).

## Unreleased

### Repository
- Moved to the `steven-douglas-corporation` GitHub organization; every
  reference to the former personal repository removed.
- Production-grade structure: every app under `apps/`, Power BI sources under
  `tools/powerbi`, decision records in `docs/adr`, runbook in `docs/RUNBOOK.md`.
- Quality gates on every app: ESLint (one canonical rule set, `packages/eslint-config`),
  unit tests, `lint` / `test` / `build` scripts, and CI that runs them all.
- Governance: CODEOWNERS, pull request template, Dependabot, EditorConfig,
  `.gitattributes` (LF everywhere), `.nvmrc` (Node 22), SECURITY.md, CONTRIBUTING.md.

### Reports (`apps/reports`)
- Re-submitting a reopened month no longer overwrites managers' New ETC values
  with the suggestion (August 2026 repaired: 161 cells restored).
- Parts List: one row per part, `# Subs` column, blended `Unit $` × `Purch Qty`
  = `Total $`, `Received Date` column, dates with a two-digit year, a per-PO
  side panel, and inline expand/collapse of a part's POs.
- Total ETO: one `mssql` instance per process, bounded retries, failures named
  by kind in the refresh status.

## v2.1.1 — 2026-09-13
- Verification release: first over-the-air update delivered from the
  organization repository.

## v2.1.0 — 2026-09-13
- First shell build published from `steven-douglas-corporation/SDC-Tools`.
  Installs from this version onward receive updates from the organization repo.

## v2.0.1 and earlier
- See the GitHub Releases page and `ARCHITECTURE.md` § Release & CI/CD.
