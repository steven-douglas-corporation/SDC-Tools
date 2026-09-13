import { prisma } from "@/lib/prisma";
import { runDax } from "@/lib/powerbi-client";
import { ETC_TRACKED_CODES, PARTS_COST_SECTION } from "@/lib/sections";
import { calcHoursLeft, suggestNewEtc, round2, hasPublishedHistory, groupStandardFeesRows } from "@/lib/etc";
import { queryWarehouse } from "@/lib/fabric-warehouse";
import { fetchEtcPeriods } from "@/lib/etc-period";

// Refreshes historical ETC months from Power BI's "ETC Historical *" measure
// family — the same numbers the Job Hours Report's "ETC Historical Hours"
// visual renders (unfiltered):
//
//   [ETC Historical Hours Prior Month]  -> Prior ETC
//   [ETC Historical Hours]              -> New ETC (submitted snapshot;
//                                          BLANK where never submitted)
//   [ETC Historical Hours Left]         -> Prior - real hours worked, so
//                                          real Worked = Prior - Left
//   (+ "ETC Historical Costs *" twins for the Parts Cost block, per job)
//
// The live [Hours Actual, Est to Date] measure cannot serve historical
// periods (its backing calculated column errors out), which is why history
// goes through these measures instead of syncHoursWorkedFromPowerBi.
//
// Period mapping: see etc-period.ts, which owns it for both PBI-facing syncs.
//
// This used to map by [ETC Name] ("May 2026" IS app month "2026-05"), on the
// grounds that Begin Date runs a month later. Re-measured against the punch
// export on 2026-07-31, that is no longer true upstream: every period's figures
// now line up with its BEGIN DATE month, and name-as-month was wrong in all 24
// department-months tested. The app's stored history is unaffected — it is
// correctly labelled and the upstream name moved under it — but a backfill run
// with the old mapping would write each period's data into the wrong month.
//
// Ownership rule — which system's numbers win for a month:
// - A month is APP-OWNED (never overwritten here) when any of its entries
//   carry real in-app work: submittedAt / enteredById (submitted in the
//   app), newEtcDraft (manager mid-edit), or needsReview=true (in-progress
//   month whose workflow the live sync owns).
// - Every other month that Power BI has a period for is PBI-OWNED history
//   and is wiped + rewritten from the measures, so re-running always
//   converges on what Power BI currently reports (including the still-open
//   PBI period, which keeps accruing hours until their team closes it).
//
// Known gap (found 2026-07-14, see the June 2026 data-correction incident):
// Power BI only publishes a month's "ETC Historical *" archive several
// weeks after month-end (April by 5/11, May by 6/10, June by 7/08 — all
// observed from the real Excel exports). If a month gets Submitted & Locked
// in the app (e.g. during testing, or before managers finish their real
// review) *before* Power BI has published its archive for it, that month
// becomes permanently app-owned and this function will never again try to
// reconcile it against Power BI's real numbers, even once the archive shows
// up — silently freezing whatever the live/auto-suggested values were at
// submit time. This function can't safely auto-overwrite an app-owned month
// (a genuine manager correction must never be clobbered), but it now
// detects the situation and reports it via `monthsOwnedWithPbiHistoryNow`
// so an admin can see it in the audit log and decide whether to reopen and
// re-run "Sync History" for that specific month.
export async function syncEtcHistoryFromPowerBi(): Promise<{
  monthsRefreshed: string[];
  monthsSkippedAppOwned: string[];
  monthsOwnedWithPbiHistoryNow: string[];
  entriesWritten: number;
  entriesReconciled: number;
  unsubmittedFilled: number;
  poolMonthsRefreshed: string[];
  poolRowsWritten: number;
  poolMonthsOwnedWithPbiHistoryNow: string[];
  poolEntriesReconciled: number;
}> {
  // Resolved by the period's Begin Date, not its name — see etc-period.ts. The
  // name-based mapping this used to do is now off by a month upstream.
  const candidates = (await fetchEtcPeriods()).map((p) => ({ name: p.name, month: p.month }));

  // App-owned months, per the ownership rule above.
  const ownedRows = await prisma.etcEntry.findMany({
    where: {
      OR: [{ submittedAt: { not: null } }, { enteredById: { not: null } }, { newEtcDraft: { not: null } }, { needsReview: true }],
    },
    distinct: ["month"],
    select: { month: true },
  });
  const appOwned = new Set(ownedRows.map((r) => r.month));

  const jobs = await prisma.job.findMany({ select: { id: true, jobId: true } });
  const jobByJobId = new Map(jobs.map((j) => [j.jobId, j]));

  const monthsRefreshed: string[] = [];
  const monthsSkippedAppOwned: string[] = [];
  const monthsOwnedWithPbiHistoryNow: string[] = [];
  let entriesWritten = 0;
  let entriesReconciled = 0;
  let unsubmittedFilled = 0;

  for (const period of candidates) {
    if (appOwned.has(period.month)) {
      monthsSkippedAppOwned.push(period.month);
      // Has Power BI's archive shown up for this month since it was locked
      // in the app? If so, reconcile the display-only fields (Prior ETC /
      // Hours Worked / Hours Left) against it — these don't drive any dollar
      // calculation (calcTotalEtcDollars uses New ETC only, confirmed
      // against standard-fees.ts) — while leaving every real decision (New
      // ETC, submittedAt, needsReview, newEtcDraft) exactly as the manager
      // left it. Never inserts a row that doesn't already exist: a job/
      // section PBI now reports that the locked month never had would
      // change what's visible in a frozen month without review, so that
      // case is left flagged for a human instead. See the June 2026
      // data-correction incident and the 2026-07-17 April 2026 audit.
      const [historyRows, historyCostRows] = await Promise.all([
        runDax(`
          EVALUATE
          SUMMARIZECOLUMNS(
            'Job'[Job Id], 'Function Hierarchy'[Section-Function Code],
            FILTER(ALL('Estimated to Complete Period'), 'Estimated to Complete Period'[ETC Name] = "${period.name}"),
            "PriorEtc", [ETC Historical Hours Prior Month],
            "NewEtc", [ETC Historical Hours],
            "Left", [ETC Historical Hours Left]
          )
        `) as Promise<
          { "Job[Job Id]": string; "Function Hierarchy[Section-Function Code]": string; PriorEtc: number | null; NewEtc: number | null; Left: number | null }[]
        >,
        runDax(`
          EVALUATE
          SUMMARIZECOLUMNS(
            'Job'[Job Id],
            FILTER(ALL('Estimated to Complete Period'), 'Estimated to Complete Period'[ETC Name] = "${period.name}"),
            "PriorEtc", [ETC Historical Costs Prior Month],
            "NewEtc", [ETC Historical Costs],
            "Left", [ETC Historical Costs Left]
          )
        `) as Promise<{ "Job[Job Id]": string; PriorEtc: number | null; NewEtc: number | null; Left: number | null }[]>,
      ]);

      if (!hasPublishedHistory(historyRows) && !hasPublishedHistory(historyCostRows)) continue;
      monthsOwnedWithPbiHistoryNow.push(period.month);

      const existingEntries = await prisma.etcEntry.findMany({ where: { month: period.month } });
      const existingByKey = new Map(existingEntries.map((e) => [`${e.jobId}::${e.section}`, e]));

      const reconcileRow = (rawJobId: string | null, section: string, r: { PriorEtc: number | null; NewEtc: number | null; Left: number | null }) => {
        if (rawJobId == null) return null;
        // An all-blank measure row means "no archive data for this combo",
        // NOT "the archive says zero" — SUMMARIZECOLUMNS emits a row per
        // job/measure combo with every measure BLANK when unpublished (see
        // hasPublishedHistory). Coercing those blanks to 0 here would zero
        // out a locked month's real values the moment one archive family
        // (hours vs costs) publishes before the other.
        if (r.PriorEtc == null && r.NewEtc == null && r.Left == null) return null;
        const job = jobByJobId.get(String(Number(rawJobId)));
        if (!job) return null;
        const existing = existingByKey.get(`${job.id}::${section}`);
        if (!existing) return null;

        const priorEtc = round2(r.PriorEtc ?? 0);
        const left = round2(r.Left ?? 0);
        const hoursWorked = round2(priorEtc - left);
        if (Math.abs(Number(existing.priorEtc) - priorEtc) < 0.005 && Math.abs(Number(existing.hoursWorked) - hoursWorked) < 0.005) {
          return null;
        }
        return { id: existing.id, priorEtc, hoursWorked, hoursLeftCalc: round2(calcHoursLeft(priorEtc, hoursWorked)) };
      };

      const updates: { id: number; priorEtc: number; hoursWorked: number; hoursLeftCalc: number }[] = [];
      // Each archive family is gated on ITS OWN published-ness — the hours
      // archive can land before the costs archive (or vice versa), and the
      // unpublished one must not be treated as a sheet of zeros.
      if (hasPublishedHistory(historyRows)) {
        for (const r of historyRows) {
          const section = r["Function Hierarchy[Section-Function Code]"];
          if (section == null || !ETC_TRACKED_CODES.has(section)) continue;
          const u = reconcileRow(r["Job[Job Id]"], section, r);
          if (u) updates.push(u);
        }
      }
      if (hasPublishedHistory(historyCostRows)) {
        for (const r of historyCostRows) {
          const u = reconcileRow(r["Job[Job Id]"], PARTS_COST_SECTION, r);
          if (u) updates.push(u);
        }
      }

      if (updates.length > 0) {
        await prisma.$transaction(
          updates.map((u) =>
            prisma.etcEntry.update({ where: { id: u.id }, data: { priorEtc: u.priorEtc, hoursWorked: u.hoursWorked, hoursLeftCalc: u.hoursLeftCalc } })
          )
        );
        entriesReconciled += updates.length;
      }
      continue;
    }

    const [hoursRows, costRows] = await Promise.all([
      runDax(`
        EVALUATE
        SUMMARIZECOLUMNS(
          'Job'[Job Id], 'Function Hierarchy'[Section-Function Code],
          FILTER(ALL('Estimated to Complete Period'), 'Estimated to Complete Period'[ETC Name] = "${period.name}"),
          "PriorEtc", [ETC Historical Hours Prior Month],
          "NewEtc", [ETC Historical Hours],
          "Left", [ETC Historical Hours Left]
        )
      `) as Promise<
        { "Job[Job Id]": string; "Function Hierarchy[Section-Function Code]": string; PriorEtc: number | null; NewEtc: number | null; Left: number | null }[]
      >,
      runDax(`
        EVALUATE
        SUMMARIZECOLUMNS(
          'Job'[Job Id],
          FILTER(ALL('Estimated to Complete Period'), 'Estimated to Complete Period'[ETC Name] = "${period.name}"),
          "PriorEtc", [ETC Historical Costs Prior Month],
          "NewEtc", [ETC Historical Costs],
          "Left", [ETC Historical Costs Left]
        )
      `) as Promise<{ "Job[Job Id]": string; PriorEtc: number | null; NewEtc: number | null; Left: number | null }[]>,
    ]);

    const newEntries: {
      jobId: number;
      section: string;
      month: string;
      priorEtc: number;
      hoursWorked: number;
      hoursLeftCalc: number;
      newEtc: number;
      needsReview: boolean;
    }[] = [];

    const addRow = (rawJobId: string | null, section: string, r: { PriorEtc: number | null; NewEtc: number | null; Left: number | null }) => {
      if (rawJobId == null) return;
      const priorEtc = round2(r.PriorEtc ?? 0);
      const left = round2(r.Left ?? 0);
      const hoursWorked = round2(priorEtc - left);
      // A fully empty combo (never estimated, no work) isn't history worth storing.
      if (priorEtc === 0 && hoursWorked === 0 && (r.NewEtc ?? 0) === 0) return;
      const job = jobByJobId.get(String(Number(rawJobId)));
      if (!job) return;

      let newEtc: number;
      if (r.NewEtc == null) {
        // Never submitted in the source — hold the app's own suggestion so
        // the row still renders as closed history.
        newEtc = round2(suggestNewEtc(priorEtc, hoursWorked));
        unsubmittedFilled++;
      } else {
        // Clamp at 0: New ETC is hours/dollars-left-to-complete and can never
        // be negative (the app's own suggestNewEtc enforces this). Power BI's
        // "ETC Historical" measure can report a negative for edge rows — e.g.
        // internal/overhead jobs with prior ETC 0 but hours logged against the
        // section — and storing that verbatim left nonsensical negative New ETC
        // values in closed months (found in 2026-06 for jobs 4000/6000/7000).
        newEtc = round2(Math.max(0, r.NewEtc));
      }

      newEntries.push({
        jobId: job.id,
        section,
        month: period.month,
        priorEtc,
        hoursWorked,
        hoursLeftCalc: round2(calcHoursLeft(priorEtc, hoursWorked)),
        newEtc,
        needsReview: false,
      });
    };

    for (const r of hoursRows) {
      const section = r["Function Hierarchy[Section-Function Code]"];
      if (section == null || !ETC_TRACKED_CODES.has(section)) continue;
      addRow(r["Job[Job Id]"], section, r);
    }
    for (const r of costRows) addRow(r["Job[Job Id]"], PARTS_COST_SECTION, r);

    // Only replace the month when Power BI actually returned data for it —
    // an empty period (e.g. "Aug 2025" exists in the dimension but has no
    // history rows) must not wipe anything.
    if (newEntries.length === 0) continue;

    await prisma.$transaction(
      async (tx) => {
        await tx.etcEntry.deleteMany({ where: { month: period.month } });
        await tx.etcEntry.createMany({ data: newEntries });
      },
      { timeout: 30000 },
    );

    monthsRefreshed.push(period.month);
    entriesWritten += newEntries.length;
  }

  const pools = await syncCategoryPoolHistory(new Map(candidates.map((p) => [p.name, p.month])), appOwned);

  return { monthsRefreshed, monthsSkippedAppOwned, monthsOwnedWithPbiHistoryNow, entriesWritten, entriesReconciled, unsubmittedFilled, ...pools };
}

const POOL_CATEGORY: Record<string, "ENGINEERING_PM" | "ENGINEERING_WARRANTY" | "SHOP_MANUFACTURING" | "SHOP_WARRANTY"> = {
  "Engineering|PM": "ENGINEERING_PM",
  "Engineering|Warranty": "ENGINEERING_WARRANTY",
  "Shop|Manufacturing": "SHOP_MANUFACTURING",
  "Shop|Warranty": "SHOP_WARRANTY",
};

interface StandardFeesRow {
  "Standard Fees[ETC Period Key]": number;
  "Standard Fees[Billing Group]": string;
  "Standard Fees[Department]": string;
  "Standard Fees[Previous Month Pulled Hours]": number | null;
  "Standard Fees[New Hours Added this Month]": number | null;
  "Standard Fees[Hours Available]": number | null;
  "Standard Fees[Hours Worked this Month]": number | null;
  "Standard Fees[Hours being pulled this month]": number | null;
  "Standard Fees[New ETC Hours]": number | null;
  "Standard Fees[Rate]": number | null;
  "Standard Fees[Standard Fee]": number | null;
}

// Backfills the "Standard Fees By Department" category pools for historical
// months from Power BI's 'Standard Fees' table — the archive of every pool
// submission (one row per department per ETC period, all fields included:
// Prev Pulled / New Added / Available / Worked / Pulled / New ETC / Rate /
// Fee). Same ownership rule as the ETC entries above, plus: a month whose
// standard sheet was submitted in-app (StandardSheetSnapshot exists) is
// app-owned and never overwritten.
async function syncCategoryPoolHistory(
  monthByPeriodName: Map<string, string>,
  etcAppOwned: Set<string>,
): Promise<{ poolMonthsRefreshed: string[]; poolRowsWritten: number; poolMonthsOwnedWithPbiHistoryNow: string[]; poolEntriesReconciled: number }> {
  // Pool history now comes DIRECTLY from the Fabric warehouse's dbo.StandardFees
  // (a complete mirror of Power BI's 'Standard Fees' table — verified
  // 2026-07-19 to match the app's PBI-sourced pools to the cent across every
  // archived month), not Power BI's dataset. This removes the pool history's
  // dependency on Power BI's scheduled refresh entirely. Warehouse rows are
  // mapped into the exact StandardFeesRow shape the logic below already uses,
  // so the grouping/reconcile/ownership rules are byte-for-byte unchanged.
  const [whFees, whPeriods, snapshotMonths] = await Promise.all([
    queryWarehouse<{
      ETCPeriodKey: number;
      BillingGroup: string;
      Department: string;
      PreviousMonthPulledHours: number | null;
      NewHoursAddedThisMonth: number | null;
      HoursAvailable: number | null;
      HoursWorkedThisMonth: number | null;
      PulledHours: number | null;
      NewETCHours: number | null;
      Rate: number | null;
      StandardFee: number | null;
    }>(`SELECT ETCPeriodKey, BillingGroup, Department, PreviousMonthPulledHours, NewHoursAddedThisMonth,
          HoursAvailable, HoursWorkedThisMonth, PulledHours, NewETCHours, Rate, StandardFee
        FROM [dbo].[StandardFees]`),
    queryWarehouse<{ Key: number; Name: string }>(`SELECT [Key], [Name] FROM [dbo].[EstimateToClosePeriod]`),
    prisma.standardSheetSnapshot.findMany({ distinct: ["month"], select: { month: true } }),
  ]);

  const sfRows: StandardFeesRow[] = whFees.map((r) => ({
    "Standard Fees[ETC Period Key]": r.ETCPeriodKey,
    "Standard Fees[Billing Group]": r.BillingGroup,
    "Standard Fees[Department]": r.Department,
    "Standard Fees[Previous Month Pulled Hours]": r.PreviousMonthPulledHours,
    "Standard Fees[New Hours Added this Month]": r.NewHoursAddedThisMonth,
    "Standard Fees[Hours Available]": r.HoursAvailable,
    "Standard Fees[Hours Worked this Month]": r.HoursWorkedThisMonth,
    "Standard Fees[Hours being pulled this month]": r.PulledHours,
    "Standard Fees[New ETC Hours]": r.NewETCHours,
    "Standard Fees[Rate]": r.Rate,
    "Standard Fees[Standard Fee]": r.StandardFee,
  }));
  const periodKeyRows = whPeriods.map((p) => ({ Key: p.Key, Name: p.Name }));

  const monthByKey = new Map(periodKeyRows.map((p) => [p.Key, monthByPeriodName.get(p.Name)]));
  const appOwnedPoolMonths = new Set([...etcAppOwned, ...snapshotMonths.map((s) => s.month)]);

  // Same gap as the ETC ownership rule above: once a month has a
  // StandardSheetSnapshot (or app-owned EtcEntry), it's skipped here forever,
  // even after Power BI later publishes real 'Standard Fees' archive rows for
  // it. Reconciled below instead of silently trusting a frozen submission.
  const { rowsByMonth, ownedWithHistoryNow: poolMonthsOwnedWithPbiHistoryNow, ownedRowsByMonth } = groupStandardFeesRows(
    sfRows,
    (r) => monthByKey.get(r["Standard Fees[ETC Period Key]"]),
    appOwnedPoolMonths
  );

  const poolMonthsRefreshed: string[] = [];
  let poolRowsWritten = 0;

  for (const [month, rows] of [...rowsByMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const data = rows.flatMap((r) => {
      const category = POOL_CATEGORY[`${r["Standard Fees[Billing Group]"]}|${r["Standard Fees[Department]"]}`];
      if (!category) return [];
      return [
        {
          category,
          month,
          previousMonthPulledHours: round2(r["Standard Fees[Previous Month Pulled Hours]"] ?? 0),
          newHoursAddedThisMonth: round2(r["Standard Fees[New Hours Added this Month]"] ?? 0),
          hoursAvailable: round2(r["Standard Fees[Hours Available]"] ?? 0),
          hoursWorkedThisMonth: round2(r["Standard Fees[Hours Worked this Month]"] ?? 0),
          hoursPulledThisMonth: round2(r["Standard Fees[Hours being pulled this month]"] ?? 0),
          newEtcHours: round2(r["Standard Fees[New ETC Hours]"] ?? 0),
          rate: round2(r["Standard Fees[Rate]"] ?? 0),
          standardFee: round2(r["Standard Fees[Standard Fee]"] ?? 0),
          source: "power_bi_history",
        },
      ];
    });
    if (data.length === 0) continue;

    await prisma.$transaction(async (tx) => {
      await tx.categoryPool.deleteMany({ where: { month } });
      await tx.categoryPool.createMany({ data });
    });
    poolMonthsRefreshed.push(month);
    poolRowsWritten += data.length;
  }

  // Reconcile app-owned months Power BI now has an archive for — but only
  // the pure Power-BI-fact fields (Previous Pulled / New Added / Available /
  // Worked). hoursPulledThisMonth and rate are the manager's own decision,
  // and newEtcHours/standardFee are the frozen dollar output derived from
  // them at submit time (savePools in standard-sheet-actions.ts) — all four
  // feed directly into that month's committed Standard Fees dollars
  // (calcStandardFeeEngineering/Shop), so none of the four are ever
  // recomputed or overwritten here, even though hoursAvailable moving means
  // hoursAvailable may no longer arithmetically equal hoursPulledThisMonth +
  // newEtcHours for a reconciled historical row — expected, not a bug: the
  // dollar figure that was actually reviewed and submitted must never change.
  let poolEntriesReconciled = 0;
  for (const [month, rows] of ownedRowsByMonth) {
    for (const r of rows) {
      const category = POOL_CATEGORY[`${r["Standard Fees[Billing Group]"]}|${r["Standard Fees[Department]"]}`];
      if (!category) continue;
      const existing = await prisma.categoryPool.findUnique({ where: { category_month: { category: category as never, month } } });
      if (!existing) continue; // never insert a new pool row into an app-owned month

      const previousMonthPulledHours = round2(r["Standard Fees[Previous Month Pulled Hours]"] ?? 0);
      const newHoursAddedThisMonth = round2(r["Standard Fees[New Hours Added this Month]"] ?? 0);
      const hoursAvailable = round2(r["Standard Fees[Hours Available]"] ?? 0);
      const hoursWorkedThisMonth = round2(r["Standard Fees[Hours Worked this Month]"] ?? 0);

      const unchanged =
        Math.abs(Number(existing.previousMonthPulledHours) - previousMonthPulledHours) < 0.005 &&
        Math.abs(Number(existing.newHoursAddedThisMonth) - newHoursAddedThisMonth) < 0.005 &&
        Math.abs(Number(existing.hoursAvailable) - hoursAvailable) < 0.005 &&
        Math.abs(Number(existing.hoursWorkedThisMonth) - hoursWorkedThisMonth) < 0.005;
      if (unchanged) continue;

      await prisma.categoryPool.update({
        where: { id: existing.id },
        data: { previousMonthPulledHours, newHoursAddedThisMonth, hoursAvailable, hoursWorkedThisMonth },
      });
      poolEntriesReconciled++;
    }
  }

  return { poolMonthsRefreshed, poolRowsWritten, poolMonthsOwnedWithPbiHistoryNow, poolEntriesReconciled };
}

// (The name -> month helper that used to live here moved to etc-period.ts,
// where it is now a fallback for periods with no Begin Date rather than the
// primary mapping.)
