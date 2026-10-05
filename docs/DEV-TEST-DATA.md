# Test data for the dev environment

The baseline seed (`npm run db:seed-dev`) is small on purpose. This page is for
when you need **more**, or something **specific**: 200 jobs to test grid
performance, a month that fails validation, a contractor with no Paylocity id,
a locked-month edge case.

Read [DEV-ENVIRONMENT.md](DEV-ENVIRONMENT.md) first. Everything below assumes
the Docker database is running and `SDC_DEV_DISABLE_SYNC=1`.

**Why the data has to be written by hand.** In production, most tables are
filled by a sync from a company system (Total ETO, Power BI, the DataWarehouse,
Paylocity workbooks). Dev has none of those, so a page is only as good as the
rows you insert. A generator that writes the right rows is the dev equivalent of
the sync.

---

## 1. What feeds which feature

Models are in `apps/reports/prisma/schema.prisma` (the source of truth; it is
heavily commented). "Source in prod" is what you are standing in for.

| Feature | Tables to fill | Source in prod |
|---|---|---|
| **Employees** page, org chart | `Employee` (+ `supervisorId`), `PositionFamily`, `ManualContractorPunch`, `HiringPositionAssignment` | Paylocity roster, Position_Families, Recruiting export, timecards |
| **Projects** grid | `Job`, `EstimatedHours`, `JobTask`, `ProjectRelease`, `ExecutionRate` | Total ETO job mirror + manager edits |
| **Monthly ETC** | `EtcEntry`, `DepartmentEtcCompletion`, `MonthlyReportSubmission` | seeded by *Refresh Data* + manager entry |
| **Hours** explorer and drill-downs | `JobHoursDetail`, `JobMonthlyActualHours`, `HoursImportIssue`, `UndefinedHoursRow`, `PaylocityImport` | Paylocity workbook / DataWarehouse |
| **Standard Sheet** | `StandardSheetSetting`, `StandardSheetSnapshot`, `CategoryPool` | computed + manager edits |
| **Job Cost** | `JobCostDefaultRate`, `JobCostYearRate`, `JobCostHourAllocation`, `JobCostInventorySnapshot` | inventory workbook + manager edits |
| **Build Readiness** | `BuildReadinessJobSnapshot`, `BuildReadinessRefreshMeta`, `BuildReadinessSavedView` | Total ETO BOM/PO views |
| **Cash Flow** | `CashFlowSnapshot`, `CashFlowSnapshotLine`, `CashFlowEtcAllocation`, `CashFlowForecastOverride` | Total ETO + ETC |
| **Roles / access** | `User`, `RolePermission` | admin screen |
| **Audit log, Feedback, Saved views** | `AuditLog`, `Feedback`, `SavedView` | written by the app as people use it |
| **Data-source health** panel | `PowerBiFreshness`, `RefreshRun`, `RefreshLock` | written by each sync step |

**Pages that read Total ETO live** have no table to fill. The parts lines
(parts cost, left-to-invoice, parts list, procurement) are covered by the fake
feed in section 3. Other live reads (the BOM tree drill, cash-flow queries, the
job mirror) are not faked and show empty or "source unavailable".

---

## 2. Rules that keep generated data valid

These are the invariants the app assumes. Data that breaks them produces bugs
that are the generator's, not the app's.

**Keys and formats**
- `month` is always `"YYYY-MM"`. `workDate` is a date with no time.
- Section codes are `"<phase>-<function>"` and must come from
  `apps/reports/src/lib/sections.ts` (`10-111`, `10-211`, `10-312`, `10-313`,
  `10-515`…`10-518`, `10-411`…`10-413`, `40-/50-/70-211|411`). Codes starting
  `80-`/`90-` are service/spare parts and are deliberately off the grid.
- `Job.jobId` is the business id as a string (`"1079"`); `JobHoursDetail.jobId`,
  `EstimatedHours.jobId`, `EtcEntry.jobId` are the **numeric primary key**
  (`Job.id`). The `JobCost*` tables are the exception and use the string
  `Job.jobId`. Check the model before writing a foreign key.
- `JobHoursDetail.employeeId` is a **string Paylocity id**, not `Employee.id`,
  and is intentionally not a foreign key. Including ids that are *not* on the
  roster is a valid and useful test case.
- `JobHoursDetail` is unique on `(jobId, section, workDate, employeeId)`.
- `Employee.team` is a Scheduler code: `pm`, `mech`, `controls`, `build`,
  `wire`, `mfgops`, `service`; or null for back-office.
- Money columns are `Decimal`; pass numbers rounded to 2 places.

**ETC months (the part people get wrong)**
- A month is **locked** when it has entries and every one has
  `needsReview = false` (`isMonthLocked`). A month with **no** entries is
  *not started*, not locked.
- Months start in order, and only after the previous one is locked. Seed history
  oldest to newest: all earlier months locked, **at most one** open month, last.
- Chain the arithmetic: `hoursLeftCalc = max(priorEtc - hoursWorked, 0)`; a
  locked row has `newEtc` set and `submittedAt` set; the next month's `priorEtc`
  equals this month's `newEtc`.
- Keep `EtcEntry.hoursWorked` equal to the sum of that month's `JobHoursDetail`
  for the job and section, and `JobMonthlyActualHours.actualHours` equal to the
  sum across sections. Pages that show both will disagree otherwise, so a
  mismatch should only ever be deliberate (testing the Data Quality views).
- One stray `needsReview = true` row in a frozen month silently un-freezes it.

**People and logins**
- Every `User` needs a `passwordHash` (bcrypt, 10 rounds). Use the same dev
  password as the baseline and an email ending `@dev.local`.
- `User.employeeId` is optional and unique; link at most one login per person.

**Hygiene**
- Put `DEV` in every generated name (people, customers, jobs) and use job ids
  in the `9000`s, so it cannot be confused with real data and cannot collide
  with the real series.
- Use fictional customers and people. Do **not** paste real names, hours or
  dollar amounts from production, spreadsheets or screenshots into a prompt or
  a generator. See [SECURITY.md](../SECURITY.md).
- Seed a fixed PRNG seed so the dataset is reproducible and a bug can be
  reported as "seed 42, job 9017".

---

## 3. Faux ETO and BOM data

Two ready-made pieces, both on in the dev profile:

**Fake parts feed** (`SDC_DEV_FAKE_ETO=1`, [`dev-fake-eto.ts`](../apps/reports/src/lib/dev-fake-eto.ts)).
Total ETO parts lines are fetched live, so there is no table to seed. With the
flag on, the six parts functions in `sync-totaleto.ts` return deterministic
generated PO lines for **every job in your database** instead of opening a SQL
Server connection. Each job gets ~26 lines covering: fully, partially and
un-invoiced lines; BOM parts (`BOM-…`) and non-BOM parts (`MISC-…`); refunds;
invoices billed but only half posted to the GL; lines purchased across the last
5 months including the days around a month-end (so the as-of cutoff in
`left-to-invoice.ts` changes the answer); and PO-less extra-cost lines.
Same job id, same lines, every time. To change the mix, edit `fakePartsLines`.
It does not fake the BOM tree, so a part's "claimed by BOM row" split is not
exercised.

**Build Readiness snapshots** (`npx tsx prisma/dev-data/build-readiness.ts [--seed N] [--jobs N]`).
Writes `BuildReadinessJobSnapshot` rows for jobs 9101+: green/yellow/red bands,
assemblies, vendors and POs, past-due and uncovered parts, upcoming deliveries,
and one each of the `failed`, `empty` and `notReleased` states. Idempotent.

---

## 4. Writing a generator

Keep generators in `apps/reports/prisma/dev-data/` (create it), one file per
dataset, run with `npx tsx prisma/dev-data/<name>.ts`. Model them on
[`seed-dev.ts`](../apps/reports/prisma/seed-dev.ts), which already shows the
pattern:

1. Refuse to run unless `DATABASE_URL` is a loopback host (copy the guard).
2. Use `PrismaClient`; never raw SQL for anything with a unique key.
3. Be **idempotent**: upsert, or delete-then-insert only rows the script owns
   (select them by the `DEV` marker or the job-id range).
4. Be **deterministic**: a seeded PRNG, a CLI `--seed` and a `--jobs 200` style
   size argument.
5. Print what it created and the month states (`locked` / `open`).

Already written: `build-readiness.ts`. Typical datasets worth having:

| Name | Purpose | Shape |
|---|---|---|
| `scale` | Grid and export performance | 300 jobs, 80 employees, 24 months of punches |
| `etc-edge-cases` | ETC submission and validation | A month with a blank New ETC, a negative remainder, an unmapped section, a job with hours but no estimate |
| `roster-edge-cases` | Employees page | Temps with no `paylocityId`, a supervisor cycle-free chain 6 deep, an inactive person with hours, a leaver whose id is only in `JobHoursDetail` |
| `contractors` | The *Contractors* section | `ManualContractorPunch` rows, some superseded |
| `roles` | Permissions | One user per role plus `RolePermission` rows that differ from the defaults |
| `empty` | First-run experience | Users only; no jobs, no months |

---

## 5. Prompt for an AI assistant

Paste this into Claude Code (or any assistant with access to the repo), filling
in the bracketed parts. It is written so the assistant reads the schema rather
than guessing it.

````text
I need a dev-only test dataset generator for SDC Reports.

Read first, in this order:
  1. docs/DEV-ENVIRONMENT.md and docs/DEV-TEST-DATA.md (all of it, especially
     section 2, "Rules that keep generated data valid")
  2. apps/reports/prisma/seed-dev.ts   (the pattern to copy)
  3. apps/reports/prisma/schema.prisma (the models for the feature below)
  4. apps/reports/src/lib/sections.ts and the lib/ file that renders the feature

Goal: [e.g. "a dataset that exercises the Employees page's Contractors section:
temps with no Paylocity id, some with punches, some superseded"]

Write apps/reports/prisma/dev-data/[name].ts that:
  - refuses to run unless DATABASE_URL points at localhost / 127.0.0.1
  - is idempotent and deterministic (seeded PRNG, --seed N, --[size] N flags)
  - touches only rows it owns, identified by "DEV" in names and job ids 9000+
  - uses only fictional people, customers and amounts
  - respects every invariant in section 2 (month format, section codes from
    sections.ts, ETC locking order, numeric vs string job keys)
  - prints a summary of what it created

Do not edit schema.prisma, migrations, or anything under src/. Do not run it
against any database except the Docker one in docker-compose.dev.yml.

When done: run it twice (second run must change nothing), then run
`npx tsc --noEmit`, open the relevant page signed in as elt@dev.local, and tell
me what you saw, including anything that looked wrong. If a page shows empty
because it reads a company system live, say so instead of faking it.
````

### Checking the result

1. Run the generator twice. The second run must leave row counts unchanged.
2. Sign in as `elt@dev.local` and open the target page; then open it as a lower
   role (`all@dev.local`) to see what is hidden.
3. If a page looks wrong, decide whose bug it is: **invalid data** (the
   generator broke a rule in section 2) or **an app bug** (data was valid and
   the page is wrong). Only the second belongs in a PR.
4. Run `npm run lint` and `npm test` in `apps/reports`.
5. Commit the generator, never a database dump.
