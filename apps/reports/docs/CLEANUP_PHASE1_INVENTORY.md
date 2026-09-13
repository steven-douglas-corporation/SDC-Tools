# SDC Reports -- Phase 1 Cleanup Inventory (read-only audit, no changes made)

**Date:** 2026-08-19

This document consolidates six parallel, read-only audits of `D:\AI Projects\apps/reports` (SDC Reports / ETC Planner — Next.js 16 + Prisma/MySQL, PM2-served on port 3010): a deployment-mechanics audit, a dependency-usage audit, a duplicate-business-logic audit, a dead-code audit, a data-source-architecture audit, and a root-level/`scripts/`-folder classification audit. No files were edited, deleted, moved, or created by any of these audits, and no state-changing git command was run. A safety checkpoint commit, **`4b74d9b` ("checkpoint: WIP snapshot before production cleanup audit")**, already exists on `main` on top of `57cb6eb` and captures everything that was modified/deleted in the working tree at the start of this project — so the repo was safe to read throughout, and this document itself is the only write this phase makes. Findings below are reported with concrete file paths and line numbers wherever the source audit provided them; anywhere an audit could not fully verify a claim, that limitation is carried forward explicitly rather than smoothed over.

---

## 1. Deployment & "disappearing changes" root cause

**Deploy flow (confirmed identical across `package.json:12`, `ecosystem.config.js:11-29`, `docs/DEPLOYMENT.md:1-31`):**

```
npm run deploy
  = next build                              # writes to .next/ (distDir, next.config.ts:15)
    && node scripts/free-port.mjs 3010      # kills whatever holds :3010 via netstat/taskkill, exits 1 loudly if it can't
    && pm2 restart sdc-reports          # restarts the one PM2 app, which serves .next/
```

`free-port.mjs` exists only because PM2 on this Windows box doesn't reliably kill the previous `next start` process. It touches only the OS process table (`netstat`/`taskkill`) — no filesystem writes, no `fs` module, no git calls. Rollback is manual (`git revert` + redeploy); there is no automated rollback tooling.

**Search for anything that could silently overwrite or discard uncommitted source changes** (repo-wide grep for `git pull|checkout|reset|clean`, `execSync|child_process|spawn(`, `rimraf|fs.rm|rm -rf|rmdirSync`): **nothing found in application code, build scripts, or hooks that touches source files.**

- The only `child_process` usage anywhere in the repo is `scripts/free-port.mjs:22` (`netstat`/`taskkill` only).
- The only `rimraf` hits are inside `package-lock.json` (a transitive dev-dependency, not invoked by anything of ours).
- `.git/hooks/` contains only the stock `*.sample` files Git ships by default — zero active hooks. No `husky`/`lint-staged` in devDependencies.
- `src/instrumentation.ts` and `src/lib/auto-sync.ts` (the app's only interval-based background process) were read in full: purely a DB-data refresh (TotalETO/Power BI/Paylocity), zero filesystem or git interaction.
- `docs/DEPLOYMENT.md:64-69` states there is no external cron/task scheduler — confirmed, nothing found to contradict it (Windows Task Scheduler itself, outside the repo, was not checked — out of scope for a file-level audit).

**`.next-verify` / `.next-verify2` / `.next-verify3` — verdict: live, documented dev tooling, NOT stale, NOT safe to remove.** They exist because `next.config.ts:15` (`distDir: process.env.NEXT_DIST_DIR || ".next"`) lets a second/third dev server run without fighting the main one over one dist directory. Confirmed referenced in `.claude/launch.json:29,38,57` (`apps/reports-verify`/`-verify2`/`-verify3` launch configs on ports 3021/3022/3023), `.gitignore:19` (`/.next-verify*/`), `tsconfig.json:42-43,48-49,57-58`, and `docs/DEVELOPMENT.md:50-53`.

**Ranked hypotheses for "code changes disappearing"** (no smoking gun found *inside* the deploy/build pipeline itself; strongest evidence points upstream of deployment):

1. **(Highest confidence)** Full-file rewrites by an editing agent clobbering concurrent/unrelated work. This isn't a new hypothesis — it's already diagnosed and on record in the user's own memory (`regression-safety-process.md`, 2026-08-17): *"a feature is implemented and working, then an unrelated later change silently reverts it... especially in shared components/utilities."* The standing rule that memory created (prefer `Edit` over full-file `Write`; treat an unexpectedly large diff as a warning sign) is a direct response to this exact symptom, predating and independent of the deploy/git plumbing.
2. **(Second, currently resolved)** A repo-wide ACL misconfiguration (`repo-acl-readonly-blocker.md`, 2026-08-12) that made edits to *existing* tracked files silently fail with `EPERM ... rename` while new files wrote fine — "easy to misdiagnose as a dev-server lock." Verified via `icacls` that `akamuju` currently has explicit Full Control at both directory and file level — **not currently active**, but a confirmed real mechanism that would recur identically if ACLs were ever reset by a backup restore or GPO refresh.
3. **(Third, weaker)** Shared dev/prod `distDir`: a plain `npm run dev` on the same box while PM2 serves the same `.next/` would race rebuilds against the file PM2 has open. This is real but only ever corrupts **build artifacts**, not tracked source — it's exactly why the `-verify`/`-verify2`/`-verify3`/`-perf`/`dev:preview` profiles exist, and its real-world symptom (stale bundle) is what `src/lib/stale-bundle.ts` detects client-side.
4. **(Inconclusive, flagged not confirmed)** `git reflog` shows recurring `reset: moving to HEAD` entries at many points in project history. Reflog text alone cannot distinguish a harmless mixed reset from a destructive `--hard` reset. Given these are interleaved with an otherwise normal feature-branch/fast-forward/amend workflow, the more probable innocent explanation is routine unstaging after an over-broad `git add` — reported as the only git-level anomaly found, not as evidence of data loss.

**Ruled out with direct evidence:** `auto-sync.ts`/`instrumentation.ts` (pure data refresh), `stale-bundle.ts` (client-side string matcher only), git hooks (empty), any in-repo cron mechanism (absent).

---

## 2. Dependency usage audit

**Summary: POSSIBLY-UNUSED = none found.** Every one of the 18 `dependencies` and 13 `devDependencies` in `package.json` has verifiable evidence of use.

| Package | Type | Status | Evidence |
|---|---|---|---|
| `@azure/msal-node` | dep | USED | `src/lib/powerbi-client.ts:1`, `src/lib/fabric-warehouse.ts:2` |
| `@azure/msal-node-extensions` | dep | USED | `src/lib/powerbi-client.ts:2`; `next.config.ts:16` `serverExternalPackages` |
| `@prisma/client` | dep | USED | `src/lib/prisma.ts:1` |
| `ag-grid-community` | dep | USED | `src/components/AuditLogGridInner.tsx:4` |
| `ag-grid-react` | dep | USED | `src/components/AuditLogGridInner.tsx:3` |
| `bcryptjs` | dep | USED | `src/lib/auth.ts:3`, `src/app/login/actions.ts:3`, `prisma/seed.ts:2`, `scripts/link-scheduler-users.ts:27` |
| `echarts` | dep | USED | `src/components/charts/EChart.tsx:4`, `theme.ts:1`, `GaugeCard.tsx:3`, `DataQualityExplorer.tsx:6` |
| `echarts-for-react` | dep | USED | `src/components/charts/EChart.tsx:9` (dynamic import) |
| `exceljs` | dep | USED | `src/lib/export/xlsx.ts:1`, `job-cost-inventory-sync.ts:4`, `paylocity-workbook.ts:5` |
| `mssql` | dep | USED | `cash-flow-totaleto.ts:1`, `cash-flow-drill.ts:1`, `fabric-warehouse.ts:1`, `job-bom.ts:2`, `sync-totaleto.ts:1` |
| `mysql2` | dep | USED | `src/lib/scheduler-db.ts:2` — separate direct MySQL connection to the Scheduler DB, not a Prisma artifact |
| `next` | dep | FRAMEWORK-IMPLICIT | Foundational |
| `next-auth` | dep | USED | `src/lib/auth.ts:1-2`, `src/app/login/LoginForm.tsx:5` |
| `prisma` | dep | USED | CLI tool; `prisma/schema.prisma` + `prisma migrate`/`generate` documented in DEVLOG.md |
| `react` / `react-dom` | dep | FRAMEWORK-IMPLICIT | Foundational |
| `server-only` | dep | USED | 70+ files; aliased for scripts/tests via `tsconfig.scripts.json` + `scripts/shim-server-only.cjs` |
| `unpdf` | dep | USED | `src/lib/project-release.ts:198` (dynamic import) |
| `@tailwindcss/postcss` | devDep | USED-VIA-CONFIG | `postcss.config.mjs:3` |
| `@types/bcryptjs`, `@types/mssql`, `@types/node`, `@types/react`, `@types/react-dom` | devDep | USED-VIA-CONFIG | Implicit typings auto-attached by TS for their directly-imported runtime packages / Node built-ins used throughout `scripts/` |
| `dotenv` | devDep | USED | 40+ scripts, e.g. `scripts/backfill-etc-history.ts:6` |
| `eslint` | devDep | USED | `package.json:13` `"lint"` script; `eslint.config.mjs` |
| `eslint-config-next` | devDep | USED-VIA-CONFIG | `eslint.config.mjs:2-3` |
| `tailwindcss` | devDep | USED-VIA-CONFIG | `src/app/globals.css:1` (Tailwind v4 CSS-first config) |
| `tsx` | devDep | USED | `package.json:14` `"test"` script |
| `typescript` | devDep | FRAMEWORK-IMPLICIT | Foundational |
| `xlsx` | devDep | USED | `hiring-workbook-parse.ts:1`, `import-employee-supervisors.ts:2`, `scripts/import-employee-departments.ts:34` |

No package needed a "double-check against transitive/peer/CLI-only usage" rescue — everything landed cleanly on the first pass. **No dependency-removal action is available from this audit.**

---

## 3. Duplicate business logic

This is the most detail-dense section of the six source audits; full detail is preserved below rather than summarized away.

### 3.1 Department / discipline mapping
Single canonical chain: `employee-teams.ts:122-130` (`teamFor`) → `employee-card-theme.ts:78-94` (`resolveEmployeeGroup`) → `employee-department-cards.ts:29-70` (`buildDepartmentCards`) → `employee-workforce-groups.ts:46-48`. All real consumers import from this chain.

**Duplicate pair found:** `src/lib/hours-filters.ts:60-65` (`departmentFilterRank`) and `src/components/HoursDetailPanel.tsx:147-152` (`departmentRank`) independently reimplement the identical `teamFor()` → `EMPLOYEE_TEAMS.indexOf()` logic — each file's comment claims the other is "reused, not re-derived," but there is no actual import between them. They diverge in their unranked-fallback sentinel (`hours-filters.ts` distinguishes `MAX_SAFE_INTEGER-1` "known-but-unranked" from `MAX_SAFE_INTEGER` "blank"; `HoursDetailPanel.tsx` collapses both to one `MAX_SAFE_INTEGER`) — a latent behavior difference if the two lists were ever ordered together.

`etc-departments.ts` (5-code ETC sign-off) and `hours-operational-grouping.ts` (17-code Hours grouping) are appropriately and deliberately distinct from `EMPLOYEE_TEAMS`, with in-code comments explaining why they must not be merged.

### 3.2 Section / function-code mapping
Single canonical implementation: `src/lib/sections.ts` (`SECTIONS`, `ETC_SECTIONS`, `SECTION_ALIASES`, `mapPunchToColumns()`, `poolCategoryForPunch()`), imported by 30 files. No hardcoded reimplementation of the 17 section codes found anywhere. Clean.

### 3.3 Employee grouping / roster logic
Same canonical chain as 3.1. `employee-row.ts` is a shared type only. `EmployeesCards.tsx`'s own `roleOf()` (line 48) is a normal parent/child split, not duplicated logic. `WorkforceSummaryCards.tsx:22` explicitly calls out reusing `buildDepartmentCards()`. Clean.

### 3.4 Role / permission checks
Single canonical system: `permissions.ts` (`hasPermission`, `roleAtLeast`) ← `role-permissions-store.ts` (DB-backed overrides) ← `require-permission.ts` (`requirePagePermission`/`assertActionPermission`/`requireApiPermission`) ← `route-permissions.ts` ← `proxy.ts` (edge defense-in-depth). Verified every `page.tsx` with a route entry calls `requirePagePermission`, and every sampled mutating action file calls `assertActionPermission`. No orphaned references remain to the deleted `PasswordGate`/`audit-log-gate`/`job-cost-explorer-gate`/`projects-gate`/`profitability-reveal` (only stale historical comments in `audit-log/page.tsx:15`, `etc-actions.ts:882`, `tests/standard-pool.test.ts`).

**Real enforcement gap found (HIGH — see prominent callout in Section 4 for why this is flagged as a live bug, not mere cleanup):**
`src/app/api/export/[report]/route.ts:73-77` only checks `session?.user` ("is anyone signed in") — it never calls `hasPermission()` for `projects:view`/`monthly-etc:view`/`hours:view` before streaming the Projects/ETC/Hours export. Neither `buildProjectsExport`, `buildEtcExport`, nor `buildHoursExport` (nothing under `src/lib/export/`) checks permissions either. Per `permissions.ts:52-53`, the base `ALL` role does **not** have those view permissions by default — only `MANAGER`+. A signed-in `ALL`-role user, who is correctly redirected away from `/quoted`, `/etc`, `/hours` by `proxy.ts`/`requirePagePermission`, can still pull the full workbook by hitting `/api/export/projects?format=xlsx` directly. (The route *does* correctly gate the Standards sheets specifically via `isStandardSheetUnlocked()` at line 135 — that part is fine.) Not tested live (evidence-only), but the code path is unambiguous.

**Secondary gap:** `/cash-flow` has no entry in `ROUTE_PERMISSIONS` (`route-permissions.ts:8-20`), so `proxy.ts`'s stated "defense-in-depth against a typed-in URL" doesn't cover it — enforcement today relies solely on `requireEltOnly()`/`assertEltOnlyAction()` inside the page/actions, which was verified to be consistently applied everywhere today. Not a hole currently, but inconsistent with the layered model every other route gets, and one forgotten call in a future cash-flow action would silently reopen it.

**Intentional, consistent exception (not a bug):** `cash-flow-access.ts:17,24` checks `role !== "ELT"` directly by design (Cash Flow must never become togglable via the Role Permissions matrix); `layout.tsx:48` duplicates the same raw string comparison for nav visibility only. Two independent hand-written `"ELT"` comparisons instead of one shared predicate, but consistent with each other today.

### 3.5 Currency formatting
Single canonical implementation: `src/components/ui/format.ts` (`usd`, `usd2`, `usdExact`), correctly reused in `PartsCostSummary.tsx`, `JobCostExplorer.tsx`, `EtcStandardColumns.tsx`.

**Bypass found, with a real bug:** `src/lib/monthly-report.ts:162` hand-builds `` `$${Math.round(Number(e.hoursWorked)).toLocaleString()} was spent` `` instead of calling `usd()`. This is a genuine behavioral divergence, not style: `usd()` places the sign before the symbol for negatives (`-$5,000`), while this hand-rolled version renders `$-5,000` for a negative figure — the exact bug class `ui/format.ts` was written to eliminate, recurring at one un-migrated call site. Parts Cost can genuinely go negative (credit notes, per the comment at `monthly-report.ts:167-169`), so this is reachable, not theoretical.

### 3.6 Hours formatting / rounding
Two canonical helpers exist and are used correctly in many places: `ui/format.ts:39-52` (`hours()`, `hoursCell()`, `hoursExact()`) and `lib/rounding.ts:29-48` (`reconcileRounding()`).

**Multiple independent reimplementations of `hours()`'s exact body** (`Math.round(n).toLocaleString()`), none importing `hours()`:
- `JobHoursDashboard.tsx:57` (`fmt`)
- `JobCostExplorer.tsx:149` (`fmtNum`, applied to `actualHours`/`engineeringHours`/`shopHours`/`otherHours`/`etcEngHours`/`etcShopHours`, lines 1077-1148)
- `DataQualityPanel.tsx:21` (`fmtH`)
- `DataQualityDrill.tsx:202,237` (inline)
- `DataQualityExplorer.tsx:102,132` (inline)
- `HoursDetailPanel.tsx:363` (inline)
- `UndefinedHoursPanel.tsx:176` (inline)
- `StandardPoolPanel.tsx:75-77` (`whole()`)
- `monthly-report.ts:162` (no thousands separator, same rounding rule)

Plus the same drift pattern outside hours (evidence it's systemic): `charts/theme.ts:54-56` (`compact()`, at least centralized within charts), `po-detail.ts:96-98` (`num()`), several `build-readiness/*.tsx` local `num()` helpers.

All are behaviorally consistent with `hours()` for positive numbers today (no divergence confirmed), but at least 8 hours-specific call sites never migrated to the shared helper despite its header comment inviting "here or an equivalent."

### 3.7 Job/status filtering and Project ID normalization
Single canonical filter set: `src/lib/job-filters.ts` (`VALID_JOB_TYPES`, `validJobTypeFilter`, `JOB_STATUSES`, `etcEligibleJobFilter`, `etcActiveJobFilter`, `isSdcCustomer()`, `compareJobIds()`), imported by 22+ files.

**Job-ID sort reimplemented instead of `compareJobIds()`:**
- `src/lib/job-hours-dashboard.ts:72-75` and `:106-108` — inline `Number(a.jobId) - Number(b.jobId)` with `localeCompare` fallback, in a file that already imports `validJobTypeFilter` (line 69) but never `compareJobIds`.
- `src/lib/hours-explorer.ts:99` — a third, different mechanism (`localeCompare(..., {numeric:true})`), not verified identical to `compareJobIds()` for edge cases (leading zeros, suffixes).

**Three independent Job-ID leading-zero-normalization functions:**
- `job-hours-source.ts:89-91` (`normalizePbiJobId`) — regex `replace(/^0+(?=\d)/, "")`.
- `paylocity-workbook.ts:377-379` (`normalizeJobNumber`) — identical regex, with a comment (line 376) explicitly acknowledging it's deliberately duplicated from the one above — a documented but still-duplicated pair (drift risk if the rule is ever patched in only one place).
- `job-cost-inventory-sync.ts:153-158` (`normalizeJobId`) — a genuinely different mechanism (`Number()`/`String()` round-trip), not cross-referenced to the other two, and behaviorally divergent on non-numeric input (returns `null` instead of the unchanged string).

### 3.8 Date-range / month-boundary logic — largest duplication cluster found
No single canonical "Date → month-string" helper exists, despite the need being universal.

**`currentMonth()` duplicated 3× verbatim, plus a 4th that can disagree with it:**
- `src/app/(app)/page.tsx:13-16`
- `src/app/(app)/etc/page.tsx:388-391`
- `src/app/(app)/jobs/[id]/page.tsx:28-31`
  — all three byte-identical, local server time (`getFullYear()`/`getMonth()`).
- `src/lib/cash-flow-view.ts:41-43` (`currentMonthKey`) — **UTC** (`toISOString().slice(0,7)`), exported and reused correctly by `CashFlowClient.tsx:71`.
- **Real divergence, not cosmetic:** near a month boundary, the local-time trio and the UTC version can compute different "current month" strings for the same instant, depending on server timezone offset direction. Not verified to have fired in production (server TZ config not inspected), but the code paths are unambiguously inconsistent.

**"Previous month" arithmetic reimplemented 3× (DRY violation, self-consistent — not an observed live divergence):**
- `etc.ts:470-474` (exported `prevMonth`) — local time.
- `sync-actuals.ts:557-561` (`previousMonth`) — byte-identical local-time logic; its own surrounding comment (line 562) notes the function is "no longer on any automatic path" (likely dead code, but still a duplicate while it exists).
- `standard-pool-local.ts:72-76` (`previousMonth`) — same arithmetic but UTC-based (`Date.UTC`). Each function is internally consistent, so all three currently agree.

**Inline `Date → "YYYY-MM"` template literal repeated ~15× beyond the above**, e.g. `etc-actions.ts:254`, `etc-prior-etc.ts:42`, `parts-cost-financials.ts:76`, `standard-pool-local.ts:75,79`, `sync-actuals.ts:63,144,470,560`, `etc/page.tsx:1489`, `hours-feed.ts:166`, `job-cost-inventory-sync.ts:76-77`. `undefined-hours-rules.ts:176-177` exports a purpose-built `reportMonthForWorkDate()` for exactly this transform, but most sites don't call it. Mix of UTC vs. local accessors across the list was observed but not individually verified for a live split beyond the `currentMonth()` case already confirmed.

### 3.9 Drill-through logic
Single canonical component for the flat "KPI-card drill-through" family: `src/components/ui/Drill.tsx` (752 lines), whose own header documents it was built to unify three previously-drifted designs. Confirmed current importers: `CashFlowDrillDrawer.tsx`, `TmHoursDrillPanel.tsx`, `TmPartsDrillPanel.tsx`, `EtcMonthKpiCards.tsx`, `HoursDetailPanel.tsx`, `UndefinedHoursPanel.tsx`.

**`DataQualityDrill.tsx` still does not import `ui/Drill.tsx`** — one of the three designs it was meant to absorb. Its own comment (lines 25-33) is explicit that the visual spec is hand-copied ("spelled out here rather than imported") because it's a plain `<table>` predating the shared component. Deliberate, documented style-duplication, but still a second, independently-maintained copy (`TH`/`TD`/`THEAD` constants at lines 38-41) that will silently diverge the next time one is updated but not the other.

Build Readiness's multi-level drawer stack (`BuildReadinessDrawer`/`useDrillStack.ts`/`DrillContent.tsx`) is structurally different (hierarchical BOM navigation vs. flat single-level table) and doesn't reference `ui/Drill.tsx` at all — plausibly appropriate scoping, but not confirmed as a deliberate decision vs. an independent build that never considered the shared component. Worth a follow-up question to the team.

### Section 3 summary table

| Rule | Verdict |
|---|---|
| Department/discipline | Single canonical chain; one small duplicate pair (`departmentRank`/`departmentFilterRank`) |
| Section codes | Single canonical implementation; clean |
| Employee grouping | Single canonical chain; clean |
| Permissions | Single canonical system; **one real enforcement gap** (export route), one route missing from defense-in-depth (`/cash-flow`), one intentional exception (Cash Flow ELT-only) |
| Currency formatting | Single canonical implementation; **one bypass with a real negative-number bug** (`monthly-report.ts:162`) |
| Hours formatting | Canonical helper exists but bypassed in 8+ places doing identical rounding by hand |
| Job ID / status filtering | Single canonical filter set; 3 independent job-ID normalizers, 3 independent numeric-sort implementations |
| Date/month logic | **No canonical helper — largest cluster**; `currentMonth()` duplicated 4 ways with a **real UTC-vs-local divergence**; `previousMonth` duplicated 3 ways; ~15 more inline constructions |
| Drill-through UI | Single canonical component; one documented style-duplicate (`DataQualityDrill.tsx`); Build Readiness's drawer stack likely a separate appropriate pattern, worth confirming |

The two areas most worth prioritizing in a consolidation phase are **date/month-string construction** (confirmed live UTC-vs-local correctness risk) and the **export-route permission gap** (live authorization gap).

---

## 4. Dead code / potential live bugs

> **PROMINENT CALLOUT — result of the broken-imports check on the WIP refactor:** The dead-code audit specifically checked whether the recent WIP refactor (deletion of `PasswordGate.tsx`, `audit-log-gate.ts`, `job-cost-explorer-gate.ts`, `profitability-reveal.ts`, `projects-gate.ts`, `EmployeesTable.tsx`, two layouts, and `/api/projects/gate`) left any surviving broken import. **None found.** Every remaining hit for those names anywhere in `src/`/`tests/` is a historical comment, not an import (`employee-card-theme.ts:36,73,99`; `audit-log/page.tsx:15`; `tests/standard-pool.test.ts:76`). A full import-path resolver was run over every `.ts`/`.tsx` file in `src/` and `tests/`; the two raw hits it flagged were both manually verified as false positives (a comment illustrating a hypothetical import, and a non-ASCII byte in an otherwise-clean file). **The WIP refactor's deletions were clean — no broken imports, no live bugs from that work.**
>
> The one confirmed **live bug** found across all six audits is not in this section — it's the export-route permission gap in **Section 3.4 above** (`src/app/api/export/[report]/route.ts:73-77` lets any signed-in user, including the base `ALL` role, download the Projects/ETC/Hours workbook with no `hasPermission()` check). That is flagged here for visibility since it's the most actionable finding in the entire Phase 1 audit, even though it surfaced from the duplicate-logic pass rather than the dead-code pass.

### 4.1 Unreferenced components — high confidence, safe to delete
1. **`src/components/charts/ChartTooltip.tsx`** (129 lines, exports `useChartTooltip`) — grepped repo-wide, only occurrences are its own definitions. Not lazy-loaded (only `AuditLogGridInner` and `echarts-for-react` use `next/dynamic`). Listed in `docs/CODEBASE-STRUCTURE.md:65` but that's documentation, not a code reference.
2. **`src/components/charts/GaugeCard.tsx`** (82 lines, exports `GaugeCard`) — same: only other repo-wide match is the same documentation inventory line. Consistent with the "Parts Cost visual history" change (variance gauge removed, PartsCostSummary now text-only).

No other component in `src/components/` (root, `build-readiness/`, `charts/`, `procurement/`, `ui/`) came back with zero cross-references; low-count (`1`) cases were spot-checked manually and confirmed real. **No zero-reference files found in `src/lib/`** (including `export/`) across ~150 files; single-consumer chains were traced forward and confirmed to terminate in a live, reachable route.

*Caveat carried forward from the source audit:* this pass is file-level (does the module have any importer), not per-exported-symbol — an AST-level sweep for dead exports inside otherwise-live files was explicitly out of scope and not performed.

### 4.2 Unreachable routes
Sidebar.tsx is the single source of top-level nav; all 13 linked routes are reachable and confirmed to have a matching `page.tsx`.

| Route | Verdict |
|---|---|
| `jobs/page.tsx`, `jobs/[id]/page.tsx` | Reachable via dashboard KPI links and job-row links |
| `jobs/new/page.tsx` | **Unreachable by design, not a bug** — a one-line `redirect("/jobs")` kept as a soft landing for old bookmarks now that creation happens inline via `AddProjectButton.tsx` |
| `quoted/new/page.tsx` | **Confirmed unreachable and self-documented as such** — no Link/button anywhere points to it; `AddProjectButton.tsx` only offers "Manual entry" (inline row) or "From Release"; `docs/CODEBASE-STRUCTURE.md:42` explicitly labels it "Legacy standalone new-project form." Still wired into `route-permissions.ts` (checked by `tests/permissions.test.ts:120`), so not broken, just orphaned. A full 174-line form + server action (`createProject`) duplicating the inline-row flow. **High-confidence real cleanup candidate.** |
| `api/jobs/export/route.ts` | **Intentionally retired, not accidentally dead** — returns HTTP 410 Gone by design so old bookmarks get an explanatory message instead of a bare 404; `jobs/page.tsx:57-62` has a matching comment confirming the link removal was deliberate (§24, 2026-08-04) in favor of `/api/export/<report>`. Not a cleanup candidate unless bookmark compatibility is being dropped. |

API routes with no in-`src/` caller but confirmed as legitimate external entry points (not orphaned): `api/health` (SDC Tools launcher), `api/auth/sso` (Scheduler↔Reports SSO), `api/integration/employees|jobs|jobs/[jobId]|revoke-session|sync-password` (sibling Scheduler app), `api/auth/[...nextauth]` (framework-wired). All other API routes have confirmed in-app callers.

### 4.3 Summary for cleanup planning
- Nothing urgent from dead code itself.
- Safe, high-confidence deletions: `ChartTooltip.tsx`, `GaugeCard.tsx`.
- Likely-safe, slightly bigger deletion (has a server action — confirm no external bookmark/workflow depends on it first): `src/app/(app)/quoted/new/page.tsx`.
- Leave alone, intentionally retained and self-documented: `jobs/new/page.tsx`, `api/jobs/export/route.ts`.

---

## 5. Data source architecture

### 5.1 Paylocity (labor hours)
**Current live source is Lisa's OneDrive-synced `Current_Job_Hours.xlsx` workbook, NOT Power BI**, despite one stale in-code comment claiming otherwise (Finding A below).

- Single entry point: `readHoursFeed()`, `src/lib/hours-feed.ts:116-142` — every hours consumer goes through this and nowhere else.
- `configuredSource()` (`hours-feed.ts:78-80`) returns `"workbook"` unless `HOURS_SOURCE=power_bi` is explicitly set — confirmed not set, so production reads the workbook.
- Reader: `src/lib/paylocity-workbook.ts` — default path hardcoded at line 61 under `akamuju`'s OneDrive profile, overridable via `JOB_HOURS_LOCAL_PATH`. Plain filesystem read (`fs/promises` + `ExcelJS`), not a Graph/SharePoint API call.
- Reason for workbook-over-PBI (documented at `paylocity-workbook.ts:20-53`, `hours-feed.ts:34-51`): measured 2026-08-05 that the PBI model ran days behind the file (July short 150.53h, August entirely absent). **Deliberately no automatic fallback** to Power BI on failure — a failed read raises and the last good dataset stays on screen, by design, to avoid mixing data vintages.
- Scheduled path: `auto-sync.ts:56-90` (hourly + manual "Refresh Data") → `beginPaylocityImport()` (`paylocity-import.ts:87-95`) → `readHoursFeed()`. Downstream writers: `syncActualHours`/`syncJobHoursDetail`/`syncHoursWorked` in `sync-actuals.ts` (filename is legacy — these functions now consume whatever `readHoursFeed()` returns) plus `recordUndefinedHours`.
- Failure mode: typed `WorkbookError` stages (`file_missing`, `file_empty`, `file_unstable`, `workbook_unreadable`, `headers_missing`, `no_valid_rows`); recorded `failed` in `PowerBiFreshness`; last-good data stays visible with the failure surfaced in the header.
- Separate, unrelated manual-upload feature: `ImportSupervisorsButton.tsx`/`import-employee-supervisors.ts` — a one-off browser upload for org-chart/supervisor data, not on any schedule.

**Finding A (stale doc-in-code):** `src/lib/job-hours-source.ts:4-30`'s header comment still asserts Power BI is "THE source of actual hours worked," dated 2026-08-03 — true for exactly two days before the 2026-08-05 reversion documented in `auto-sync.ts:57-60` and `paylocity-workbook.ts:25-45`. Never updated; will mislead anyone who reads that file first. The file's functions (`fetchJobHoursRowsWithIssues`, `buildColumnResolver`, `fetchMonthRows`) are still real and called — just not as "the" source (see 5.2).

### 5.2 Power BI — what's actually still live vs. fully retired

| Use | File:line | Status |
|---|---|---|
| Function Hierarchy code→column metadata | `job-hours-source.ts:146-188`, called from `hours-feed.ts:99-107` | **Live, every hours read.** Metadata only (what a punch code means), not hours data; falls back to hardcoded `SECTION_ALIASES` on failure. |
| T&M's 3 dollar cards | `tm-report.ts:115-136,188-230` | **Live, intentional** — explicitly a "native recreation of the Power BI T&M page" per its own header. |
| Job Cost Explorer/Profitability Sales Price fallback | `job-cost-source.ts:207-217`, called at line 302 | **Live, every render**, but only as a fallback when a job isn't in the hand-maintained inventory snapshot. |
| Historical ETC/pool backfill via Fabric SQL warehouse | `fabric-warehouse.ts`, consumed by `sync-etc-history.ts:5,334,349` | **CLI-only** — only real caller chain is `scripts/backfill-etc-history.ts`. Confirmed independently, matches `docs/INTEGRATIONS.md:60-65`. |
| ETC period name→month resolution | `etc-period.ts:68-99` | Called by `sync-actuals.ts:605` (dead, see below) and `sync-etc-history.ts:71` (CLI-only). |

**Finding B — three Power-BI-calling functions have zero production callers (dead code):**
- `syncQuotedFromPowerBi()` (`sync-actuals.ts:816-916`) — only other mention is a comment in `auto-sync.ts:33-34` explicitly excluding it ("Quoted hours are app-owned now").
- `syncCategoryPoolsFromPowerBi()` (`sync-actuals.ts:599-689`) — `auto-sync.ts:296-313` documents it was replaced by `standard-pool-local.ts`'s local computation.
- `fetchPartsEstimatedToComplete()` (`parts-budget-projection.ts:193-201`) — zero callers anywhere, not even a comment reference.

Safe to leave alone in Phase 1, but flagged as a decision point for a later cleanup pass (keep as documented reference implementations, or remove).

`standard-pool-local.ts`: confirmed zero `runDax`/`powerbi-client` references — fully local computation.

**T&M hours specifically: clean, no live Power BI dependency.** `tm-hours.ts:1-46` explicitly retired its own prior live PBI DAX query in favor of the same local `JobHoursDetail` table Monthly ETC uses. `getTmHoursTotals`/`getTmHoursDrillRows` query `prisma.jobHoursDetail` only; `tm-hours-classify.ts` is pure (confirmed by full read — no I/O, no Prisma, no PBI import). `tm-report.ts`'s remaining `runDax` calls are scoped only to the three dollar cards, documented as a permanent, intentional exception.

### 5.3 TotalETO (procurement / parts / ERP)
Direct SQL Server connection (`mssql` package); each consumer file opens its own connection independently rather than sharing a pool (`sync-totaleto.ts:829-834`, `cash-flow-totaleto.ts:42-43`, `job-bom.ts:79-80`, `cash-flow-drill.ts:14-15`).

- Main module: `sync-totaleto.ts` (992 lines) — `getPartsCostBookedByJob` (line 201, AP-document/GL-posted basis, the live month's "Money Spent"), `getPartsActualByJob` (431), `getPartsCostSpentByJob` (504, lifetime), `syncPartsCostActual` (901), `syncFromTotalEto` (931).
- Scheduled (`auto-sync.ts:56-90`): `parts_cost`, `parts_cost_actual`, `totaleto_jobs` — hourly + manual refresh.
- Live-per-render (not pre-synced): `job-bom.ts` (Procurement BOM tree) and `po-detail.ts`, wrapped in a 12s timeout (`with-timeout.ts`) after a real incident of TotalETO hanging 100+ seconds.
- Cash Flow Forecast: `cash-flow-totaleto.ts`, captured into an immutable snapshot each refresh pass.
- Failure isolation: each sync step fails independently (`auto-sync.ts:164-200`), recorded via `recordSyncFailure`; Procurement/BOM views show an `EmptyState` rather than hanging.
- `sync-totaleto.ts:5-12` and `sync-actuals.ts:382-386` both state Money Spent was verified byte-for-byte against Power BI's own measure before the direct-SQL query replaced it — "removing the last Power BI / data-gateway dependency for the live ETC month's parts."

### 5.4 SharePoint / OneDrive Excel files beyond Paylocity
Two more live filesystem reads, neither documented in `docs/DEVELOPMENT.md`'s env-var table (Finding C):

1. **Lisa's monthly inventory workbook** — `job-cost-inventory-sync.ts`, default folder hardcoded at line 57 (`JOB_COST_INVENTORY_FOLDER` override), scans for `*inventory*.xlsx` each pass, on schedule as `job_cost_inventory`. Feeds Job Cost Explorer's %Complete/Sales$ via `job-cost-inventory-snapshot.ts`.
2. **Hiring positions workbook** — `hiring-workbook.ts`, default path hardcoded at line 21 (`HIRING_POSITIONS_LOCAL_PATH` override), a Paylocity Recruiting export. **Not on the sync schedule** — read live on every `/employees` render via `getHiringPositions()` (`hiring-positions.ts:102-117`); degrades gracefully to manual-only positions on failure.

**Finding C:** `docs/DEVELOPMENT.md`'s env-var table (lines 22-26) lists `JOB_HOURS_LOCAL_PATH` and `HOURS_SOURCE` but omits `JOB_COST_INVENTORY_FOLDER` and `HIRING_POSITIONS_LOCAL_PATH` — both real, both defaulting to hardcoded paths under one person's OneDrive profile.

### 5.5 Root-level Excel files

**`Employee_Department_Map.xlsx`** — not a production runtime dependency. Only actual reader: `scripts/import-employee-departments.ts:34-193`, a one-off script (`npx tsx ... [--apply|--apply-supervisors]`) that writes `Employee.department`/`positionTitle`/`supervisorId` into Prisma via name-matching; never creates/deactivates employees. All other hits are comment-only (`prisma/schema.prisma:104-106`, `employee-row.ts:15`, `disciplines.ts:15`, a migration file). Nothing breaks at runtime if it's unavailable — the data it seeded is already durably in `Employee` columns; only a future re-import would be blocked.

**`1116 Molex as of 7.31.26.xlsx`** — confirmed one-off audit input, exactly as suspected. Only actual reader: `scripts/_read_1116_ledger.ts:1-31` (dumps to `.tsv`). `scripts/_analyze_1116_ledger.ts:22` reads the *derived* TSV, one hop removed from the source file. Comment-only references in `sync-totaleto.ts:348-354,373-374` (documenting a bug fix already shipped 2026-08-10) and `tests/parts-actual-gl-posted.test.ts:7-12`. Nothing breaks if unavailable.

### Section 5 summary table

| Source | Live production dependency? | Key file(s) | Failure mode |
|---|---|---|---|
| Paylocity hours | Yes — OneDrive workbook, hourly + manual | `paylocity-workbook.ts`, `hours-feed.ts`, `auto-sync.ts` | Typed `WorkbookError`, last-good data stays, failure surfaced |
| TotalETO | Yes — direct SQL, scheduled + live per-job | `sync-totaleto.ts`, `job-bom.ts`, `po-detail.ts` | Isolated per-step failure; 12s timeout + `EmptyState` |
| Power BI — Function Hierarchy metadata | Yes, metadata only, hardcoded fallback | `job-hours-source.ts:146-188` | Falls back to `SECTION_ALIASES` |
| Power BI — T&M 3 dollar cards | Yes, intentional/permanent | `tm-report.ts` | Page-level error, out of scope |
| Power BI — JCE Sales Price fallback | Yes, fallback-only | `job-cost-source.ts:207-217` | Falls back further to `null` |
| Power BI — Fabric warehouse (ETC history) | No — CLI-only | `fabric-warehouse.ts`, `sync-etc-history.ts` | N/A, manual script |
| Power BI — Quoted hours / category pools / parts ETC | **No — dead code, zero callers** | `sync-actuals.ts` (2 fns), `parts-budget-projection.ts` (1 fn) | N/A |
| Lisa's inventory workbook | Yes — scheduled | `job-cost-inventory-sync.ts` | Skipped with a stated reason, not a hard failure |
| Hiring positions workbook | Yes — live per `/employees` render | `hiring-workbook.ts`, `hiring-positions.ts` | Falls back to manual-only, error string shown |
| `Employee_Department_Map.xlsx` | No — one-off script only, already imported into DB | `scripts/import-employee-departments.ts` | N/A |
| `1116 Molex as of 7.31.26.xlsx` | No — one-off audit script only | `scripts/_read_1116_ledger.ts` | N/A |

**Findings to carry forward:** (A) stale "PBI is THE source" header comment in `job-hours-source.ts:4-30`; (B) three dead PBI-calling functions (`syncQuotedFromPowerBi`, `syncCategoryPoolsFromPowerBi`, `fetchPartsEstimatedToComplete`); (C) `docs/DEVELOPMENT.md`'s env-var table is missing two real hardcoded-path env vars. `docs/INTEGRATIONS.md` was independently re-verified (not trusted blindly) and found largely accurate at a summary level — a future `docs/DATA_SOURCES.md` should either supersede or cross-link it rather than duplicating the same facts twice.

---

## 6. Root-level & scripts/ classification

**Context:** `git log` shows checkpoint `4b74d9b` sits on top of `57cb6eb` and already committed everything that was `M`/`D` at the start of this project, including `docs/DEVELOPMENT.md`. So `git diff HEAD -- docs/DEVELOPMENT.md` is currently empty; the only real "modified" state that ever existed was inside that checkpoint commit itself. Current working tree has only two untracked, non-code items: `scripts/readiness-audit-output.tsv` and `tables to cards redesign/`.

### 6.1 `docs/` folder — 18 Markdown files, no subfolders
Covers architecture, codebase structure, data flow, deployment, dev setup, Entra SSO, ETC business logic, Graph app-only auth (self-flagged **"NO LONGER URGENT, sync is back up by another route"**), integrations, Paylocity ingestion, Power BI continuity, realtime sync, refresh pipeline, semantic model map, testing, troubleshooting, and an auto-generated `UNMAPPED-HOURS.md` (confirmed generated by `scripts/report-unmapped-hours.ts`, whose own header names that exact output path).

`README.md`'s docs table (lines 39-51) lists only 11 of the 18; its prose (53-54) covers 4 more as "standalone setup guides." **`SEMANTIC-MODEL-MAP.md` and `UNMAPPED-HOURS.md` are the only two not mentioned anywhere in README.md** — a minor, verifiable gap.

`docs/DEVELOPMENT.md`'s only substantive change in the `4b74d9b` checkpoint (per `git diff 57cb6eb 4b74d9b`) was updating the env-var table: it used to document 4 separate password env vars, now documents only `CONFIRM_PASSWORD` plus a note that Projects/Standard Sheet/Audit Log access is now a role check. This tracks a real code change, not drift.

### 6.2 `scripts/` folder — full classification
Only two scripts are directly wired into a production/build/test path: `free-port.mjs` (`npm run deploy`/`free-port`) and `shim-server-only.cjs` (`npm test`). `server-only-stub.ts` is load-bearing supporting infra for 4 of the recurring-maintenance scripts (via `tsconfig.scripts.json`) but not itself in `package.json`.

**PRODUCTION-CRITICAL (2):** `free-port.mjs`, `shim-server-only.cjs`.

**RECURRING-MAINTENANCE (25)** — headers explicitly say re-runnable/permanent, or feed a `docs/*.md` generator: `backfill-etc-history.ts`, `change-log-smoke.ts`, `check-graph-auth.ts`, `check-powerbi-auth.ts`, `export-smoke.ts`, `import-employee-departments.ts`, `parts-actual-recon.ts`, `parts-cost-projection-audit.ts` (**active — modified today, Aug 19; this specific script previously produced two wrong clearances of the parts-cost double-count bug per user memory — do not archive without checking with the user**), `paylocity-workbook-smoke.ts`, `perf-baseline.ts`, `readiness-audit.ts`, `reconcile-employee-groups.ts`, `refresh-smoke.ts`, `report-unmapped-hours.ts`, `submit-smoke.ts`, `verify-cash-flow-reconcile.ts` (active, dated today), `verify-job-cost-snapshot.ts`, `verify-parts-invoiced-reconciliation.ts`, `verify-procurement-release-status.ts`, `verify-quoted-hours.ts`, `verify-sections.ts`, `verify-tm-hours-vs-powerbi.ts` (active, dated today).

**ONE-OFF (11)** — headers explicitly say one-time/done, several self-documenting an existing repo convention of leaving completed one-off scripts in place "as a record": `_analyze_1116_ledger.ts`, `_read_1116_ledger.ts`, `add-missing-jobs.ts`, `backfill-employee-team.ts`, `backfill-hours-2025.ts`, `backfill-password-hashes.ts`, `deactivate-non-project-departments.ts`, `import-june-2026-from-excel.ts`, `link-scheduler-users.ts`, `plan-scheduler-team-from-departments.ts`, `restore-zero-hours-carryforward-2026-07.ts`.

**Standalone Python (1), flagged for a decision, not classified as clean one-off:** `etl_job_hours.py` — its own header calls itself "a standalone Python equivalent of `src/lib/sharepoint-hours.ts` + `syncJobHoursDetail`." **`src/lib/sharepoint-hours.ts` no longer exists** (confirmed via `ls`); DEVLOG §12 (line 662) says it was added 2026-07-31 as a fallback for the SharePoint/Graph hours path, which per the user's own memory index has since been fully retired in favor of the current workbook/PBI-metadata path. Its stated reason for existing points at deleted code, but no DEVLOG entry was found explicitly retiring the script itself — flagged as "needs a decision," not asserted dead.

**Non-script files in `scripts/`:** `_1116_dump_Job_Ledger.tsv` (145K, git-tracked, companion to the two `_1116_ledger` scripts); `_backup_june_snapshots_1785703332190.json` (22K, gitignored via `.gitignore:72`, "rollback dumps... data, not code"); `readiness-audit-output.tsv` (1.4K, untracked, output of `readiness-audit.ts`).

**`scripts/archive/`** (30 files: 21 underscore `_check_*`/`_recon_*`/`_verify_*` + 6 `repair-*` + 1 `.sql`, all git-tracked) is already the repo's established home for retired one-off scripts — direct precedent that the 11 ONE-OFF scripts above are exactly the kind of file this folder exists to hold. **`scripts/__pycache__/etl_job_hours.cpython-314.pyc`** is correctly gitignored (`.gitignore:69`) and inert.

### 6.3 `DEVLOG.md`
5,998 lines / 358,605 bytes, last modified 2026-08-11. Structure is chronological and append-only, 65 numbered top-level sections (§1-§66, one gap-free sequence), §10 onward dated 2026-07-14 through 2026-08-11 (§66). **A grep for any date `2026-08-1[4-9]` or later returns zero matches — DEVLOG has not been written to in 8 days**, despite real feature commits after that date (`fd5c123`, `03c2ebb`, `689d647`, `2ebd853`, `57cb6eb`) and the entire Cash Flow / T&M report / Hiring positions / new permissions model feature set folded into the `4b74d9b` checkpoint with no corresponding entry. This directly contradicts README.md:56's description of DEVLOG.md as "the detailed, dated running history of every change."

### 6.4 `README.md`
Port (3010) and the commands table both check out accurately against `package.json`/`ecosystem.config.js`. **Stale claim found:** line 31 says `npm test # run the test suite (57 files, tsx --test)`; actual count verified two ways is **99 files**, all flat in `tests/` — the figure is out of date by 42 files. Docs-table gap noted in 6.1. Everything else checks out.

### 6.5 `AGENTS.md`, `CLAUDE.md`, `.claude/`
`AGENTS.md` (5 lines) and `CLAUDE.md` (1 line, `@AGENTS.md` import) are both intact and match what's injected into this session's own system prompt — working as intended, not stale. `.claude/launch.json` (1,941 bytes) matches the `-verify`/`-verify2`/`-verify3`/`-perf` profiles documented in `docs/DEVELOPMENT.md:51`. `.claude/worktrees/` exists but is empty. `.claude/agents/` and `.claude/skills/` do not exist at all.

### 6.6 `.env.bak-before-password-change`
Exists, 3,185 bytes, last modified Aug 4 — 15 days old as of 2026-08-19. Confirmed gitignored (`git check-ignore -v` → `.gitignore:38:.env*`), never committed, won't show in `git status`. Contents were not read or printed (credential file, out of scope for a read-only audit). **Needs a human decision on retention/deletion — this is a user call, not one an audit can resolve.**

---

## 7. Master classification table

Covers every item raised across all six audits, plus the items already established by prior manual check (marked *pre-known* in Evidence).

| Item | Classification | Evidence | Recommended Phase-2+ action |
|---|---|---|---|
| `.next/` | KEEP-production | *Pre-known* — currently serving via PM2 (`ecosystem.config.js`) | None — build output, regenerated every deploy |
| `.next-verify/`, `.next-verify2/` | KEEP-source (dev tooling) | Deploy-audit §1: referenced in `.claude/launch.json:29,38`, `.gitignore:19`, `tsconfig.json:42-43,48-49,57-58`, `docs/DEVELOPMENT.md:50-53` | None — live, documented verification dist-dirs |
| `.next-verify3/` | KEEP-source (dev tooling) | Deploy-audit §1: `.claude/launch.json:57`, same tsconfig/gitignore pattern | None |
| `tables to cards redesign/` | OBSOLETE | *Pre-known* — design mockup scratch, already excluded from the WIP checkpoint commit | Delete in Phase 2 once user confirms no longer needed |
| `reference/` | KEEP (not a cleanup target) | *Pre-known* — gitignored design-reference folder | None |
| `Employee_Department_Map.xlsx` (root) | KEEP-production input (wrong location) | *Pre-known*; confirmed by data-source audit §5.5 — only reader is `scripts/import-employee-departments.ts:34-193`, data already durably in `Employee` table | Move into a `scripts/data/` or similar folder in Phase 2; keep the file, just relocate |
| `1116 Molex as of 7.31.26.xlsx` (root) | OBSOLETE-leaning | *Pre-known*; confirmed by data-source audit §5.5 — one-off audit input for a bug already fixed 2026-08-10 | Archive or delete once user confirms the fix narrative is no longer needed for reference |
| `.env.bak-before-password-change` | UNKNOWN | *Pre-known*; root-structure audit §6.6 — 15+ days old, gitignored, contents not read | Human decision required — see Section 8 |
| `scripts/free-port.mjs` | KEEP-production | Deploy audit §1; dependency/root audits — wired into `npm run deploy` (package.json:11-12) | None |
| `scripts/shim-server-only.cjs` | KEEP-production | Root-structure audit §6.2 — wired into `npm test` (package.json:14) | None |
| `scripts/server-only-stub.ts` | KEEP-source (supporting infra) | Root-structure audit §6.2 — referenced by `tsconfig.scripts.json:6`, load-bearing for 4 recurring-maintenance scripts | None |
| `scripts/*.ts` — 25 RECURRING-MAINTENANCE scripts (see §6.2 full list) | KEEP-source | Root-structure audit §6.2 — headers self-describe as re-runnable/permanent, or feed a docs generator | None; leave in place |
| `scripts/parts-cost-projection-audit.ts` | KEEP-source (active, sensitive) | Root-structure audit §6.2 — modified today; user memory records this exact script previously produced two wrong clearances of a real bug | Do not touch/archive without explicit user confirmation |
| `scripts/*.ts` — 11 ONE-OFF scripts (see §6.2 full list) | OBSOLETE-leaning (by their own header text) | Root-structure audit §6.2 — each self-describes as done/one-time; existing convention is to move such scripts to `scripts/archive/` rather than delete | Move to `scripts/archive/` in Phase 2, consistent with existing precedent (30 files already there) |
| `scripts/etl_job_hours.py` | UNKNOWN (likely stale) | Root-structure audit §6.2 — claims to mirror `src/lib/sharepoint-hours.ts`, which no longer exists; no DEVLOG entry found retiring the script itself | Needs a decision — confirm nothing still invokes it before moving to archive |
| `scripts/_1116_dump_Job_Ledger.tsv` | OBSOLETE-leaning | Root-structure audit §6.2 — companion data dump to the two `_1116_ledger` scripts, git-tracked | Archive alongside the `1116` xlsx and its reader scripts |
| `scripts/_backup_june_snapshots_1785703332190.json` | KEEP (as-is) | Root-structure audit §6.2 — gitignored rollback dump, explicitly "data, not code" | None — leave gitignored in place |
| `scripts/readiness-audit-output.tsv` | UNKNOWN (scratch) | Root-structure + deploy audits — untracked output of `readiness-audit.ts` | Safe to delete or gitignore; confirm not needed as a reference snapshot first |
| `scripts/archive/` (30 files) | KEEP-documentation (as precedent/history) | Root-structure audit §6.2 — established home for retired one-off scripts, all git-tracked | None |
| `scripts/__pycache__/` | GENERATED | Root-structure audit §6.2 — compiled bytecode cache, gitignored | None — inert, regenerates itself |
| `docs/*.md` (18 files, see §6.1) | KEEP-documentation | Root-structure audit §6.1 | None; note `SEMANTIC-MODEL-MAP.md`/`UNMAPPED-HOURS.md` missing from README's table |
| `docs/GRAPH-APP-ONLY-SETUP.md` | KEEP-documentation (self-flagged stale) | Root-structure audit §6.1 — own header says "NO LONGER URGENT" | Leave as historical runbook, or add a top-of-file pointer to the current method |
| `docs/DEVELOPMENT.md` env-var table | KEEP-documentation (gap) | Data-source audit Finding C — missing `JOB_COST_INVENTORY_FOLDER`, `HIRING_POSITIONS_LOCAL_PATH` | Add the two missing env vars |
| `DEVLOG.md` | KEEP-documentation (stale) | Root-structure audit §6.3 — 8 days stale, missing 5+ real commits' worth of history | Backfill missing entries or formally retire the "detailed running history" claim in README |
| `README.md` test-count line | KEEP-documentation (stale fact) | Root-structure audit §6.4 — says 57 test files, actual is 99 | One-line fix: update the count |
| `AGENTS.md`, `CLAUDE.md` | KEEP-source (config) | Root-structure audit §6.5 | None |
| `.claude/launch.json`, `.claude/settings.local.json` | KEEP-source (config) | Root-structure audit §6.5 | None |
| `.claude/worktrees/` | KEEP (empty, inert) | Root-structure audit §6.5 | None |
| `src/components/charts/ChartTooltip.tsx` | DEAD (unreferenced) | Dead-code audit §4.1 — zero real code references repo-wide | Delete in Phase 2 |
| `src/components/charts/GaugeCard.tsx` | DEAD (unreferenced) | Dead-code audit §4.1 — zero real code references repo-wide; consistent with variance-gauge removal | Delete in Phase 2 |
| `src/app/(app)/quoted/new/page.tsx` (+ its `createProject` action) | OBSOLETE (orphaned, self-documented) | Dead-code audit §4.2 — no live entry point; `docs/CODEBASE-STRUCTURE.md:42` calls it "Legacy" | Delete, after confirming no external bookmark/workflow still targets it directly |
| `src/app/(app)/jobs/new/page.tsx` | KEEP-source (intentional redirect) | Dead-code audit §4.2 — deliberate bookmark soft-landing | None |
| `src/app/api/jobs/export/route.ts` | KEEP-source (intentional 410) | Dead-code audit §4.2 — deliberate retirement with explanatory response | None unless bookmark compatibility is being dropped |
| `src/lib/sync-actuals.ts: syncQuotedFromPowerBi` | DEAD (zero callers) | Data-source audit Finding B | Remove or keep as documented reference — user decision |
| `src/lib/sync-actuals.ts: syncCategoryPoolsFromPowerBi` | DEAD (zero callers) | Data-source audit Finding B | Remove or keep as documented reference — user decision |
| `src/lib/sync-actuals.ts: previousMonth()` | DUPLICATE (of `etc.ts:prevMonth`) + likely dead | Duplicate-logic audit §3.8; own comment says "no longer on any automatic path" | Confirm dead, then remove in favor of `etc.ts:prevMonth` |
| `src/lib/parts-budget-projection.ts: fetchPartsEstimatedToComplete` | DEAD (zero callers) | Data-source audit Finding B | Remove or keep as documented reference — user decision |
| `src/lib/job-hours-source.ts:4-30` header comment | KEEP-source (doc fix needed) | Data-source audit Finding A — asserts PBI is "THE source," false since 2026-08-05 | Rewrite comment to describe the file's true current role (metadata + fallback) |
| `src/lib/hours-filters.ts:60-65` vs `HoursDetailPanel.tsx:147-152` | DUPLICATE | Duplicate-logic audit §3.1 — independently reimplemented, diverging unranked-fallback sentinel | Consolidate into one exported helper |
| `src/lib/monthly-report.ts:162` | DUPLICATE + live bug | Duplicate-logic audit §3.5 — hand-rolled currency string renders `$-5,000` instead of `-$5,000` for negative Parts Cost | Replace with `usd()` from `ui/format.ts` |
| Hours-formatting reimplementations (8+ sites, see §3.6) | DUPLICATE | Duplicate-logic audit §3.6 | Migrate to `hours()`/`hoursCell()` from `ui/format.ts` |
| `job-hours-dashboard.ts:72-75,106-108`, `hours-explorer.ts:99` | DUPLICATE | Duplicate-logic audit §3.7 — reimplement `compareJobIds()` | Replace with `compareJobIds()` import |
| `job-hours-source.ts:normalizePbiJobId`, `paylocity-workbook.ts:normalizeJobNumber`, `job-cost-inventory-sync.ts:normalizeJobId` | DUPLICATE (2 identical + 1 divergent) | Duplicate-logic audit §3.7 | Consolidate the two identical ones; reconcile or document the third's differing null-handling |
| `currentMonth()` × 3 (local) + `currentMonthKey()` (UTC) | DUPLICATE + live correctness risk | Duplicate-logic audit §3.8 — confirmed UTC-vs-local divergence near month boundaries | Highest-priority consolidation target: one exported, timezone-consistent helper |
| `prevMonth`/`previousMonth` × 3 | DUPLICATE (self-consistent today) | Duplicate-logic audit §3.8 | Consolidate into one exported helper |
| ~15 inline `Date → "YYYY-MM"` sites | DUPLICATE | Duplicate-logic audit §3.8 | Route through `reportMonthForWorkDate()` or a new shared helper where applicable |
| `src/app/api/export/[report]/route.ts:73-77` | LIVE BUG (authorization gap) | Duplicate-logic audit §3.4 — no `hasPermission()` check before streaming Projects/ETC/Hours export | **Fix promptly, independent of cleanup scheduling** — add the missing permission check |
| `route-permissions.ts` — `/cash-flow` missing entry | LIVE GAP (inconsistency, not currently exploitable) | Duplicate-logic audit §3.4 | Add `/cash-flow` to `ROUTE_PERMISSIONS` for defense-in-depth consistency |
| `cash-flow-access.ts` / `layout.tsx:48` raw `"ELT"` checks | KEEP (intentional, but duplicated) | Duplicate-logic audit §3.4 — documented design choice, two independent literal comparisons | Optional: factor into one shared predicate for future-proofing |
| `DataQualityDrill.tsx` hand-copied drill styling | DUPLICATE (documented) | Duplicate-logic audit §3.9 | Low priority — migrate to `ui/Drill.tsx` if the table ever needs drill-group structure anyway |
| All 31 `package.json` dependencies | KEEP-source | Dependency audit — full table, every package confirmed used | None |

---

## 8. Open questions requiring a human decision

- **`.env.bak-before-password-change`** — 15+ days old, gitignored, contents intentionally not read by any audit. No audit can determine whether it's safe to delete without knowing what's in it and whether it's still needed as a recovery point. **Requires the user to inspect and decide.**
- **`scripts/etl_job_hours.py`** — its stated purpose (mirror `src/lib/sharepoint-hours.ts`) points at code that no longer exists, but no audit found a DEVLOG entry or comment explicitly retiring the script itself, and it was not confirmed that nothing external (a scheduled task outside the repo, a manual runbook) still invokes it. Root-structure audit explicitly declined to assert it dead.
- **`scripts/parts-cost-projection-audit.ts`** — modified today (Aug 19) and, per the user's own memory, has a track record of producing wrong clearances of a real bug in the past. This script should not be archived, rewritten, or treated as a stale one-off without the user's explicit sign-off, even though its "audit" naming pattern superficially resembles the ONE-OFF bucket.
- **Build Readiness's drawer-stack drill pattern vs. `ui/Drill.tsx`** — the duplicate-logic audit could not determine whether never adopting the shared component was a deliberate scoping decision or simply never considered. Worth a direct question to whoever built Build Readiness before deciding whether consolidation is even desirable there.
- **`syncQuotedFromPowerBi`, `syncCategoryPoolsFromPowerBi`, `fetchPartsEstimatedToComplete`** (dead PBI-calling functions) — each has a self-documented "why this was replaced" comment nearby, suggesting the team may want to keep them as reference implementations rather than delete outright. This is a preference call, not a correctness one.
- **The `git reflog`'s recurring `reset: moving to HEAD` pattern** — the deploy audit found this pattern but explicitly could not distinguish (from reflog text alone) a harmless mixed reset from a destructive `--hard` reset. If the "disappearing changes" symptom recurs, this is worth a targeted follow-up (e.g., checking shell history or asking whoever ran those resets) rather than something a file-level audit can resolve.
- **`quoted/new/page.tsx` deletion** — flagged high-confidence orphaned by the dead-code audit, but deleting it removes a server action (`createProject`) entirely; the audit recommended confirming no external bookmark or undocumented workflow depends on the direct URL before removing, which requires user knowledge the codebase itself can't provide.
- **DEVLOG.md's 8-day staleness** — is a process question (should someone backfill the missing entries, or has the team moved on from maintaining this file) rather than a code-classification question; no audit can decide which without the user's input on current documentation practice.
- **Whether `docs/INTEGRATIONS.md` should be superseded or cross-linked** by a future consolidated data-sources doc — the data-source audit surfaced this as a real decision point but explicitly left it as "a decision for whoever writes it."
