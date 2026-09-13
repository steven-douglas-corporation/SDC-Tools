# ETC Business Logic

The exact, current formulas behind the Monthly ETC grid — quoted directly from the code, not
paraphrased. This document only describes existing behavior; it does not define new behavior,
and none of it changed while writing this doc.

All hours round to whole numbers for display/storage/submission (`HOURS_DECIMALS = 0`); money
keeps 2 decimals (`MONEY_DECIMALS = 2`); both are applied via `round2`/`roundTo` in
`src/lib/cell-rules.ts`.

## 1. Prior ETC

`src/lib/etc.ts` — `priorEtcForMonth()`:

```ts
export function priorEtcForMonth(opts: { startsThisMonth: boolean; carried: number | undefined; quoted: number }): number {
  return round2(!opts.startsThisMonth && opts.carried !== undefined ? opts.carried : opts.quoted);
}
```

`carried` is the New ETC of the **latest earlier month that has an entry** for this job/section
(`latestPriorEtcByKey`, `etc.ts`) — not necessarily the immediately previous month, so a job
that skipped a period resumes from its real balance instead of resetting. If the job's Start
Date falls in the target month, it opens at its quoted hours regardless of any carried balance.

This single function is called from every writer — seeding new entries, `derivePriorEtcForMonth`
(carry-forward), and `syncPartsCost` — so there is exactly one definition of Prior ETC, not one
per caller.

## 2. Hours Worked

Not a formula so much as a sourcing rule: `EtcEntry.hoursWorked` is written by
`syncHoursWorked()` in `src/lib/sync-actuals.ts`, sourced from the Paylocity workbook (via
`readHoursFeed()` → `readPaylocityWorkbook()`) for the current and recent months, falling back
to Power BI only for months before 2026-01 that the workbook doesn't cover. It's an overwrite on
every refresh, not something a user can hand-edit — rows the export no longer reports get
zeroed, and hours booked to a section with no quote create a new row rather than being dropped.

A **separate, cumulative** definition — "actual hours to date" for dashboards — is
`loadActualHoursBySection()` in `src/lib/actual-hours.ts`, which stitches three eras together
(migrated Excel snapshot + frozen `EtcEntry.hoursWorked` for pre-punch-table months + live
`JobHoursDetail` punches where available) so a closed month doesn't silently drop late punches.
Don't confuse the two: the grid's monthly `hoursWorked` and the dashboard's lifetime actual are
different reads of related but not identical data.

## 3. Hours Left

`src/lib/etc.ts`:

```ts
export function calcHoursLeft(priorEtc: number, hoursWorked: number): number {
  return priorEtc - hoursWorked;
}
```

Plain **Prior ETC − Hours Worked**. Deliberately **not clamped at zero** — a section can be
shown overspent (negative Hours Left) rather than having that fact hidden.

## 4. New ETC

The system-suggested value, `src/lib/etc.ts`:

```ts
export function suggestNewEtc(priorEtc: number, hoursWorked: number): number {
  if (hoursWorked === 0) return priorEtc;
  return Math.max(calcHoursLeft(priorEtc, hoursWorked), 0);
}
```

Zero hours worked this month → carry Prior ETC forward unchanged (no decision forced). Any
hours worked → `max(Hours Left, 0)` — the *suggestion* never goes negative even though Hours
Left itself can.

What actually counts for totals/KPIs is the **effective** New ETC (`effectiveNewEtc`,
`etc.ts`): the submitted/confirmed value if the row isn't pending review; otherwise the saved
draft if one exists; otherwise the suggestion above. A manager can also explicitly **clear** a
cell, which is tracked separately (`newEtcClearedAt`) from "never answered" — see
`newEtcSeedText()` for the exact precedence a cell displays on arrival: cleared beats confirmed
beats draft beats carry-forward, and a zero-hours carry-forward only shows mid-month once the
month is otherwise complete (or Prior ETC was already zero).

## 5. Total New ETC (rollup)

`src/lib/etc.ts` — `rollupNewEtc()`. The Engineering/Shop rollup blocks are **all-or-nothing**:
if any cell requiring a decision (hours were booked, box still empty) is undecided, the whole
rollup for that job/group renders blank (`newEtc: null, diff: null`) rather than a partial sum.
Once every required cell is decided: `newEtc = Σ max(cell.newEtc, 0)` and
`diff = hoursLeft − newEtc`. This is the exact same set of undecided cells that blocks
submission (see §9) — "the rollup is blank" and "the month can't submit" are one fact, not two
independently-maintained rules. Section-level cells, Parts Cost, and the KPI cards are **not**
subject to this all-or-nothing rule — only this specific job/group total is.

## 6. Diff

`src/lib/etc.ts` — `newEtcDiff()`:

```ts
if (!isNewEtcDecided(entry)) return 0;
return calcHoursLeft(...) - Math.max(effectiveNewEtc(entry), 0);
```

**Diff = Hours Left − max(New ETC, 0)**. For a cell nobody has decided yet (still yellow/blank),
Diff is exactly `0` — not the suggestion's diff, not null.

## 7. Parts Cost

The authoritative monthly figure is `getPartsCostBookedByJob()` in `src/lib/sync-totaleto.ts`,
called by `syncPartsCost()` in `src/lib/sync-actuals.ts`, written into the `EtcEntry` row for
the Parts Cost section (its `hoursWorked` field holds money spent, by convention). Basis:

- **Date**: `APBD.APDocDate` — the AP *document* date on the batch-document table. This is what
  the business calls "Purchased Date," even though it is not `POH.PurchaseDate`.
- **Amount**: `APDD.APDocQty × APDD.APDocUnitPrice × (1 − APDD.APDocItemPctDisc) × APBD.APDocCurrRate`
  — quantity/price/discount from the AP detail row, currency rate from the batch document.
- **Sign**: credit memos are kept negative and net off — not excluded.
- **Job**: `APDD.ProjectID` taken directly off the AP line, not derived through the PO→Spec→Project chain.
- **Scope**: parts-cost AP lines only; Extra Costs (shipping/fees/tariffs) are explicitly excluded.

This reconciles to Total ETO's own reporting to the cent on the large majority of jobs. Two
older formulas exist in the same file for different purposes and must not be substituted in
here: `getPartsCostSpentByJob` (an unwindowed lifetime snapshot, still used for the Projects
grid's "Parts Cost Actual" column) and `getPartsCostPurchasedByJob` (superseded, kept only for
two archived audit scripts).

## 8. Month-to-month carry-forward

`src/lib/etc-prior-etc.ts` — `derivePriorEtcForMonth()` re-derives Prior ETC (and Hours Left)
for every **unsubmitted** row in a month, using §1's rule. It never touches an already-submitted
row and never resets a job that starts that month. `cascadePriorEtcForward()` pushes a
corrected month's New ETC into later months, but **stops at the first locked month** rather than
skipping past it.

**On reopen** (`reopenMonth()`, `src/lib/etc-actions.ts`): every entry in the month is marked
pending review again, and both functions above are re-run explicitly — this is what prevents a
reopened month from keeping a Prior ETC value that predates an upstream correction.

## 9. Submission readiness

Gate: `validateMonthlyReport()` in `src/lib/monthly-report.ts`, scoped to
`entriesInSubmissionScope()` (`src/lib/monthly-report-flow.ts`) — only jobs currently eligible
for the grid, so a job that went non-billable/HeadStart/Complete mid-month doesn't strand the
whole submission on rows nobody can see anymore. Blockers, in the order surfaced to the user:

1. **Department sign-off** — any department not marked complete for the month.
2. **Missing New ETC** — any in-scope, unsubmitted entry where hours or money were booked but
   the New ETC field is blank (including a deliberately-cleared cell).
3. **Invalid stored Hours Worked** — negative or non-finite, on a non-Parts-Cost section.
4. **Standard Sheet pools** — missing, or still carried forward from a prior month.

The actual freeze is one Prisma transaction (`submitEtcEntriesInTx()`,
`src/lib/monthly-report.ts`): it writes `newEtc`/`hoursLeftCalc`, clears the draft fields, sets
`needsReview = false`, and snapshots the Standard Sheet fee rows — so a month can never end up
half-submitted (ETC frozen but fees still open, or vice versa).

## 10. Hours Off the Grid / Undefined Hours

Two distinct exclusions, easy to conflate but defined and computed separately:

- **Undefined Hours** — punches that reach no job number at all.
  `src/lib/undefined-hours-rules.ts`'s `countsAsUndefined()` requires
  `countsTowardKpi && KPI_COUNTED_REASONS.has(reason)`, and only two reasons count:
  `MISSING_JOB_ID` and `JOB_NOT_FOUND`. Every other rejection reason (invalid labor code,
  unmapped department/employee, unsupported category, etc.) is treated as a **correct**
  exclusion, not an undefined hour, and does not inflate this KPI. The KPI aggregate and its
  drill-through both consume the same `aggregateUndefined()` pass, so they reconcile by
  construction rather than needing to be kept in sync by convention.
- **Hours Off the Grid** — `EtcEntry` rows that exist for the month but belong to a job the grid
  no longer lists (its status changed after the month was seeded). The eligibility test is
  `getEtcMonthJobWhere()` in `src/lib/etc-month-jobs.ts`: a locked month, or a reopened
  historical month, uses the **entries-based** universe (whatever jobs were actually submitted
  at the time, regardless of today's status); only the single current open month uses the live
  active-job filter. Off-grid rows are removed by the next Refresh Data or Submit, not edited in
  place.

## Related reading

- [DATA-FLOW.md](DATA-FLOW.md) — how a cell edit or a sync actually reaches these functions.
- [CODEBASE-STRUCTURE.md](CODEBASE-STRUCTURE.md#shared-utilities-and-calculation-modules) —
  why `lib/etc.ts` is the one place these formulas live.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — what "incorrect totals" usually turns out to be.
