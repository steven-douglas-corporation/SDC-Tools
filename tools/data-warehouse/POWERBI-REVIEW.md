# Power BI model review: candidates for redesign

First pass, 2026-10-04. A review of the "Job Hours Report - Management Level" semantic
model (`docs/reference/powerbi/…SemanticModel`) as input to the warehouse's dimensional
design (ROADMAP Phase 3). It inventories what's there, where each table's data comes
from, and what to change. It is not yet the new design; that's the next step, and the
open questions at the end need answers first.

## At a glance

- **28 real tables plus 20 auto-generated date tables.** Auto date/time was on, so Power
  BI made a hidden date table for every date column.
- **169 measures, none with a description.** 142 of them sit in a single `Measure Tables` table.
- **134 calculated columns:** business logic written in DAX inside tables.
- **48 relationships:** 19 to the auto date tables, 1 bidirectional (`Job Sales` → `Job`).
- **Five source systems:**

| Source | How Power BI reached it | Tables fed |
|---|---|---|
| Paylocity | Excel exports copied to SharePoint (`Current_Job_Hours`, `Paid_Expenses___DSB`) | `Hours Actual`, `Travel Expenses`, and indirectly `Job`, `Date`, `Employee from Hours Actual` |
| **Project Planner Data Control** workbook (hand-maintained Excel on SharePoint) | Excel on SharePoint | `Employee`, `Controls`, `Function Hierarchy` (import), quoted and ME estimated hours (`Hours Estimated`, `Cost Estimated`, `Job`, `ME Estimate to Complete Function`), `Function Department` |
| Total ETO (SQL Server `SDC`) | Direct SQL queries | `Assembly`, `Part Purchase` |
| Fabric warehouse (being retired) | SQL endpoint | `Estimated to Complete Period`, `Standard Fees`, hours and costs ETC history |
| **Sage** (accounting) | `Job Ledger Report For PBI` Excel on SharePoint | `Sage Part Cost` |
| Job Sales workbook | Excel on SharePoint | `Job Sales` |

Since 2026-10-04 the SharePoint copies are frozen (the Power Automate flow is off), so
every SharePoint-fed table above is now stale. That includes the Planner workbook, if
the same flow fed it; to confirm.

## Table inventory

| Table | Cols | Calc cols | Measures | Source | Role today | Redesign candidate |
|---|---|---|---|---|---|---|
| `Hours Actual` | 16 | 4 | — | Paylocity (3 files merged in Power Query) | Fact | **Done:** `"Fact"."JobHours"`. Move the 4 calculated columns into SQL |
| `Hours Estimated` | 6 | — | — | Planner workbook + Fabric | Fact (quoted, ETC and ME ETC mixed in one table) | Split into facts with one grain each: `"Fact"."QuotedHours"` (budget) and `"Fact"."EstimateToComplete"` (monthly snapshot) |
| `Hours Estimated to Complete History` | 7 | — | — | Fabric | Periodic snapshot | `"Fact"."EstimateToComplete"`. **Migrate before Fabric shuts off** |
| `Costs Estimated to Complete History` | 6 | — | — | Fabric | Periodic snapshot | Same fact as hours ETC (a cost measure beside an hours measure), or its own fact if the grains differ |
| `Cost Estimated` | 4 | — | — | Planner + Fabric | Fact | Fold into the quoted and ETC facts |
| `Estimated to Complete Period` | 8 | — | — | Fabric | Dimension | `"Dimension"."EtcPeriod"`, or month attributes on `"Dimension"."Date"` |
| `Standard Fees` | 13 | — | — | Fabric | Rates by ETC period | A reference table with effective dates (a temporal settings table) |
| `Travel Expenses` | 16 | — | — | Paylocity expenses | Fact | `"Fact"."Expense"` from `"Paylocity"."PaidExpense"` (staging already combines the daily files) |
| `Part Purchase` | 18 | 1 | — | Total ETO | Fact | `"Fact"."PartPurchase"` |
| `Sage Part Cost` | 4 | — | — | Sage ledger via Excel | Fact | `"Fact"."JobLedger"` (or part cost) from a Sage extract: a new source |
| `Job Sales` | 4 | — | — | Excel | Fact | `"Fact"."JobSales"`; remove the bidirectional relationship |
| `Job Employee Hours` | 6 | — | — | DAX calculated table | Aggregate of hours | An aggregate view over `"Fact"."JobHours"`, not a stored table |
| `Assembly` | 54 | 3 | 15 | Total ETO | Dimension + measures | `"Dimension"."Assembly"` (or Bill of Materials fact). 54 columns: review which matter |
| `Job` | 21 | **8** | — | Built from the Planner workbook + jobs seen in hours | Dimension | **`"Dimension"."Job"` from Total ETO's job master**, enriched from Scheduler and ETC Planner. Today it's a job list assembled from whatever appears in the files |
| `Employee` | 13 | 1 | — | Planner workbook | Dimension | **Done:** `"Dimension"."Employee"` from Paylocity. Add the Planner-only attributes (department, team, billing group) from their real owner, probably the reports app |
| `Function Hierarchy` | 23 | 2 | — | Planner workbook, plus "invalids" detected from hours | Dimension (section → function → department → billing group) | `"Dimension"."Function"` from a governed reference table. The reports app already encodes these rules (`sections.ts`, `paylocity-standard-rules.ts`); pick one owner |
| `ME Estimate to Complete Function` | 4 | — | — | Planner workbook | Bridge on a text key | Fold into `"Dimension"."Function"` / the ETC fact |
| `Date` | 37 | 4 | — | Range of dates in `Hours Actual` | Dimension | **Done:** `"Dimension"."Date"` (fixed 2015–2035, not tied to one fact's range) |
| `LocalDateTable_*` ×20 | 7 each | — | — | Auto date/time | Hidden date tables | **Remove.** One date dimension, related explicitly |
| `Measure Tables` | 0 | — | **142** | Empty placeholder | Holds measures | **The measure catalog** (ROADMAP Phase 4), with subject areas and descriptions |
| `Hours Type Selector` | 3 | — | 8 | DAX | Slicer to switch measures | Presentation; belongs in the report, not the warehouse |
| `Display Costs Header` | 1 | — | — | DAX | Label | Presentation |
| `Profitability - Engineering Rate`, `- Shop Rate`, `- Project Management %`, `- Manufacturing %` | 1 each | — | 1 each | DAX what-if parameters | Rates typed into the model | Reference table of rates with effective dates, owned by Finance |
| `Controls` | 3 | — | — | Planner workbook | Hidden settings | Find out what it controls; likely a reference table |
| `Meta` | 2 | — | — | Refresh time | Last refreshed | `"Integration"."Batch"` |

## Patterns to change

1. **Master data from a hand-kept workbook.** Employees, the function hierarchy and quoted
   hours come from "Project Planner Data Control". Each needs a real owner:
   Paylocity for people (done), Total ETO for jobs, a governed reference table for the
   hierarchy, and the ETC Planner / Scheduler for quotes.
2. **A job list derived from the facts.** `Job` is assembled from jobs that appear in hours
   and the planner, so a job with no hours yet doesn't exist, and a typo in a file
   creates a "job". Conform jobs to Total ETO's job master.
3. **Text composite keys.** Relationships run on built strings (`Section-Function Code`,
   `Job Section Function Code`); one column is even misspelled (`Section-Funtion Code`
   in `Travel Expenses`). Use integer surrogate keys in the warehouse; keep the codes as
   attributes.
4. **One fact table, several grains.** `Hours Estimated` mixes quoted hours, ETC and ME ETC.
   One fact table per business process, one grain each (Kimball's first rule).
5. **One column related to two tables.** `ETC Period Key` relates to both `Estimated to Complete
   Period` and `Date.'Year Month Id'`. Pick one month dimension (or one role each, clearly named).
6. **Logic in calculated columns.** 134 DAX columns hold business rules (e.g. valid-punch
   reasons). Move them into SQL in staging or the fact load, where they're tested and
   shared, not locked in one report.
7. **Settings typed into the model.** Rates, percentages and fees live in what-if parameters
   and a Fabric table. Make them reference tables with effective dates, so a rate change is
   data, not a report edit, and history is kept.
8. **Presentation tables in the model.** Selector and label tables belong to the report
   layer, not the warehouse.
9. **Auto date/time.** 20 hidden date tables. One date dimension (done).

## First sketch of the target model

| Business process (fact) | Grain | Dimensions |
|---|---|---|
| `"Fact"."JobHours"` (done) | One Paylocity punch | Date, Employee, Job*, Function* |
| `"Fact"."QuotedHours"` | Job × function, per quote version | Job, Function, Date (quote date) |
| `"Fact"."EstimateToComplete"` | Job × function × ETC month (snapshot) | Job, Function, EtcPeriod / Date |
| `"Fact"."Expense"` | One paid expense line | Date, Employee, Job, Function |
| `"Fact"."PartPurchase"` | One purchase line | Date (invoiced), Job, Part |
| `"Fact"."JobLedger"` (Sage) | One ledger line | Date, Job, Account |
| `"Fact"."JobSales"` | Job × date | Job, Date |

*Job and Function are still to be built; `"Fact"."JobHours"` keeps the Paylocity codes until then.

Conformed dimensions: `Date` (done), `Employee` (done), `Job`, `Function`, `Part`, `EtcPeriod`.
Reference tables with effective dates: rates and percentages (profitability), standard fees.

## Open questions

1. **Project Planner Data Control:** who maintains it, does anything still update it,
   and which system should own each part (people, hierarchy, quotes)?
2. **Sage:** is the Job Ledger export the only Sage feed, and can it come from Sage directly
   rather than a hand-made Excel file?
3. **Job Sales:** where does that workbook come from?
4. **Function hierarchy:** one owner. Either the warehouse reference table (the reports
   app reads it) or the reports app (the warehouse reads it).
5. **Quotes and ETC:** are the ETC Planner and Scheduler (MySQL) now the systems of record
   for quoted hours and monthly ETC, replacing the workbook and Fabric?
6. **Which of the 169 measures are actually used** on the report's 35 pages? Unused ones
   don't need porting. The `.Report` folder can answer this by listing each visual's fields.
