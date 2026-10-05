# Projects Grid — Columns and Calculations

What every column on the **Projects** page (sidebar → Planning → Projects, route `/quoted`)
shows, where its data comes from, and how any computed figure is calculated. Every claim
links to the code that implements it. This describes existing behavior only.

Main file: [src/app/(app)/quoted/page.tsx](../src/app/(app)/quoted/page.tsx) (the
`ProjectsView` component; the route entry point is at
[page.tsx:1268](../src/app/(app)/quoted/page.tsx#L1268)).

---

## 1. Which rows appear

One row per `Job`, loaded by a single query at
[page.tsx:452-468](../src/app/(app)/quoted/page.tsx#L452-L468), with each job's
`EstimatedHours` rows included (those hold the quoted hours).

| Filter | Default when no filter is chosen | Code |
|---|---|---|
| Type | All five valid types: Custom, Duplicate, Hybrid, Service, T&M | [page.tsx:395](../src/app/(app)/quoted/page.tsx#L395), [job-filters.ts:11](../src/lib/job-filters.ts#L11) |
| Customer | All, **including jobs with no customer** | [page.tsx:423-426](../src/app/(app)/quoted/page.tsx#L423-L426) |
| Status | Active + HeadStart | [page.tsx:400-403](../src/app/(app)/quoted/page.tsx#L400-L403), [job-filters.ts:48](../src/lib/job-filters.ts#L48) |
| Billable | Billable only | [page.tsx:404-416](../src/app/(app)/quoted/page.tsx#L404-L416) |
| Dates ▾ | No range. When set, filters on Start Date or Complete Date; the `to` date is inclusive of the whole day, and jobs with no date in that column are excluded | [page.tsx:434-450](../src/app/(app)/quoted/page.tsx#L434-L450) |

**Sort order:** Job Id ascending by default. Job Id is sorted numerically, so 979 comes
before 1020 ([page.tsx:469-472](../src/app/(app)/quoted/page.tsx#L469-L472),
[job-filters.ts:129](../src/lib/job-filters.ts#L129)). After any sort, SDC's own internal
projects are always moved to the bottom
([page.tsx:480](../src/app/(app)/quoted/page.tsx#L480)).

---

## 2. Identity and info columns

These show stored `Job` fields as they are, with no calculation. In Edit Mode they are
editable inputs; edits are saved by `saveQuotedHours` →
`saveJobFields` ([quoted-actions.ts:100](../src/lib/quoted-actions.ts#L100)).

| Column | Shows | Where the value comes from | Code |
|---|---|---|---|
| **#** | Row number on screen (1, 2, 3…) | Position in the sorted list, not stored | [page.tsx:919-921](../src/app/(app)/quoted/page.tsx#L919-L921) |
| **Job Id** | `Job.jobId`, linked to Job Hour Details | Stored. The text color shows schedule state (below) | [page.tsx:929-945](../src/app/(app)/quoted/page.tsx#L929-L945) |
| **Job** | `Job.jobName` | Stored, manager-edited | [page.tsx:946-972](../src/app/(app)/quoted/page.tsx#L946-L972) |
| **Customer** | `Job.customer` | Synced from TotalETO (`vwProjects.CName`) unless a manager has edited it here (`customerManuallyEdited`) | [page.tsx:974-990](../src/app/(app)/quoted/page.tsx#L974-L990), [sync-totaleto.ts:1242](../src/lib/sync-totaleto.ts#L1242) |
| **Type** | `Job.type` | Stored, manager-edited. Limited to the five valid types | [page.tsx:992-1012](../src/app/(app)/quoted/page.tsx#L992-L1012) |
| **Billable** | `Job.billable` | Stored, manager-edited. **Exception:** a job whose customer is "SDC" or starts with "Steven Douglas" always shows Non-Billable, and saving forces it to false | [page.tsx:1014-1036](../src/app/(app)/quoted/page.tsx#L1014-L1036), [job-filters.ts:107](../src/lib/job-filters.ts#L107), [quoted-actions.ts:466](../src/lib/quoted-actions.ts#L466) |
| **Status** | `Job.status` (Active / HeadStart / Complete) | Stored, manager-edited | [page.tsx:1038-1064](../src/app/(app)/quoted/page.tsx#L1038-L1064) |
| **Start Date** | `Job.startDate` | Stored, manager-edited | [page.tsx:1066-1078](../src/app/(app)/quoted/page.tsx#L1066-L1078) |
| **Complete Date** | `Job.completeDate` | Stored, manager-edited | [page.tsx:1080-1092](../src/app/(app)/quoted/page.tsx#L1080-L1092) |

**Job Id / Job name color** (`scheduleTone`,
[page.tsx:209-227](../src/app/(app)/quoted/page.tsx#L209-L227)):

- **Red, bold:** no Start Date.
- **Green:** has a Start Date but no Complete Date (in progress).
- **Default color:** has both dates, or the status is HeadStart (no Start Date is expected
  there).

**Row background:** light blue for SDC internal projects, otherwise alternating zebra stripes
([page.tsx:897-900](../src/app/(app)/quoted/page.tsx#L897-L900)).

---

## 3. Section columns (quoted / actual hours)

One column per section code. The list of sections, their phase banner and their department
band are defined in `SECTIONS`
([sections.ts:49-67](../src/lib/sections.ts#L49-L67)). Department names come from
[paylocity-canonical.ts:87-98](../src/lib/paylocity-canonical.ts#L87-L98).

**Which section columns are visible**
([page.tsx:339](../src/app/(app)/quoted/page.tsx#L339),
[page.tsx:364-369](../src/app/(app)/quoted/page.tsx#L364-L369)):

- The four restricted sections (10-111 PM, 10-413 Manufacturing, 70-211 and 70-411
  Warranty) only appear for roles with the matching Standard Fees permission
  ([sections.ts:499](../src/lib/sections.ts#L499),
  [sections.ts:518](../src/lib/sections.ts#L518)). Even for those roles they are hidden by
  default until turned on in the Sections picker.
- A phase with no visible sections shows no columns at all.

Each cell shows **`quoted / actual`**. The `/ actual` half only appears when Show Actuals is
on. Cell rendering: [page.tsx:1094-1153](../src/app/(app)/quoted/page.tsx#L1094-L1153).

### 3a. Quoted hours (blue number)

- **Source:** `EstimatedHours.quotedHours` for that job and section
  ([page.tsx:889](../src/app/(app)/quoted/page.tsx#L889),
  [schema.prisma:542](../prisma/schema.prisma#L542)).
- **Display:** rounded to a whole number. A section with no row shows "—".
- **Editing:** saved by `saveHoursCells`, which upserts the `EstimatedHours` row and sets
  `quotedHoursManuallyEdited = true`
  ([quoted-actions.ts:267-276](../src/lib/quoted-actions.ts#L267-L276)). Quoted hours are
  app-owned; the Power BI quoted sync is not on the automatic schedule
  ([auto-sync.ts:33](../src/lib/auto-sync.ts#L33)).

### 3b. Actual hours (green number)

- **Source:** `loadActualHoursBySection`
  ([actual-hours.ts:77-115](../src/lib/actual-hours.ts#L77-L115)), called once for all jobs on
  screen ([page.tsx:488](../src/app/(app)/quoted/page.tsx#L488)). Job Hour Details uses the
  same function, so the two pages always agree.
- **Formula:** for each job and section, add up three periods that don't overlap:

  ```
  Actual = EstimatedHours.actualHistoricalHours                    (1) Excel-migration snapshot
         + Σ EtcEntry.hoursWorked   for months NOT in the punch data  (2) frozen ETC months
         + Σ JobHoursDetail.hours   for months IN the punch data      (3) live Paylocity punches
  ```

  - "Months in the punch data" means every distinct month found in `JobHoursDetail`
    (`coveredMonths` in [actual-hours.ts](../src/lib/actual-hours.ts)). Each month counts
    in either period 2 or period 3, never both.
  - **The snapshot runs through January 2025.** Period 1 comes from
    `Hours Through 20250131.xlsx`, while the punch feed starts 2025-01-06. So for a job
    that has a snapshot, any period-2 or period-3 month up to and including
    `SNAPSHOT_THROUGH_MONTH` (`2025-01`) is already inside it and is not added again. A
    job with no snapshot keeps those months, because they are its only record. Measured
    2026-09-28: 5,618.35h across 37 jobs had been counted twice; 799.14h across 9 jobs
    without a snapshot are kept. See `OUTSIDE_SNAPSHOT` in
    [actual-hours.ts](../src/lib/actual-hours.ts).
  - Period 2 excludes the `PARTS_COST` pseudo-section (that is dollars, not hours).
  - Period 3 punches store the raw Paylocity code. Each one is mapped onto a grid column by
    `mapPunchToColumns` ([sections.ts:410](../src/lib/sections.ts#L410)) using
    `SECTION_ALIASES` ([sections.ts:311](../src/lib/sections.ts#L311)). For example,
    40-311 → 40-211, 10-414 → 10-413, and 13-211 → 10-211. **10-311 is split 30% to 10-312
    and 70% to 10-313.**
  - Punches whose code doesn't map to any grid column keep their raw code. They appear in
    the **Service & Spares** or **Other / Unmapped** column (section 5) rather than in a
    section column.
- **Why not just ETC Hours Worked:** closed ETC months are frozen and miss punches booked
  late. See the explanation at
  [actual-hours.ts:11-38](../src/lib/actual-hours.ts#L11-L38) and the comment at
  [page.tsx:460-466](../src/app/(app)/quoted/page.tsx#L460-L466).
- **Display:** rounded to a whole number. The tooltip shows both figures unrounded.

### 3c. Cell color (over / under)

`quotedCellTone` ([quoted-tone.ts:28-32](../src/lib/quoted-tone.ts#L28-L32)):

| Condition (checked in order) | Color |
|---|---|
| quoted ≤ 0 **and** actual ≤ 0 | none |
| actual > quoted | **red** (over) |
| job Status = Complete | **green** |
| otherwise (still running, at or under quote) | **yellow** |

While you type, the color is recalculated in the browser when the quoted value or the row's
Status changes ([ProjectsLiveTotals.tsx:126-153](../src/components/ProjectsLiveTotals.tsx#L126-L153)).

---

## 4. ENG TOTAL and SHOP TOTAL

Rendered at [page.tsx:1154-1196](../src/app/(app)/quoted/page.tsx#L1154-L1196).

- **Which sections count** ([page.tsx:507-509](../src/app/(app)/quoted/page.tsx#L507-L509)):
  - **SHOP TOTAL:** every *currently visible* section whose department is `Shop`: Mech Build,
    Elec Build, Manufacturing, and each phase's MB & EB.
  - **ENG TOTAL:** every *currently visible* section whose department is **anything other
    than** `Shop`: ME, CE, General Engineering, each phase's ME & CE, and **also PM (10-111)
    when that column is visible**.
- **Formula:**
  - Quoted total = Σ quotedHours over those sections.
  - Actual total = Σ actual hours (section 3b) over those sections.
  - ([page.tsx:1159-1160](../src/app/(app)/quoted/page.tsx#L1159-L1160))
- **Totals follow the column picker.** Hiding a section in Sections ▾ removes it from the
  total, so the same job can show different totals in different views.
- **Color:** the same `quotedCellTone` rule as a section cell, applied to the summed
  figures.
- **While you type:** only the quoted half of each total is recalculated from the inputs on
  screen ([ProjectsLiveTotals.tsx:81-120](../src/components/ProjectsLiveTotals.tsx#L81-L120)).
  The actual half stays as the server calculated it.

---

## 5. SERVICE & SPARES and OTHER / UNMAPPED (actual hours)

Two columns after SHOP TOTAL, actual hours only, so both are hidden when Show Actuals is
off. Together they hold every actual-hours code for the job that has **no column on this
grid**, even after the fold (`offGridActualHours`, [sections.ts](../src/lib/sections.ts)).
The split is **display only**: neither column is counted in ENG or SHOP TOTAL, the
Monthly ETC grid or Job Cost.

- **SERVICE & SPARES:** Service (`80-*`) and Spare Parts (`90-*`), decided by the phase
  prefix, so a combination nobody has seen before (e.g. `80-312`) still lands here. Job
  Hour Details uses the same rule for its Service & Spare Parts band.
- **OTHER / UNMAPPED:** everything else, meaning codes nobody has placed: `10-400`,
  `70-414`, malformed codes such as `1-312`. Shown **red** when above zero, because it
  should normally be empty.
- **What does not count:** a section that has a column but is hidden by the Sections
  picker or by permission. Neither figure moves with the picker.
- **In practice, punch-period only.** The migration snapshot and the ETC months were only
  ever recorded against grid columns.
- **Tooltip:** each code and its hours, largest first.

---

## 6. Footer: No Job ID and TOTAL

Two rows pinned to the bottom of the grid, actual hours only (hidden when Show Actuals is
off).

- **No Job ID:** punches whose job cell is blank, "Not Defined" or a job number the app
  doesn't have (`UndefinedHoursRow` with reason `MISSING_JOB_ID` or `JOB_NOT_FOUND`), for
  the months the punch data covers. They are folded onto columns like any job's punches
  (`loadJoblessActualsBySection`, [actual-hours.ts](../src/lib/actual-hours.ts)). The
  tooltip lists what the job cell said. It includes no pre-punch hours: those periods
  were only ever recorded per job.
- **No Job ID switch** (toolbar, next to Show Actuals): hides the No Job ID row. The
  TOTAL then counts job rows only and always reads partial. The switch works without
  reloading the page: both versions of the TOTAL are already rendered, and a class on
  the table picks one. It is saved in the URL as `jobless=0`, so saved views and split
  view keep it. It is on by default.
- **TOTAL:** every job row on screen plus No Job ID, per visible column, summed from
  exact figures and rounded only at the end. Its note says **complete** only when every
  job is listed (compared with a count of the `Job` table) and every section column is
  shown. Otherwise it says **partial** and why.
- **Not included, by design:** the import's other rejections. Control-total rows are
  report totals, not time; `INVALID_HOURS` rows carry no hours; `MISSING_WORK_DATE` and
  `INVALID_LABOR_CODE` are rejected before the year-ownership gate, so they could
  include an overlapping file's copy.
- **Check:** `scripts/check-hours-completeness.ts` rebuilds the complete TOTAL from the
  tables, period by period, and fails if the two differ.

---

## 7. PARTS COST (quoted / actual dollars)

Rendered at [page.tsx:1197-1240](../src/app/(app)/quoted/page.tsx#L1197-L1240). One column
showing `$quoted / $actual`; the actual half only appears when Show Actuals is on.

| Half | Field | Where it comes from | Code |
|---|---|---|---|
| **Quoted** (blue) | `Job.costQuoted` | Entered by a manager on this page. An edit sets `costQuotedManuallyEdited` | [quoted-actions.ts:492-500](../src/lib/quoted-actions.ts#L492-L500), [schema.prisma:168](../prisma/schema.prisma#L168) |
| **Actual** (green) | `Job.costActualHistorical` | **Synced from TotalETO** on every auto-sync pass (`parts_cost_actual` step) | [auto-sync.ts:584](../src/lib/auto-sync.ts#L584), [sync-totaleto.ts:1212](../src/lib/sync-totaleto.ts#L1212) |

**How Parts Cost Actual is calculated** (`getPartsActualByJob`,
[sync-totaleto.ts:648-683](../src/lib/sync-totaleto.ts#L648-L683); full definition and audit
notes at [sync-totaleto.ts:550-647](../src/lib/sync-totaleto.ts#L550-L647)):

- It is the total of **GL-posted AP invoice lines** attributed to the job, all time with no
  date limit.
- Line amount = qty × unit price × (1 − item discount) × currency rate. Refund lines count
  as negative.
- Open purchase orders that haven't been invoiced count as **$0**. This figure is money
  actually spent, not money committed.
- A job with only open POs is still written, as $0.
- Jobs TotalETO has no record of are **never overwritten**. This protects the 116 older jobs
  whose actual figure was entered by hand before TotalETO.
- The stored value is rounded to cents.

**Color:** the same `quotedCellTone` rule as the hours cells, applied to dollars
([page.tsx:907-911](../src/app/(app)/quoted/page.tsx#L907-L911)).

A banner warns when the `totaleto_jobs` or `parts_cost_actual` sync is out of date
([page.tsx:521](../src/app/(app)/quoted/page.tsx#L521)).

---

## 8. Things worth knowing

These came up while tracing the code. They describe current behavior and are not changes.

1. **PM counts in ENG TOTAL when visible.** The page puts everything that isn't `Shop` into
   Engineering ([page.tsx:508](../src/app/(app)/quoted/page.tsx#L508)).
   `billingGroupForSection` ([sections.ts:122](../src/lib/sections.ts#L122)), which the rest
   of the app uses, treats 10-111 as *neither* Engineering nor Shop.
2. **Manual edits to Parts Cost Actual can be overwritten.** The page lets you edit it, but
   there is no "manually edited" flag for that field. The next `parts_cost_actual` sync will
   replace the edit for any job TotalETO has parts activity for.
3. **The export totals are calculated differently from the on-screen totals.** The Projects
   export ([projects-export.ts:96-134](../src/lib/export/projects-export.ts#L96-L134))
   has a single quoted total and a single actual total over **all** sections, regardless of
   the column picker. It also adds Remaining columns (quoted − actual) that the grid
   doesn't show, and Service & Spare Parts and Other / Unmapped actual columns. It has no No Job ID row.
4. **The export has four "excl. SDC" Parts Cost columns the grid does not.** After
   *Parts Cost Remaining*: *SDC Billed (GL-posted, lifetime)*, *Parts Cost Actual
   (GL-posted, excl. SDC)*, *Parts Cost Remaining (excl. SDC)* and *Excl. SDC basis*. They are
   calculated live from Total ETO when you click Export (`getPartsActualSdcSplitByJob`), are
   stored nowhere, and do not change the grid or `Job.costActualHistorical`, which still
   include Steven Douglas Corp. Jobs with a typed historical actual (no Total ETO data) carry
   their stored figure through and say so in the basis column. If Total ETO does not answer,
   the file still downloads with those columns blank.
5. **The Export menu has an optional "Values as of" date.** Blank (the default) is the live export
   described above. With a date, the file shows figures through that day: actual hours by punch
   date, and Parts Cost Actual / SDC Billed / the excl. SDC columns by AP invoice date, all from
   one live Total ETO read so they agree with each other. Quoted hours, Parts Cost Quoted, Status
   and dates are always the current values (no history is kept for them), so the Remaining columns
   compare today's quote with the as-of actual. The date lives only in the menu and the request:
   it is never in the page URL, and the grid, the stored values and the sync do not change.
   Earliest date is 2025-01-31 (older hours are stored only as one lifetime total); a future date
   is refused. If Total ETO does not answer, a dated export fails with a clear message rather than
   printing today's stored total under a past heading. The file name carries `AsOf<date>`.

---

## Related reading

- [ETC-BUSINESS-LOGIC.md](ETC-BUSINESS-LOGIC.md): Monthly ETC formulas, including where
  `EtcEntry.hoursWorked` comes from.
- [DATA-FLOW.md](DATA-FLOW.md): how hours and parts cost get from their sources into the
  database.
- [UNMAPPED-HOURS.md](UNMAPPED-HOURS.md): punches that don't map to a grid column.
