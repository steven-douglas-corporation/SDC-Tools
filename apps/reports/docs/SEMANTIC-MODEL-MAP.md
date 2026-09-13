# Semantic model → app map

Which tables exist in the **`Job Hours Report - Management Level`** semantic model
(workspace `SDC Reports`), what the ETC app reads from each, and what it ignores.

Captured **2026-07-30** by querying the live model with the Power BI service
principal (`runDax` / `executeQueries`). Row counts are real, not estimates.

**Yes, the model is reachable live.** All 20 tables below answered a query. The
auth path is app-only client credentials (`PBI_*` env vars) — no user session, no
DPAPI cache, so it works from PM2 and after a reboot. Two caveats found while
doing this:

- `INFO.TABLES()` / `INFO.COLUMNS()` are **blocked** over `executeQueries`
  (`DatasetExecuteQueriesError`), so schema introspection has to be done by
  probing each table (`EVALUATE TOPN(1, 'T')`) rather than reading the catalog.
- **`'Hours Actual'` has a broken calculated column.** `EVALUATE 'Hours Actual'`
  fails outright with *"referenced calculated column
  'Hours Actual'[Hours Actual Est to Date] … does not hold any data because there
  is an error in its expression"*. The table is fine if you name the columns you
  want with `SELECTCOLUMNS`; a bare `EVALUATE` of it cannot work until that
  column is fixed in the model. Worth telling whoever owns the model.

---

## Tables the app reads today

| table | rows | what the app takes | where |
|---|---:|---|---|
| **Hours Estimated** | 3,704 | whole table (`EVALUATE 'Hours Estimated'`) → quoted hours per job/section | `sync-actuals.ts` (`syncQuotedFromPowerBi`) |
| **Cost Estimated** | 213 | whole table → `Cost Quoted` → `Job.costQuoted`; `[Part Cost Estimated To Complete]` measure for reconciliation | `sync-actuals.ts`, `parts-budget-projection.ts` |
| **Estimated to Complete Period** | 10 | whole table → ETC period keys/names/dates, the spine of the history backfill | `sync-etc-history.ts`, `sync-actuals.ts` |
| **Standard Fees** | 32 | `Previous Month Pulled Hours`, `Hours Available`, `Hours Worked this Month`, `Hours being pulled this month`, `New ETC Hours`, `Standard Fee`, `Rate`, `Department`, `Billing Group` → CategoryPool | `sync-actuals.ts`, `sync-etc-history.ts`, `etc.ts` |
| **Job** | 250 | `Job Id` as the grain/filter on the history and parts queries | `sync-etc-history.ts`, `parts-budget-projection.ts` |
| **Function Hierarchy** | 826 | `Section-Function Code` to map model rows onto the app's 17 section codes | `sync-etc-history.ts` |
| **Date** | 669 | date filters on history queries | `etc.ts` |
| **Part Purchase** | 31,140 | referenced in DAX for the reconciliation measures only — the app's own parts lines come from TotalETO | `parts-budget-projection.ts` |

That's **8 of 20**. Everything the app pulls from Power BI is quoted hours,
quoted cost, ETC history, and the Standard Fees pools.

---

## Tables the app does NOT read

| table | rows | contents | worth a look? |
|---|---:|---|---|
| **Hours Actual** | 31,010 | `Employee Id`, `Function Id`, `Date`, `Hours Actual`, `Data Source`. 2025-01-31 → 2026-07-31, 95 employees, 428,129 hrs. `Paylocity Hours` (30,108 rows) + `Historical Import 20250131` (902) | **Yes — see below** |
| **Job Employee Hours** | 1,035 | `Employee Name`, `Job`, `Date`, `Job Employee Hours` — per-employee-per-job hours | Maybe: the app has no per-employee hours view at all |
| **Hours Estimated to Complete History** | 5,317 | `ETC Period Key`, `Job Id`, `Function Hierarchy Id`, `Hours Estimated to Complete`, `User`, `Created Date Time`, `Is Active` | The raw rows behind the `[ETC Historical …]` measures the backfill already uses |
| **Costs Estimated to Complete History** | 409 | same shape, costs | ditto, for parts |
| **Assembly** | 37,341 | 54 cols — BOM hierarchy, `Level0..10_Part`, `HierarchySortKey`, `Unit Cost`, `Extended Cost`, `ProjectID` | **No** — see the correction below |
| **Employee** | 116 | `Employee Id`, names, `Job Title`, `Supervisor's Employee ID`, `Employee Department`, `Employee Billing Group`, `Is Active` | Possibly: this is a third roster, next to ETC's own and the Scheduler's |
| **Travel Expenses** | 465 | `Expense Amount`, `Job Id`, `Section Id`, `Function Id`, submitted/approved/paid dates, report status | Not modelled in the app at all — job cost currently ignores travel |
| **Job Sales** | 59 | `Sale Amount`, `Change Order Amount`, `Sage Cost` | Not modelled — no revenue side in the app |
| **Sage Part Cost** | 46 | `Debit Amount`, `Credit Amount`, `Net DR/CR` per job | Accounting reconciliation |
| **Meta** | 1 | `Hours Refreshed Thru`, `Model Refresh Date Time` | The app computes its own freshness from the SharePoint export instead |
| **Hours Type Selector** | 2 | field parameter (Quoted / ETC) | Report-only construct |
| **Part Purchase Date** | 2 | field parameter | Report-only construct |

`Measure Tables` holds only measures and can't be queried as a table. A
`ME Estimate to Complete` and a profitability parameter appear in the model
diagram but resolve under neither that name nor the obvious variants — they've
likely been renamed.

---

## Correction: the BOM report does not use this model

I previously wrote (in `POWERBI-CONTINUITY.md`) that losing the semantic model
would stop the BOM cost report. **That was wrong.** `job-bom.ts` imports `mssql`
and queries TotalETO directly — `tblSpec`, `tblEngTop`,
`tblPurchaseOrderDetails`, `tblReceiverLog`. It contains no `runDax` call at all.
The model's `Assembly` table is a parallel copy the app never touches.

So the real blast radius of losing the model is smaller again: quoted hours,
quoted cost, the Standard Fees pools, and the ETC history backfill. Not the BOM.

---

## The finding worth acting on: `Hours Actual`

The SharePoint hours sync has been down since **2026-07-29 19:56** (see
[GRAPH-APP-ONLY-SETUP.md](GRAPH-APP-ONLY-SETUP.md)). `Hours Actual` in this model
is **the same Paylocity feed**, arriving by a different road, and it is reachable
right now by an auth path that works.

It also joins to job and section through the model's relationships, which is
exactly the grain `syncActualHours` needs:

```dax
EVALUATE
SUMMARIZECOLUMNS(
  'Job'[Job Id], 'Function Hierarchy'[Section-Function Code],
  FILTER(ALL('Date'[Date]), 'Date'[Date] >= DATE(2026,7,1) && 'Date'[Date] < DATE(2026,8,1)),
  "Hours", SUM('Hours Actual'[Hours Actual])
)
```

Verified July 2026 output: 1143/10-412 = 268 hrs, 1150/10-414 = 277,
1130/10-411 = 178. Some hours land under `Job Id = "NOT DEFINED"` (152 hrs on
10-400, 157 on 10-414 in July) — the mis-coded-Paylocity case that
`JobMonthlyActualHours.overridden` exists for.

For comparison, the app currently holds 1,153 rows in `JobMonthlyActualHours`,
max month 2026-07, 4,674 hrs for July — frozen since the sync broke.

**Trade-off:** the model is only as fresh as its scheduled refresh (last:
2026-07-30 06:02), where the SharePoint file is live. Staler by hours, not days —
and "hours stale" beats "not updating at all". This is a viable fallback path
while the `Sites.Selected` consent is pending, and a permanent second source
afterwards.

*(An earlier version of this note framed the fallback as urgent because of a
Power BI trial expiry. That was mistaken — the trial is not expiring.)*

---

## Reproducing this

`INFO.*` being blocked means there's no one-shot catalog dump. To re-probe:

```bash
npx tsx --env-file=.env scripts/check-powerbi-auth.ts
```

confirms the connection, then per table:

```dax
EVALUATE ROW("n", COUNTROWS('Table Name'))   -- row count
EVALUATE TOPN(1, 'Table Name')               -- column names, from the row keys
```

Note the `Hours Actual` caveat above — that one needs explicit `SELECTCOLUMNS`.
