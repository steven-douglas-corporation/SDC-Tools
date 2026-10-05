# Actual hours: how Power BI, the reports app and the warehouse combine them

Three sources make up actual hours. They overlap, and each system has combined them
differently. This compares the three, measured on the warehouse's data on
2026-10-04, so differences between their totals can be explained rather than argued
about.

| Source | What it is | Covers |
|---|---|---|
| `Hours Through 20250131.xlsx` ("migration snapshot") | Lifetime hours per job × section-function, a crosstab; no employees, no dates | Everything up to 2025-01-31 |
| `Job_Hours_2025.xlsx` | Paylocity punches | 2025-01-06 → 2026-01-05 |
| `Current_Job_Hours.xlsx` | Paylocity punches, replaced daily | 2026-01-01 → today |

**The warehouse follows the reports app** (Jon, 2026-10-04). Both are summarised in the
last column below; Power BI is retired, and its rules are here for reconciliation.

## The differences

| # | Topic | Power BI (Job Hours Report model) | Reports app | Warehouse |
|---|---|---|---|---|
| 1 | **Where the snapshot comes from** | The Project Planner Data Control workbook on SharePoint (query `Hours Actual 20250131`, columns 28–44 of the quoted-hours sheet) | `Hours Through 20250131.xlsx`, stored per job and section (`actualHistoricalHours`) | `Hours Through 20250131.xlsx`, "All Job Data" sheet, unpivoted in `"Paylocity"."JobHoursSnapshot"` (911 rows, 185,401.35 h, 118 jobs). The "Old" sheet is a subset (all 348 values equal) and is not read |
| 2 | **January 2025 overlap** (the snapshot runs through 2025-01-31; punches start 2025-01-06) | **Flat cut-over:** every punch before 2025-02-01 is dropped, from both punch files | **Per job:** January 2025 punches are dropped only for jobs that have a non-zero snapshot (`actual-hours.ts`, `OUTSIDE_SNAPSHOT`) | Same as the app: those punches are kept but flagged `"SupersededBySnapshot"` and left out of totals (5,678.55 h on 38 jobs) |
| 3 | **January 2025 punches on jobs with no snapshot** | **Lost** (dropped by the cut-over, in no other source) | Kept, since they're the only record | Kept: 2,740.15 h on 12 job codes (979, 1050, 1066, 1083, 1090, overhead codes such as 99, 2024, 6000, and unnumbered). The app measured 799.14 h on 9 jobs because it only counts jobs in its own job list |
| 4 | **Small snapshot values** | Values under 1 hour dropped | Every non-zero value kept | Every non-zero value kept (19 values, 9.65 h, that Power BI drops) |
| 5 | **Function code remaps** | 315 → 518 and 512 → 412 | No remap: 315 is "Database & Device" and 512 stays 512 | Codes as delivered. Any remap belongs in the future `"Dimension"."Function"`, applied in one place |
| 6 | **Punch segments** (one person, one day, same job/section/function, several clock-ins) | Grouped into one row before loading | Kept as separate rows, summed at the storage grain | Every row kept. Totals are identical either way |
| 7 | **Job id format** | 3-digit ids padded to 4 (`907` → `0907`) | Leading zeros stripped (`0114` → `114`) | Both: `"JobCode"` as delivered, `"JobNumber"` stripped (the app's form) |
| 8 | **Job codes that aren't real jobs** ("Not Defined", "2025 SERVICE", ids not in the job list) | Kept: Power BI's job list is built from whatever appears in the hours | Rejected into Undefined Hours (named categories are resolved against the job list first) | Kept with their code; `"JobNumber"` is NULL for non-numeric codes. Resolution comes with `"Dimension"."Job"` (Total ETO) |
| 9 | **Who owns which dates** | Current file: ≥ 2025-02-01. 2025 file: 2025-02-01 → 2025-12-31 | 2025 file owns 2025; current file owns 2026 on (the 2025 file's January 2026 rows are dropped) | Same as the app (`"Paylocity"."JobHoursSource"`) |
| 10 | **Travel** | "Not Defined" → Concord, "TRAVEL" → Travel | Same rule (`normalizeTravel`) | Same rule (`"TravelLocation"`); the raw value is kept in `"TravelCode"` |
| 11 | **Snapshot rows' employee and date** | Employee 0, date 2025-01-31 | Job level only; no employee or date | Employee Unknown (-1), date 2025-01-31 |
| 12 | **Freshness** | Scheduled refresh; lagged the files by days (July 2026 was 150.53 h short when measured on 2026-08-05) | Reads the source hourly | Loads daily at 06:30; the app reads the warehouse |

## What that means for totals

On the same data (2026-10-04):

| | Hours |
|---|---|
| Snapshot | 185,401.35 |
| Punches, 2025 file (owned dates) | 100,742.50 |
| Punches, current file | 77,478.20 |
| Less January 2025 punches already in the snapshot | −5,678.55 |
| **Warehouse / reports app total** | **357,943.50** |

Power BI's total for the same period would differ from this by:
- **−2,740.15 h:** January 2025 punches on jobs without a snapshot (row 3)
- **−9.65 h:** snapshot values under 1 hour (row 4)
- **Whatever differs between its Planner-workbook snapshot and this file** (row 1). Not yet compared; a baseline query against the Power BI dataset would settle it.

The function-code remaps (row 5) move hours between codes but don't change totals.

## How to total hours in the warehouse

```sql
SELECT sum("Hours") FROM "Fact"."JobHours" WHERE NOT "SupersededBySnapshot";
```

A plain `sum("Hours")` double-counts the 5,678.55 h of January 2025 punches that the
snapshot already contains. The measure catalog (ROADMAP Phase 4) will encode this so no
one has to remember it.

## Open checks

- The app counts 5,618.35 h on 37 jobs as superseded; the warehouse counts 5,678.55 h on
  38. That's likely one job the warehouse matches by number that isn't in the app's job
  list. Confirm which one.
- Compare Power BI's `Historical Import 20250131` rows to the warehouse snapshot, job by
  job, before Power BI is deleted.
