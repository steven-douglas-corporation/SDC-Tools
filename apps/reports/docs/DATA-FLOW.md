# Data Flow

How data actually moves from an external source to a rendered screen (and, where relevant,
back out to a database), for the flows that matter most in this app. For the formulas applied
along the way, see [ETC-BUSINESS-LOGIC.md](ETC-BUSINESS-LOGIC.md); for what triggers each sync
step, see [REFRESH-PIPELINE.md](REFRESH-PIPELINE.md).

## Hours

```mermaid
flowchart LR
    A[Lisa's OneDrive workbook<br/>Current_Job_Hours.xlsx] --> B[paylocity-workbook.ts<br/>parse + classify rejects]
    B --> C[hours-feed.ts<br/>workbook vs. Power BI by month]
    C --> D["auto-sync.ts: syncActualHours()"]
    D --> E[(JobMonthlyActualHours<br/>job × month rollup)]
    D --> F[(JobHoursDetail<br/>punch-level rows)]
    C --> G["auto-sync.ts: syncHoursWorked(month)"]
    G --> H[(EtcEntry.hoursWorked<br/>per job × section × month)]
    E --> I[Job Hour Details dashboard]
    F --> J[Hours drill-through panels]
    H --> K[Monthly ETC grid<br/>Hours Left / New ETC]
```

Rejected rows (bad date, unmapped section, unknown job) are collected as typed `RejectedPunch`
records rather than dropped — they surface as Undefined Hours (see
[ETC-BUSINESS-LOGIC.md](ETC-BUSINESS-LOGIC.md#10-hours-off-the-grid--undefined-hours)).

## Parts cost

```mermaid
flowchart LR
    A[(Total ETO<br/>AP document tables)] --> B["sync-totaleto.ts:<br/>getPartsCostBookedByJob()"]
    B --> C["sync-actuals.ts:<br/>syncPartsCost(month)"]
    C --> D[(EtcEntry, Parts Cost section)]
    D --> E["etc-month-kpis.ts:<br/>getEtcMonthKpis()"]
    E --> F[KPI strip: Parts Spent card]
    D --> G[hours-detail-actions.ts:<br/>loadPartsSpentDetail]
    G --> H["sync-totaleto.ts:<br/>getJobPartsCost() / invoicedOnly()"]
    H --> I[Parts Spent drill-through]
```

A **separate** lifetime measure — `getPartsCostSpentByJob` via `syncPartsCostActual()` — feeds
only the Projects grid's "Parts Cost Actual" column and is not part of this monthly flow. Don't
conflate the two when tracing a discrepancy.

## Monthly ETC cell edit

```mermaid
flowchart TD
    A[User types in a grid cell] --> B[EtcAutosave.tsx<br/>~800ms debounce]
    B --> C["etc-actions.ts:<br/>saveAllNewEtcDrafts()"]
    C --> D{Believed-stored value<br/>matches actual?}
    D -->|yes| E[Write EtcEntry.newEtcDraft<br/>never the confirmed column]
    D -->|no — conflict| F[Refuse the write,<br/>return believed vs. actual]
    E --> G[recordChanges<br/>→ realtime broadcast]
    G --> H[Other open tabs patch<br/>the one cell via cellKey]
    E --> I[This tab re-baselines<br/>its dirty tracker]
```

Only a **Submit** turns a draft into the confirmed `newEtc` — see §"Exports / submission" below
and [ETC-BUSINESS-LOGIC.md §9](ETC-BUSINESS-LOGIC.md#9-submission-readiness). There is no
`revalidatePath` on the save path; the UI update is optimistic on the editing tab and
event-driven on every other tab. See [REALTIME-SYNC.md](REALTIME-SYNC.md) for the conflict
model in detail.

## KPI / drill-through data

The KPI strip and its drill-throughs are **not one shared computation** in general — they run
separate queries against the same underlying `EtcEntry` rows and reconcile by using the same
formulas, not by sharing a result:

```
Server render (etc/page.tsx)
  ├─ etc-month-kpis.ts: getEtcMonthKpis(month, visibleJobs)   — synced fields (prior, worked, hoursLeft, parts.spent)
  └─ etc-issues.ts: buildEtcIssues(...)                        — off-grid jobs + undefined-hours counts

Client (EtcMonthKpiCards.tsx)
  reconcileEtcKpis(serverKpis, rollupLiveTotals(useEtcLiveTotals()))
      overrides ONLY the editable fields (newEtc, diff) from the live client-side cell store
  buildKpiBlocks(...)   — pure presentation, computes no KPI itself

On click → requestKpiDrill(scope)
  → a separate fetch per lane: loadUnattributedDetail / loadEtcMonthHoursDetail /
    loadPartsSpentDetail / loadJobPartsLines
```

The one place the KPI and its drill are **structurally** the same data, not just reconciled
rules: Undefined Hours. `recordUndefinedHours()` writes the KPI total and the drill's
punch-level rows in one pass, one transaction — see
[ETC-BUSINESS-LOGIC.md §10](ETC-BUSINESS-LOGIC.md#10-hours-off-the-grid--undefined-hours).

## Exports / submission

**Export** (`ExportMenu.tsx` → `lib/export/etc-export.ts`): reuses the exact same
`newEtcSeedText`/`newEtcDiff`/`effectiveNewEtc` functions the grid renders with, so an exported
sheet can never disagree with what's on screen. Rendered to CSV or XLSX by
`lib/export/csv.ts`/`xlsx.ts` from a shared `SheetSpec`.

**Submit** (`SubmitReportAction.tsx` → `monthly-report-actions.ts`'s `submitMonthlyReport()`):

1. Idempotency check (has this `submissionId` already been processed).
2. Permission check (Standard Sheet unlocked).
3. Duplicate-submission check for the month.
4. Staleness check — the browser's data fingerprint must match the server's current one.
5. `validateMonthlyReport()` must pass (see [ETC-BUSINESS-LOGIC.md §9](ETC-BUSINESS-LOGIC.md#9-submission-readiness)).
6. One transaction: `submitEtcEntriesInTx()` freezes every entry, plus a full
   `StandardSheetSnapshot` per job.
7. Record the submission, cascade the now-frozen New ETC into any already-open later months,
   log the audit entry.

Nothing about steps 1–5 mutates data — a failed check leaves the month exactly as it was.
