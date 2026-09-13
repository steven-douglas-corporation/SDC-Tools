# Department / Employee Utilization

The Dashboard's utilization section is a native rebuild of two Power BI visuals
from **Job Hours Report - Management Level**, page **Project Portfolio**:

| Power BI visual | Rebuilt as |
| --- | --- |
| `Department Utilization` (pivotTable `88e631265e4626124701`) | the department table |
| `Employee Utilization, Bottom 10` (tableEx `2f32239eaa36dfe26b59`) | the ranked employee list |

Power BI was read **once**, to recover the business rules. Nothing on this path
talks to it at runtime — hours come from Paylocity punches in `JobHoursDetail`,
per the standing rule in `lib/hours-feed.ts`.

- Rules and measures: `src/lib/department-utilization.ts`
- Rule table tests: `tests/department-utilization.test.ts`
- UI: `src/components/dashboard/UtilizationPanel.tsx`
- Wired into the Dashboard's single data pass in `src/lib/dashboard-overview.ts`

## The measures

All fifteen come from `Measure Tables.tmdl` in the report's semantic model. The
`Property` names below are the real measure names (the visual renames several of
them for display — e.g. `Hours Actual` shows as "Total Hours").

| Column | Measure | Rule |
| --- | --- | --- |
| Employees | `Employees` | headcount in the row's scope |
| Theoretical | `Theoretical Total Hours` | `Employees × Working Days × 8` |
| Actual | `Hours Actual` | every hour booked |
| Available % | `Available Hours %` | `Hours Actual ÷ Theoretical Total Hours` |
| Utilization % | `Utilization %` | `Hours Actual Billable ÷ Hours Actual` |
| Billable | `Hours Actual Billable` | see the billable rule below |
| Active | `Hours Actual Billable Active` | billable and not 70/80/90 |
| Warranty | `Hours Actual Billable Warranty` | section 70 |
| Service | `Hours Actual Billable Service` | section 80 |
| Spare Parts | `Hours Actual Billable Spare Parts` | section 90 |
| Bellco | `Hours Actual Billable Bellco` | job 6000 |
| Non-Billable | `Hours Actual Non-Billable` | overhead jobs, 98, post-close non-70/80/90 |
| Travel | `Hours Actual Travel` | punch hours whose Travel column is `Travel` |
| Travel % | `Hours Actual Travel %` | `Travel ÷ Hours Actual` |
| Overtime | `Overtime Hours` | per employee per day, the hours above 8 |

**Working Days** is `COUNTROWS('Date')` where `Is Weekend = FALSE()` — a plain
non-weekend count that **ignores holidays**. This is why the section uses
`etc.ts`'s `workingDaysInMonth()` and not `workforce-capacity-policy.ts`. See
"Two theoretical-hours figures" below.

### The billable rule

One punch, one bucket (`classifyUtilizationPunch`):

1. Job `6000` → **Bellco**.
2. Job `4000` / `1083` / `7000` / `10000` → **Non-Billable**.
3. Section `98` (Invalid) → **Non-Billable**.
4. Booked *after* the job's effective close date and not section 70/80/90 →
   **Non-Billable**.
5. Section `70` → Warranty, `80` → Service, `90` → Spare Parts, else
   **Billable Active**. All four are billable.

In the report these are seven independent `CALCULATE` filters that happen to
partition the data; here they are one function, so
`Billable + Non-Billable + Bellco = Actual` holds by construction and is asserted
in the tests.

**Effective close date** (`Job[Effective Close Date]`, a calculated column):
blank unless the job is Complete; then its `completeDate`; then, if Complete with
no date recorded, its last valid punch as a proxy. Because it is a calculated
column, the proxy is computed over the job's *whole* punch history and does not
move when you change the month on the Dashboard.

## Verified against the report — July 2026

The screenshot the section was specified from is July 2026 (`23 Working Days`,
`Hours Refreshed Thru 7/31/2026`). Comparing the report's total row against this
implementation:

| Measure | Power BI | This app | |
| --- | --- | --- | --- |
| Spare Parts | 7 | 7 | exact |
| Bellco | 35 | 35 | exact |
| Theoretical | 8,280 = 45 × 23 × 8 | 9,568 = 52 × 23 × 8 | formula confirmed, headcount differs |
| Travel % | 6% | 6.6% company-wide | see below |
| Employees | 45 | 52 | population differs |
| Actual hours | 6,454 | 6,672 | population differs |
| Utilization % | 98% | 96% | follows the above |

Spare Parts and Bellco matching exactly, and the theoretical formula reproducing
`Employees × 23 × 8` on the nose, are what establish that the *rules* are right.
The remaining gaps are all one thing: **the two systems use different employee
master data**, described next.

## Intentional differences

### 1. The employee dimension is a different sheet

Power BI's `Employee` table is loaded from SharePoint —
`Project Planner Data Control.xlsx`, sheet `Employees`. This app's employee
records come from `Employee_Department_Map.xlsx`. The two sheets disagree about
who sits in which department, and the app does not read the SharePoint one.

The report's visual filters five literal department names:

> Mechanical Engineering, Controls Engineering, Machine Building, Machine Wiring, Manufacturing

Only the first two exist in this app's vocabulary. A literal port of that filter
would have silently dropped most of the Shop, so the section instead uses the
app's own standardized mapping (`resolveEmployeeGroup` →
`workforceGroupForCardKey`, the Employees tab's chain) scoped to the team codes
that mean the same five departments:

```ts
UTILIZATION_TEAM_CODES = ["mech", "controls", "build", "wire", "mfgops"]
```

That is Engineering minus Service, plus all of Shop. **Service Engineering and
PM stay out of scope** — they render as rows with their hours, but carry no
Utilization %, because the report's five departments exclude them.

Two specific disagreements are visible in the July numbers, and neither can be
settled from this side:

- The report's Engineering hours (~3,722) match this app's
  `Controls + Mechanical + Service Engineering` (3,730) almost exactly, which
  suggests the SharePoint sheet files this app's Service Engineering people under
  Controls/Mechanical Engineering. Company-wide Travel % (6.6%) likewise matches
  the report's 6% far better than the in-scope-only figure (3.2%) does.
- The report's Shop headcount (18) is well below this app's
  `build + wire + mfgops` (26), which suggests the SharePoint sheet files much of
  this app's "Manufacturing Operations" outside the five departments.

**If the business decides the SharePoint classification is authoritative**, the
fix is one line — `UTILIZATION_TEAM_CODES` — plus correcting the affected people
in `Employee_Department_Map.xlsx`. It is deliberately a single named constant for
that reason. Until then the app's own mapping is authoritative here, and the two
reports will differ on population.

### 2. Leavers who worked in the month are counted

The population is "active today **OR** booked hours in this month", not
`active: true`. Filtering on today's active flag dropped 670 hours out of July
2026 alone, and dropped them silently — `Billable + Non-Billable` stopped footing
to the month's actual hours. Somebody who worked in July and left in August was
on the payroll in July; their hours and their theoretical hours both count. They
are marked `LEFT` in the expanded employee rows.

### 3. Two theoretical-hours figures on one page, on purpose

The Dashboard's **workforce capacity cards** use
`workforce-capacity-policy.ts` — weekdays minus published holidays minus prorated
vacation and sick. The **utilization table** uses the report's holiday-agnostic
`Working Days × 8`.

These are different numbers answering different questions and must not be
reconciled into one. `workforce-capacity-policy.ts`'s own header says so, and
predates this section.

## The Travel column

Power BI reads a `Travel` column straight off the Paylocity export and normalizes
it in Power Query: `"Not Defined"` → `"Concord"`, then `"TRAVEL"` → `"Travel"`.
Only the literal `"Travel"` counts as travel hours.

This app read that column and **discarded it** until 2026-08-28
(`paylocity-workbook.ts` called it a value that "reaches no figure in this app").
It is now stored as `JobHoursDetail.travelHours`.

**It is stored as hours, not as a label.** Power BI keeps Travel inside its
group-by grain; this table's grain is `(job, section, date, employee)` and its
unique key says so, so a day split between a travel site and Concord collapses to
one row here. Storing the travel *portion* of the row's hours sidesteps the
mismatch — `SUM(travelHours)` equals the report's `Hours Actual Travel` whatever
the grain does.

`NULL` means "not known" (an export saved without the column) and renders as a
dash; `0` is a measured zero. Backfilled by
`scripts/backfill-travel-hours.ts`, which is idempotent and simply re-runs the
normal feed → `syncActualHours` path.

> **Adding a column to `JobHoursDetail`?** `digestBucket()` in `sync-actuals.ts`
> lists its fields explicitly rather than hashing the payload, so a new column
> must be added there too. Otherwise every bucket's digest is unchanged, every
> write is skipped, and the column silently keeps its default forever — which is
> exactly what happened on the first travel backfill attempt (0 rows written).

## Month behaviour

The section is driven by the Dashboard's existing month selector
(`DashboardMonthSelect` → `dashboardMonth()`), through `getDashboardOverview`.
There is no second month state and no per-card fetch.
