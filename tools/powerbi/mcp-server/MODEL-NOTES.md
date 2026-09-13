# Job Hours Report — semantic model notes

Working reference for writing DAX against the **Job Hours Report - Management Level**
model (queried live via the `powerbi` MCP server). Measure DAX expressions are **not**
available over the query API — read the model's `.tmdl` files in this repo for those.

_Last assessed: 2026-06-02. Row counts are point-in-time; re-check if the model changed._

## At a glance

- **Grain / shape:** star schema centered on the **`Job`** dimension (239 jobs).
- **Date coverage:** `Date` runs 2024-10-01 → 2026-06-05.
- **Main facts:** `Hours Actual` (27,895 rows) is the labor-hours fact; `Part Purchase`
  (28,691 rows) is the parts/PO fact. `Job Employee Hours` is a much smaller (988-row)
  summarized fact — don't assume it's the full hours detail.
- **Measure home:** most reportable measures live on the **`Measure Tables`** table.

## Dimensions

| Table | Key | Notes |
|---|---|---|
| `Job` | `Job Id` (text, e.g. "1058") | Central dimension. Cols incl. `Job Name`, `Job Customer`, `Job Type`, `Job Status`, `Is Overrun`, `Is Estimated Job`, `Is Active Job`. |
| `Employee` | `Employee Id` | 115 employees. |
| `Date` | `Date` / `Date Id` / `Year Month Id` | Marked date table. Role-playing: many fact date columns join here or to auto LocalDateTables. |
| `Function Hierarchy` | `Section-Function Code` | **Has an `Is Total` rollup flag — see Gotchas.** Joins to facts as many-to-many. |
| `Estimated to Complete Period` | `ETC Period Key` | Dimension for the ETC history facts. |
| `Hours Type Selector` | — | Disconnected; drives the "Dynamic Hours …" measures (field-parameter style). |
| `Profitability - *` (4 tables) | — | **What-if parameter** tables (Shop Rate, Engineering Rate, Manufacturing %, PM %), each with a `… Value` measure. Not data tables. |

## Facts (all relate to `Job` via `Job Id`, one-direction unless noted)

| Table | Grain | Key amount columns |
|---|---|---|
| `Hours Actual` | employee × job × date × function | hours; joins `Employee`, `Date`, `Function Hierarchy`, `ME Estimate to Complete Function` |
| `Hours Estimated` | job × function | estimated hours |
| `Job Employee Hours` | job × employee × date (summarized, 988 rows) | hours |
| `Part Purchase` | PO line (28,691 rows) | `Invoiced Amount`, `Total Price`, `Purchase Price`, `Quantity`, `Invoiced Quantity`; `Cost Type` (e.g. "Part Cost") |
| `Travel Expenses` | expense line | amounts; joins `Employee`, `Date`, `Function Hierarchy` |
| `Cost Estimated`, `Sage Part Cost` | job-level cost | |
| `Hours Estimated to Complete History`, `Costs Estimated to Complete History` | job × ETC period × function | ETC snapshots; join `Estimated to Complete Period` and `Date[Year Month Id]` |
| `Assembly` | BOM line (`ProjectID` → `Job`) | part cost/quantity hierarchy |
| `Job Sales` | job (1:1 **bidirectional** with `Job`) | sales |

## Key measures (on `Measure Tables` unless noted)

- **Hours:** `Hours Actual`, `Hours Quoted`, `Hours Estimated to Complete`, `Hours ETC Variance`, `Hours Quoted Variance`, `Overrun %`, plus many `Hours Actual …` cuts (Billable, ME, Travel, Cumulative).
- **Cost / profit:** `Total Job Cost`, `Total Labor Cost`, `Shop/Engineering/Project Management/Manufacturing Labor Cost`, `Job Profit/Loss`, `Job Profitability %`, `Sales Amount`, `Sales Total Amount`.
- **Parts:** `Part Invoiced Amount`, `Part Cost Invoiced Dynamic`, `Part Cost Quoted`, `Part Cost Estimated To Complete`, `Part Cost Left to Spend`.
- **People:** `Employees`, `Utilization %`, `Net Billable Hours`, `Working Days`.
- **Meta:** `Model Refresh Date Time`, `Hours Refreshed Thru` (on `Meta`).

## Gotchas (read before querying)

1. **`Function Hierarchy[Is Total]` doubles data.** 824 rows = 412 `TRUE` + 412 `FALSE`
   (a leaf member and a "total" member for each function). Any slice **by function**
   must filter `'Function Hierarchy'[Is Total] = FALSE` for leaf-level numbers, or
   `= TRUE` only when you explicitly want the grand-total member. **Never both** — it
   roughly doubles the result.

2. **`Job Profitability %` is not Profit ÷ Sales and clamps at 1 (100%).** Many jobs show
   exactly 100% because costs aren't booked yet, and `Job Profit/Loss` can even exceed
   `Sales Amount`. Don't rank by margin without filtering to jobs with real cost data
   (e.g. `Job Status = "Complete"` or `Job Profitability % < 1`). For "most profitable",
   prefer ranking by **`Job Profit/Loss`** (dollars).

3. **`Part Purchase` has unmatched Job IDs.** 2,340 of 28,691 PO lines have a `Job ID`
   not present in the `Job` dimension. In a `SUMMARIZECOLUMNS('Job'[Job Id], …)` these
   surface as a **blank Job** row (≈$623K invoiced). They are unmatched referential
   integrity, **not** null `Job ID` values, so `ISBLANK('Part Purchase'[Job ID])` finds none.

4. **Column naming is inconsistent across tables.** `Job` uses `Job Id`; `Part Purchase`
   uses `Job ID` (capital D). `Travel Expenses` even has `Section-Funtion Code` (typo) vs
   `Function Hierarchy[Section-Function Code]`. Copy exact names from `INFO.VIEW.COLUMNS()`.

5. **Auto date tables are everywhere.** Dozens of hidden `LocalDateTable_*` /
   `DateTableTemplate_*` exist for every date column. `list_tables` already filters them;
   ignore them in analysis and use the real `Date` table.

6. **Measure DAX isn't queryable.** `INFO.MEASURES()` is blocked over REST and
   `INFO.VIEW.MEASURES()` returns a null `Expression`. To see a measure's definition,
   read the `.tmdl` files in `Job Hours Report - Management Level/`.

## Handy metadata queries (these work over the REST endpoint)

```dax
// List a table's columns (exact names + types)
EVALUATE SELECTCOLUMNS(FILTER(INFO.VIEW.COLUMNS(), [Table] = "Part Purchase"),
    "Column", [Name], "DataType", [DataType])

// All relationships
EVALUATE SELECTCOLUMNS(INFO.VIEW.RELATIONSHIPS(),
    "Relationship", [Relationship], "Active", [IsActive])

// Find columns by name fragment across the model
EVALUATE SELECTCOLUMNS(FILTER(INFO.VIEW.COLUMNS(), CONTAINSSTRING([Name], "Total")),
    "Table", [Table], "Column", [Name])
```
