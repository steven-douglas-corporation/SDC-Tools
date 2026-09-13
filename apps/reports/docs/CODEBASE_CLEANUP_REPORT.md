# SDC Reports — Codebase Cleanup Report

**Date:** 2026-08-19
**Scope:** Full production-grade cleanup and stabilization pass, per the original request. Executed as 14 incremental commits on top of a safety checkpoint, each independently verified (typecheck + lint + full test suite; several also browser-verified live) before moving to the next. Nothing was pushed; all of this sits on local `main`, ready for review.

For the evidence base this report acts on, see [CLEANUP_PHASE1_INVENTORY.md](CLEANUP_PHASE1_INVENTORY.md) — that document has the full file:line citations behind every finding below.

---

## 0. The starting condition

Before any cleanup work began, the working tree held ~100 uncommitted files: a substantial in-progress feature build (a centralized role/permission model, Cash Flow Forecast, T&M reporting, Hiring positions, an Admin section, an Employees redesign) plus 5 new Prisma migrations — none of it backed up anywhere but this one directory. That was captured in commit `4b74d9b` as a checkpoint before anything else happened, specifically because this is a live app and the user had already experienced work going missing. Two non-code items (`tables to cards redesign/`, a design-mockup scratch folder, and `scripts/readiness-audit-output.tsv`, a regenerable script output) were deliberately excluded from that checkpoint and are addressed below.

**A structural risk worth restating**: this repository is both the development checkout and the directory PM2 serves production from (confirmed: port 3010 had a live, connected user throughout this session). Every build/typecheck verification in this cleanup was deliberately run against an isolated `distDir` (`.next-verify`, `.next-buildcheck`) rather than the live `.next/`, specifically to avoid disrupting that connection. See §6 for what this means for the one remaining "error" in a plain `tsc` run.

---

## 1. Bugs fixed

| Bug | Where | Fix |
|---|---|---|
| **Authorization bypass** — a signed-in `ALL`-role user (correctly blocked from `/quoted`, `/etc`, `/hours` in the UI) could still download the full Projects/ETC/Hours workbook by hitting the export URL directly | `src/app/api/export/[report]/route.ts` | Added a `requireApiPermission()` check mapping each report type to the same permission its page requires |
| **Second, related authorization gap** — job creation via the (now-deleted) legacy form had no `assertActionPermission` at all, so any `projects:view`-only user could create arbitrary jobs, a write that should need `projects:edit` | `(app)/quoted/new/page.tsx` | Resolved by deleting the dead route (§3) |
| **`/cash-flow` missing from the proxy's defense-in-depth list** — not currently exploitable (page/action checks were consistently applied), but one missed call in a future Cash Flow action would have silently reopened it | `src/proxy.ts` | Added a role-direct check mirroring `requireEltOnly()`, deliberately *not* via the DB-editable `ROUTE_PERMISSIONS` table (Cash Flow must never become togglable via the Role Permissions matrix) |
| **Negative currency display bug** — a Parts Cost credit note rendered as `$-5,000` instead of `-$5,000` | `src/lib/monthly-report.ts` | Replaced the hand-rolled string with the already-tested `usd()` |
| **Live UTC-vs-local date divergence** — `currentMonth()` was declared 3× (local time) plus a 4th copy (`currentMonthKey`, UTC); near a month boundary the two conventions could name a *different* month for the same instant | `lib/etc.ts`, 3 page files, `lib/cash-flow-view.ts` | One canonical `currentMonth()` in `etc.ts`, local time (matching 3 of 4 existing copies and `prevMonth`/`nextMonth`'s own convention); the others now import it |
| **Undeclared CSS token** — `text-sdc-gray-500` was never declared, so a Procurement label silently rendered with no color | `src/components/JobProcurement.tsx` | Caught by the project's own existing test guard; replaced with `text-sdc-muted` |
| **21 ESLint errors** across 12 files — see §4 | various | All fixed with either a real code change or a documented `eslint-disable` |

## 2. Consolidated (duplicate logic → one implementation)

| Duplication | Files | Resolution |
|---|---|---|
| Job-ID leading-zero normalization, 2 byte-identical copies | `job-hours-source.ts`, `paylocity-workbook.ts` | Both now delegate to `job-filters.ts`'s new `normalizeJobNumber()`; export names kept so no caller needed to change |
| Job-ID numeric sort, byte-identical inline copies | `job-hours-dashboard.ts` (×2) | Replaced with the existing `compareJobIds()` |
| Department rank for "Group By Department" sort | `HoursDetailPanel.tsx`'s own `departmentRank()` vs. `hours-filters.ts`'s `departmentFilterRank()` | The local copy collapsed "no department" and "a real but unmapped department" to the same rank, where the canonical one deliberately doesn't. `HoursDetailPanel.tsx` now imports the canonical one |
| Hours formatting (`Math.round(n).toLocaleString()`), 9 independent copies | `JobHoursDashboard.tsx`, `JobCostExplorer.tsx`, `DataQualityPanel.tsx`, `DataQualityDrill.tsx`, `DataQualityExplorer.tsx`, `HoursDetailPanel.tsx`, `UndefinedHoursPanel.tsx`, `StandardPoolPanel.tsx`, `monthly-report.ts` | All now delegate to `ui/format.ts`'s `hours()` |
| `Date.now()` read during render (`react-hooks/purity`), 6 sites | `JobProcurement.tsx` (×2), `BuildReadinessInsights.tsx`, `DrillContent.tsx`, `PoDetailPanel.tsx`, `BuildReadinessDrillViews.tsx` | New shared `src/lib/use-stable-now.ts` (`useState(() => Date.now())[0]`, a timing React actually guarantees, unlike `useMemo`) |
| `previousMonth()`/`prevMonth()` duplicate | `sync-actuals.ts` | Turned out to still be live (`syncHoursWorked`, not just the dead pools-sync function its neighboring comment was actually about) — folded into `etc.ts`'s `prevMonth()`, a straight dedup |

**Deliberately *not* merged**, with the reasoning kept in code comments:
- `standard-pool-local.ts`'s own `previousMonth()`/`monthOf()` (UTC-based) — self-consistent, used only for pure month arithmetic on already-parsed values rather than "what is now," and not worth the risk of touching a Standard Fees calculation for a cosmetic-only dedup.
- `hours-explorer.ts`'s `localeCompare(..., {numeric:true})` job-ID sort — verified real `SVC-`-prefixed job ids exist (now pinned in `tests/job-filters.test.ts`); `compareJobIds()` falls back to a plain string compare the moment either side fails `Number()` parsing, which gets `"SVC-9"` vs `"SVC-10"` backwards once a suffix reaches double digits. Caught before merging, not after.
- `job-cost-inventory-sync.ts`'s `normalizeJobId()` — a real behavioral difference (`unknown → string|null`, `Number()`-round-trip), not just a naming collision with the canonical `normalizeJobNumber()`.
- `DataQualityDrill.tsx`'s hand-copied drill table styling (vs. the shared `ui/Drill.tsx`) and Build Readiness's drawer-stack drill pattern — both flagged in Phase 1 as possibly worth revisiting, but low-priority/structural enough that they're left as open questions (§7) rather than acted on unilaterally.

## 3. Removed

| Item | Why |
|---|---|
| `src/components/charts/ChartTooltip.tsx`, `GaugeCard.tsx` | Zero references anywhere in the repo; consistent with the already-shipped variance-gauge removal |
| `(app)/quoted/new/page.tsx` (174 lines) + its `createProject` action | No Link/button anywhere reaches it; self-documented as "Legacy" in `docs/CODEBASE-STRUCTURE.md`; also had the permission gap noted in §1 |
| `syncQuotedFromPowerBi()`, `syncCategoryPoolsFromPowerBi()` (`sync-actuals.ts`) | Zero callers; each has its own comment explaining what replaced it (quoted hours are app-owned now; category pools compute locally) |
| `fetchPartsEstimatedToComplete()` (`parts-budget-projection.ts`) | Zero callers, no longer feeds the projection |
| Dead types/imports that existed only to support the above (`runDax` from `sync-actuals.ts`, `CategoryPoolRow`, `HoursEstimatedRow`, `CostEstimatedRow`, a local `POOL_CATEGORY`, `resolveEtcPeriodName`) | Followed their functions out |
| `tables to cards redesign/` | A Claude-Design canvas mockup, already superseded by the shipped Employees redesign — not app source |
| `scripts/readiness-audit-output.tsv` | Untracked, regenerable output of `scripts/readiness-audit.ts` |
| 11 one-off scripts (`add-missing-jobs.ts`, `backfill-employee-team.ts`, `backfill-hours-2025.ts`, `backfill-password-hashes.ts`, `deactivate-non-project-departments.ts`, `import-june-2026-from-excel.ts`, `link-scheduler-users.ts`, `plan-scheduler-team-from-departments.ts`, `restore-zero-hours-carryforward-2026-07.ts`, `_analyze_1116_ledger.ts`, `_read_1116_ledger.ts`) | Self-describe as one-time/done; moved (not deleted — git history preserves them either way, but this also matches the existing 30-file precedent in `scripts/archive/`) |

`sync-actuals.ts` no longer imports `runDax` at all — despite the filename, every function left in it is bookkeeping or reads through `job-hours-source.ts`/`sync-totaleto.ts`.

## 4. Moved

| Old path | New path | Why |
|---|---|---|
| `scripts/{add-missing-jobs,backfill-*,deactivate-*,import-june-2026-*,link-scheduler-users,plan-scheduler-*,restore-zero-hours-*}.ts` | `scripts/archive/` | Matches the existing convention for retired one-off scripts (30 files already there) |
| `scripts/_analyze_1116_ledger.ts`, `_read_1116_ledger.ts`, `_1116_dump_Job_Ledger.tsv` | `scripts/archive/` | Same, plus internal path references updated so the scripts are still self-consistent if ever re-run |
| `1116 Molex as of 7.31.26.xlsx` (repo root) | `scripts/archive/` | One-off audit input for a bug already fixed 2026-08-10; archived rather than deleted (it's a real company Excel file) |
| `Employee_Department_Map.xlsx` (repo root) | `scripts/data/` | Production input for `scripts/import-employee-departments.ts`, just in the wrong location; the script's `FILE` constant was updated to match |

## 5. Documentation

- **`.env.example`** created (didn't exist before — `DEVELOPMENT.md` said so explicitly). Every variable name from that file's table, as an empty key with a short comment. `.gitignore`'s `.env*` needed an explicit `!.env.example` exception.
- **`README.md`**: test count corrected (57 → 99 — the actual count had drifted 42 files out of date); docs table gained the two files it was missing (`SEMANTIC-MODEL-MAP.md`, `UNMAPPED-HOURS.md`); setup instructions now reference `.env.example`.
- **`docs/DEVELOPMENT.md`**: env-var table gained two real, previously-undocumented variables (`JOB_COST_INVENTORY_FOLDER`, `HIRING_POSITIONS_LOCAL_PATH`) that already had hardcoded-path fallbacks in production code.
- **`docs/CODEBASE-STRUCTURE.md`**: removed the row for the now-deleted `/quoted/new` route.
- **`src/lib/job-hours-source.ts`**: rewrote a stale header comment that had claimed Power BI was "THE source of actual hours worked" since 2026-08-03 — true for exactly two days, false for the last two weeks (the OneDrive workbook has been the live source since 2026-08-05). The comment now describes the file's real current role: Function Hierarchy metadata (still live, every read) plus an opt-in/historical-backfill fallback path.
- **`docs/CLEANUP_PHASE1_INVENTORY.md`** (this cleanup's own evidence base) and this report, added.

## 6. Production verification

| Check | Result |
|---|---|
| `npm test` (1287 tests) | **Pass**, throughout every commit |
| `npm run lint` | **Clean** — 0 errors (down from 21), 2 warnings remaining (both deliberately unfixed, see §7) |
| `npx tsc --noEmit -p tsconfig.json` | **Clean**, with one caveat below |
| `next build` (isolated dist dir) | **Compiles successfully.** One pre-existing, unrelated build warning (§7) |
| Manual browser verification | Job Cost Explorer (Columns dropdown + localStorage persistence across reload), Build Readiness (dashboard → assembly detail → PO detail drill chain), Projects (My Views menu), Job Hour Details (charts), Sidebar back-navigation, **and specifically the T&M page's "Detail" click on both an Hours card and a Parts card** (the exact crash originally reported — see §7) — all with zero console errors |

**The `tsc`/`next build` caveat**: this repository's `.next/` is the directory a live, currently-connected PM2 process is serving production from (port 3010 had an active connection throughout this session). Every verification build in this cleanup deliberately targeted an isolated `distDir` instead, to avoid touching that. But `tsconfig.json` has `.next/types/**/*.ts` in its own `include` list, unconditionally — so any `tsc` run, even one that built elsewhere, will also try to check whatever stale `validator.ts` happens to be sitting in the *live* `.next/`, left over from before this session's route changes. That produces exactly one, single, always-the-same error (`Cannot find module '.../quoted/new/page.js'` — the page this cleanup deleted). It is not a real error in current source: it disappears the moment a real `next build`/`npm run deploy` regenerates `.next/` fresh, which happens automatically as part of that same build, before its own type-check step runs. Confirmed by isolated-build runs succeeding through the "Compiled successfully" phase every time, by lint being clean, and by all 1287 tests passing.

## 7. Known issues / open questions (left for the user, not resolved unilaterally)

- **`.env.bak-before-password-change`** (repo root, 15+ days old, gitignored) — not read, not touched. No audit can determine whether it's safe to delete without knowing what's in it.
- **`scripts/etl_job_hours.py`** — its own header says it mirrors `src/lib/sharepoint-hours.ts`, which no longer exists. Left in place rather than archived: nothing found confirming an external scheduled task doesn't still invoke it, and that's outside what a repo-level audit can verify.
- **`scripts/parts-cost-projection-audit.ts`** — untouched, deliberately. Per the user's own standing note, this script has a track record of producing wrong clearances of a real bug in the past; it should not be archived, rewritten, or trusted without the user's own sign-off.
- **`DataQualityDrill.tsx`**'s hand-copied drill table styling and **Build Readiness's drawer-stack** drill pattern — both noted in Phase 1 as possibly worth converging on the shared `ui/Drill.tsx`, but low-priority and structural enough that a decision belongs to whoever built Build Readiness, not this cleanup.
- **`DEVLOG.md`** has not been written to in the 8 days before this cleanup started, despite real feature commits landing in that window. Whether to backfill it or retire the "detailed running history" claim in `README.md` is a documentation-process decision, not a code one.
- **A pre-existing, cosmetic `next build` warning** ("Encountered unexpected file in NFT list," tracing through `hiring-workbook.ts`'s dynamic `readFile()` of an absolute, machine-specific path) — harmless for this app's actual deployment model (PM2 + `next start`, not a serverless/standalone build that depends on precise file tracing), left alone rather than risking an unverified `turbopackIgnore` annotation for zero functional benefit.
- **A structural, not-code decision**: this repo is both the dev checkout and the live production directory. This cleanup did not attempt to split them (a separate deploy directory, or a build-then-copy step) — that's an infrastructure change affecting a shared server, squarely the kind of thing that needs the user's explicit go-ahead, not something to do silently mid-cleanup. It remains the most likely structural explanation for "changes disappearing" beyond the specific case already diagnosed in the user's own memory (full-file rewrites clobbering concurrent work).
- **Not attempted**: a full reorganization into `src/features/*`. The original request explicitly allows a different structure "if the existing Next.js architecture makes a different organization more appropriate" — the duplication problems found were at the business-logic level (§2), not the directory-layout level, and a mechanical move of ~150 files' worth of imports is disproportionate risk for a live app relative to the benefit, especially executed without a human reviewing each moved import. Flagged here as a deliberate scope decision, not an oversight.
