# Paylocity hours ingestion — root-cause report and design (§42)

**Date:** 2026-08-05 · **Status:** ingestion, Undefined Hours and reconciliation shipped and
measured; visual pass partially complete (see [What is not done](#what-is-not-done)).

This answers §42.31's seventeen required deliverables, in order, with measured figures.

---

## The headline finding

**The application was never stale. The Power BI model it read was.**

Hours were switched from Lisa's OneDrive workbook to Power BI's `Hours Actual` table on
2026-08-03, on the evidence that the two agreed on 1,127 of 1,127 job × section × month
cells. That equivalence was real — and it was measured across **settled months only**, so
it could not reveal the one property that mattered: the model lags the file.

Three-way reconciliation, 2026-08-05, before any change
(`scripts/archive/_recon_workbook_vs_pbi_vs_db.ts`):

| month | Lisa's workbook | Power BI | database |
|---|---:|---:|---:|
| 2026-06 | 7,357.98h | 7,357.98h | 7,358.01h |
| 2026-07 | **6,823.60h** | 6,673.07h | 6,673.07h |
| 2026-08 | **293.50h** | **0.00h** | **0.00h** |

* Workbook latest work date **2026-08-04**; Power BI latest **2026-07-31**.
* July short **150.53h** across 46 job × section cells. August **entirely absent** — 56 cells.
* **Power BI → database was exact** (−0.00h July). The app's own sync was working perfectly
  the whole time; it faithfully imported stale data.

No cache invalidation, refresh-button fix or UI change could have addressed this, because the
data was not there to fetch. §42 was right to forbid a frontend workaround.

**June matching to the penny with zero differing cells** is what made switching the source
safe: for a settled month, the file and the model are the same data — the file is simply
days earlier.

---

## §42.31 deliverables

### 1. The OneDrive path / configuration used

```
C:\Users\akamuju\OneDrive - Steven Douglas Corp\SDC- Power BI Integration - Job Hours Report\Job Hours From Paylocity\Current_Job_Hours.xlsx
```

Read from `JOB_HOURS_LOCAL_PATH`, which **already existed in `.env`** and already pointed
here — it is the variable the pre-2026-08-03 reader used, left behind when that reader was
deleted. Reused rather than renamed so no deployment has to change.

The folder carries Windows attribute `0x80000` (**PINNED**, "Always keep on this device"), so
the file is hydrated on local disk. **No Microsoft Graph auth is involved**, which means the
`Sites.Selected` admin-consent blocker recorded in `GRAPH-APP-ONLY-SETUP.md` does not apply
to this route.

### 2. File-selection logic *before* the fix

There was none. `src/lib/sharepoint-hours.ts` was deleted in commit `180c930`. Nothing under
`src/` read OneDrive, Graph, or any local file. `src/lib/job-hours-source.ts` issued a DAX
query per month against Power BI's `Hours Actual`, filtered to
`Data Source = "Paylocity Hours"`.

### 3. The corrected latest-file detection

`src/lib/paylocity-workbook.ts`. Deliberately **not** filename-based, because Lisa replaces
the file keeping the same name:

* `stat` → `readFile` → `stat` again. If size or mtime moved across the read, the bytes are
  not a coherent version and the import aborts with `file_unstable` (§42.3, "processing
  beginning before the upload is complete"). No sleeping or polling.
* `sha256` of the exact bytes parsed — the version identity.
* Short-read guard (`byteLength !== size`).
* `.xlsx` is a zip, so a partially-uploaded file fails to open; that is the strongest
  completeness check available and it is free.
* A dehydrated OneDrive placeholder surfaces as `file_unreadable` with a message naming the
  fix ("set the folder to Always keep on this device"), not `ENOENT`.

### 4. The version / ETag / content check used

`sha256` of the parsed bytes, stored on `PaylocityImport.sha256` and compared against the last
import with `status = "ok"`. A failed attempt cannot make the next run believe the file is
already in.

**An unchanged file is still imported.** The file is not the only input — a job created since
the last pass turns `JOB_NOT_FOUND` rows into attributable hours, and a reopened month needs
its hours written again. Skipping would strand those until Lisa happened to save. Idempotency
comes from the write being replace-by-`(job, month)`, not from refusing to run; `status` is
recorded as `"unchanged"` so the UI never implies new data arrived (§42.16).

### 5. Worksheet and columns processed

Sheet **`Report`** (the only sheet), 19,826 data rows at time of writing. Columns matched **by
name, not position** — inserting a column upstream now raises `headers_missing` naming the
missing header, rather than silently producing wrong numbers.

| column | use |
|---|---|
| `Employee Id` | Paylocity id, joined to `Employee.paylocityId` at read time |
| `Work Date` | **the only** input to report-month assignment (§42.6) |
| `Jobs` | zero-padded job number (`"0114"` → `114`) |
| `Jobs Name` | not used (the app owns job names) |
| `MachineSec` + `Function` | section code, e.g. `80-311` |
| `Total Hours Worked` | signed — negatives are corrections and must net |
| `Travel` | not used; reaches no figure |

### 6. The exact Hours Worked Month formula

```
Hours Worked Month(job, section, month)
  = Σ round2( Σ segments ) over punches where
      normalizeJobNumber(Jobs) = job
      AND mapPunchToColumns(MachineSec-Function) = section
      AND reportMonthForWorkDate(Work Date) = month
```

with, in order: `Total Hours Worked ≠ 0`; job cell numeric and known; the model-derived
code→column map (`buildColumnResolver`, falling back to `SECTION_ALIASES`); the `10-311`
30/70 split into `10-312`/`10-313`; rounding applied once at the storage grain
`(job, section, workDate, employee)`.

`reportMonthForWorkDate` is UTC and lives in `src/lib/undefined-hours-rules.ts` so the §42.6
rule has one implementation and a test.

### 7. The exact Undefined Hours formula

```
Undefined Hours(month)
  = Σ hours over rejected punches where
      reason ∈ { MISSING_JOB_ID, JOB_NOT_FOUND }
      AND the punch WOULD have reached an ETC grid column had the job been valid
      AND reportMonthForWorkDate(Work Date) = month
```

Defined once in `src/lib/undefined-hours-rules.ts` — a module with **no I/O at all** (no
`server-only`, no Prisma, no ExcelJS), so the KPI, the drill-through, the export and the tests
share one implementation rather than agreeing by convention.

The definition is deliberately narrow, matching the signed-off KPI. Everything else the
importer rejects is rejected *correctly*: phases 80/90 the app does not model, the four
Standard Fees pool sections, function 417. Those total **5,170h** against a headline of
**568h** — folding them in would be a nine-fold overstatement and would report correct
behaviour as a fault. They are still captured, classified and shown in the drill under
"correctly excluded" (§42.7).

**One deliberate widening**, stated so nobody later finds an unexplained step: `JOB_NOT_FOUND`
now also covers numerically-valid job numbers the app has no `Job` row for — 15 values
including `2026` (141.75h, someone typing the year), `0964`, `4263`, `624`. These previously
counted as `jobsNotFound` and were dropped without appearing anywhere, which §42.7 forbids and
§42.9 lists as an Undefined Hours category. Cost: 2026-04 +0.13h, 2026-07 +6.61h.
**Settled months are otherwise unchanged.**

### 8. Why the KPI was not refreshing

Two independent causes:

1. **The data was not there.** Power BI held no August at all, so no amount of recalculation
   could produce an August figure.
2. **The KPI and its drill read different sources.** The card read `HoursImportIssue` from
   MySQL (`etc/page.tsx:566`); the drill ran a live DAX query
   (`unattributed-hours.ts:49`). `unattributed-hours.ts` documented the divergence in its own
   header as an accepted trade-off: *"this can disagree with the card if the file has changed
   since the last sync."*

### 9. Why the drill-through was not refreshing

Same cause (2) above, plus it recomputed from the source on every click — a live round-trip
measured at ~750ms after an earlier optimisation and ~4,936ms before it. It now reads one
indexed table.

### 10. Cache / state / API / database issues discovered

* **No stale cache existed.** Every route under `(app)` is dynamically rendered because the
  layout awaits `auth()`, and nothing uses `unstable_cache` or route-segment revalidation.
  This was already documented in `LiveRefresh.tsx` and is confirmed here.
* **Schema drift, caught before it did harm.** `prisma migrate diff` wanted to
  `DROP COLUMN currentStage` from `RefreshRun`. That column is live and used by raw SQL in
  `refresh-service.ts:171`, but had never been declared in `schema.prisma`. Applying the
  generated migration unreviewed would have broken refresh progress — the feature §42.15 asks
  to extend. Now declared as `@db.VarChar(64)`, matching the live column exactly so no `ALTER`
  is emitted.
* **A round-then-aggregate defect, found by the new reconciliation check on its first live
  run.** The KPI total was summed from raw values and rounded once; the drill summed rows that
  were each rounded on the way in. Mismatch of +0.04h (2026-06) and +0.01h (2026-07) — small,
  but §42.11 defines any mismatch as a calculation failure, and the drill duly showed it in
  red. Fixed by rounding once, up front, and deriving both from the same numbers.
* **`failed` and `invalid` cell states were visually identical** (`ring-2 ring-inset
  ring-sdc-red`), despite demanding opposite responses. §42.25 violation; fixed and tested.

### 11. Files and backend services changed

| file | change |
|---|---|
| `src/lib/paylocity-workbook.ts` | **new** — the reader, validation, rejection classification |
| `src/lib/undefined-hours-rules.ts` | **new** — the Undefined Hours definition, no I/O |
| `src/lib/hours-feed.ts` | **new** — the single entry point; source selection and partition |
| `src/lib/paylocity-import.ts` | **new** — file identity, idempotency, audit record |
| `src/components/UndefinedHoursPanel.tsx` | **new** — the redesigned drill (§42.27, §42.28) |
| `src/lib/unattributed-hours.ts` | rewritten to read persisted rows |
| `src/lib/auto-sync.ts` | reads `readHoursFeed()`; new `undefined_hours` stage |
| `src/lib/sync-actuals.ts` | `recordImportIssues` removed; undefined hours moved out |
| `src/lib/refresh-service.ts` | passes `refreshId` + `userName` to the import record |
| `src/lib/etc-save-state.ts` | `failed` distinguished from `invalid` |
| `src/components/EtcMonthKpiCards.tsx` | uses the new drill panel |
| `prisma/schema.prisma` | two new models; `currentStage` drift corrected |

### 12. Database tables and queries changed

* **`UndefinedHoursRow`** (new) — punch-level rows behind the KPI. Employee name and
  department are deliberately **not** copied; only `employeeId` is stored and the rest is
  joined at read time, so correcting an employee record fixes every historical drill row.
* **`PaylocityImport`** (new) — one row per import: file name, path, size, mtime, `sha256`,
  sheet, work-date range, months covered, rows read/inserted/updated/removed/invalid/undefined,
  timings, trigger, user, status, failure stage and detail, app version.
* **`RefreshRun.currentStage`** — declared, not altered.
* Migration `20260805120000_add_paylocity_import_audit`, applied with `migrate deploy`.
  **Purely additive** — two `CREATE TABLE`s, no `ALTER`, no `DROP`, verified by inspecting the
  generated SQL before applying.

### 13. Reconciliation results, before and after

**Hours reaching the database** (`scripts/archive/_verify_hours_import.ts`):

| month | before | after | delta |
|---|---:|---:|---:|
| 2025-12 | 5,964.29h | 5,964.29h | **0.00** (history untouched) |
| 2026-05 | 6,902.02h | 6,902.02h | 0.00 |
| 2026-06 | 7,358.01h | 7,358.01h | 0.00 |
| 2026-07 | 6,673.07h | **6,825.98h** | **+152.91** |
| 2026-08 | 0.00h | **520.23h** | **+520.23** |

**KPI ↔ drill-through reconciliation** (§42.11):

| month | before | after |
|---|---|---|
| 2026-06 | KPI 240.43 / drill 240.47 — **error** | **matches: 240.47h** (59 rows, 4 employees) |
| 2026-07 | KPI 195.79 / drill 195.80 — **error** | **matches: 195.80h** (49 rows, 5 employees) |
| 2026-08 | — | **matches: 8.00h** (2 rows, 1 employee) |

**Idempotency:** a second consecutive import produced **0.00h delta on every month** and
`status = "unchanged"`.

**Settled-month safety** (`scripts/paylocity-workbook-smoke.ts`): every overlapping month
reproduces the stored data exactly at storage precision; 2026-06 reproduces Power BI exactly
(172 cells, 7,357.98h, **0 differing cells**). The eleven months the workbook does not reach
(2025-02…2025-12) are listed and left untouched.

### 14. Visual components redesigned

* **`UndefinedHoursPanel`** (new) — replaces the borrowed `HoursDetailPanel`. Leads with the
  reason breakdown and the corrective action for each; four header stats (undefined hours,
  records, employees affected, correctly excluded); reconciliation banner (§42.28) with glyph
  *and* wording, not colour alone; search and per-reason filtering with an explicit "filtered —
  not reconciling" notice so a subtotal is never mistaken for the headline; source-row numbers
  so a row can be found in the workbook; provenance footer naming the file version.
* **Cell states** — `failed` separated from `invalid`; pinned by
  `tests/cell-state-distinctness.test.ts`.

### 15. Responsive breakpoints tested

**Not yet tested.** See below.

### 16. Automated tests added

* `tests/undefined-hours-rules.test.ts` — 16 tests: the definition, KPI↔drill identity, the
  round-then-aggregate regression, month and year boundaries, negative corrections, empty
  months, mismatch reporting.
* `tests/cell-state-distinctness.test.ts` — 5 tests: state distinctness, no background
  collision with the yellow rule, no layout shift, error/conflict/invalid separation.
* `scripts/paylocity-workbook-smoke.ts` — real-file smoke test; **fails the run** if any
  settled month diverges.
* `scripts/archive/_verify_hours_import.ts` — end-to-end before/after with reconciliation.

**Suite: 621 tests, 621 pass.**

### 17. Confirmation that no existing functionality was removed

Confirmed. `recordImportIssues` was replaced by a superset (`recordUndefinedHours` writes the
same `HoursImportIssue` rows plus the punch rows). `HoursDetailPanel` is untouched and still
serves the Engineering/Shop/Parts drills. Power BI reading is retained behind
`HOURS_SOURCE=power_bi` and is still used for the Function Hierarchy code→column map. The
2025 history the workbook cannot reach is preserved. Type-check clean; full suite green.

---

## §43 — Validating the app against the Power BI report

Reported 2026-08-05: the report shows July 2026 Engineering **3,020**, Shop **2,680**,
Manufacturing **676**; the app's grid footer shows Engineering **3,154**, Shop **2,698**.

Reconciled with `scripts/archive/_recon_pbi_definitions.ts`, which parses the workbook **raw**
rather than through `readPaylocityWorkbook` — that reader has already applied the app's
column mapping, and the mapping is the thing under test. Comparing a mapping against
itself proves nothing.

July 2026, Active + billable jobs (the grid's job set):

| | ENG | SHOP | MFG |
|---|---:|---:|---:|
| Power BI report | 3,020.00 | 2,680.00 | 676.00 |
| PBI's *definition* applied to today's data | 3,158.83 | 2,702.77 | 688.62 |
| App's definition applied to today's data | 3,153.83 | 2,697.90 | 688.62 |
| **App, as stored** | **3,153.81** | **2,697.91** | — |

Both gaps close exactly:

```
ENG    3,153.81  app
        +  5.00  Warranty (phase 70) — PBI counts it, the ETC grid excludes it
      = 3,158.81  ≙ PBI's definition on the same data (3,158.83)
        −138.83  July punches the model has not ingested
      = 3,020.00  the report

SHOP   2,697.91  app
        +  4.86  Warranty 4.78 + Service (phase 80) 0.08
      = 2,702.77  exactly PBI's definition on the same data
        − 22.77  freshness
      = 2,680.00  the report
```

**No formula was changed, because none was wrong.** The import is faithful to 0.02h
(3,153.81 stored vs 3,153.83 derived). Specifically:

* **Missing records:** none.
* **Duplicated:** none — a second consecutive import produces 0.00h delta.
* **Incorrectly mapped:** none found. Every hour lands where Power BI puts it, bar the
  two deliberate exclusions.
* **Excluded, by design:** 9.86h Warranty/Service; 429h ENG + 325h SHOP on jobs that are
  not Active+billable (already surfaced by the **Hours off the grid** KPI); 183h on job
  numbers the app does not recognise (already the **Undefined Hours** KPI).
* **Manufacturing is not missing.** All 688.62h is imported; it is off the ETC grid by
  design, planned company-wide in the `SHOP_MANUFACTURING` Standard Fees pool, which is
  why the grid has no Mfg column.

The app is therefore **ahead of** the report by ~161h of July time. Matching the report
exactly would mean reverting to the stale model — re-losing the 152.91h recovered the
same morning — or folding Warranty into a total the team signed off on 2026-07-31.
Confirmed with the user: **change neither**.

### What was added instead

The gap is now stated rather than left to be rediscovered:

* The Monthly ETC header reads **"Hours through 2026-08-04"** (was a bare
  `Hours Refreshed Thru:` date), with a tooltip explaining that the Power BI report reads
  a separately-refreshed model and that Warranty/Service sit inside its Engineering and
  Shop figures.
* The refresh completion toast states the vintage: *"Hours are complete through
  2026-08-04."* — `RefreshOutcome.hoursThrough`, read back from the freshness row the
  `hours_actual` step already writes rather than threaded up as a second copy.

**A note for the next person comparing these two systems:** Power BI buckets by FUNCTION
regardless of phase (`[Engineering Hours]` = functions 211/311/312/313/515-518 anywhere,
`[Shop Hours]` = 411/412, `[Manufacturing Hours]` = 414, `[PM Hours]` = 111). The ETC grid
buckets by a fixed MachineSec-Function pair over 9 engineering and 4 shop codes. The two
agree on every phase the grid models and differ on Warranty and Service. That is a
definition difference, not a defect, and it will reappear as one every time somebody puts
the two reports side by side.

## What is not done

Stated plainly rather than left to be discovered:

* **§42.29 responsive testing** — no breakpoint or zoom testing was performed. The KPI strip's
  existing `auto-fit / minmax(175px, 1fr)` grid already handles reflow and was designed for
  80–200% zoom, but the new `UndefinedHoursPanel` has **not** been checked at tablet portrait,
  narrow width, or 150–200% zoom.
* **§42.21, §42.24, §42.26** — the broader table/header/totals visual pass. Group and column
  header consistency, cell padding, frozen-column boundary, doubled borders and the bottom
  totals row were **not** revised. Only the drill-through and cell states were.
* **§42.15 progress detail** — the new `Undefined hours` stage appears in refresh progress and
  the "N of M" count updates automatically (7→8), and step details now carry the file name,
  size, modified time and row counts. The richer per-stage panel §42.15 describes
  (records added/updated/removed as distinct live figures) was not built.
* **§42.32 visual regression tests** — none added; there is no visual-regression harness in
  this repo.
* **Full-pass verification** — `refreshAllData` was verified through the hours path only. A
  complete pass hung for >10 minutes on the TotalETO or Scheduler step; both are external and
  unrelated to §42, but that hang is **unexplained and worth investigating separately**.

## Operational notes

* The ETC app must be stopped before `prisma generate` (EPERM on the client files). If it
  fails after stopping, remove `node_modules/.prisma/client` and retry.
* `HOURS_SOURCE=power_bi` reverts to the previous source. There is deliberately **no automatic
  fallback**: the model runs days behind the file, so falling back would overwrite fresh
  figures with stale ones — the "mixed old and new metrics" §42.19 forbids.
