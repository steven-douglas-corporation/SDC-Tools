import { prisma } from "@/lib/prisma";
import { ETC_SECTIONS, PARTS_COST_SECTION } from "@/lib/sections";
import { isSdcCustomer } from "@/lib/job-filters";
import { getEtcMonthJobWhere } from "@/lib/etc-month-jobs";
import {
  calcHoursLeft,
  effectiveNewEtc,
  isValidMonth,
  newEtcDiff,
  newEtcSeedText,
  round2,
  suggestNewEtc,
  type NewEtcCellState,
} from "@/lib/etc";
import type { CellValue, SheetColumn, SheetSpec } from "@/lib/export/sheet";

// ── The Monthly ETC grid, as a spreadsheet (§24.4) ────────────────────────────
//
// The whole month, every department section, every sub-column — including the ones the
// on-screen table only reaches by scrolling sideways, which is most of them. 13 sections
// × 5 columns + Parts Cost + the identifying columns, and the same grand-total row the
// grid prints at the bottom.
//
// Two rules it shares with the grid rather than reimplementing, because a spreadsheet
// that disagrees with the screen is worse than no spreadsheet:
//
//   * New ETC is what the CELL WOULD SHOW — newEtcSeedText — so a cleared cell exports
//     BLANK, not as the suggestion it would submit as. That is the §16 distinction
//     carried through to Excel, and it is why the column can be read as a checklist.
//   * Diff is newEtcDiff(), which counts an undecided cell as contributing nothing. The
//     grid, the KPI cards, the live totals and now the export all call one function.
//
// `monthComplete` is passed as true for the seed: the export is a record of the month,
// not a mid-month draft view, and the on-screen "wait for the actuals before filling a
// non-zero carry-forward" rule would otherwise blank cells in the file that the reader
// can plainly see on the page.

export type EtcExportResult = { spec: SheetSpec; rowCount: number; monthLabel: string };

const SUB_COLUMNS = [
  { header: "Prior ETC", type: "hours" as const },
  { header: "Hours Worked Month", type: "hours" as const },
  { header: "Hours Left", type: "hours" as const },
  { header: "New ETC", type: "hours" as const },
  { header: "Diff", type: "hours" as const },
];

export function etcMonthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long" })} ${y}`;
}

export async function buildEtcExport(
  month: string,
  // The page's own row filter, so the export matches the view (§24.2). Absent = both.
  billablesParam: string | undefined,
  now: Date,
): Promise<EtcExportResult> {
  if (!isValidMonth(month)) throw new Error(`"${month}" is not a valid month.`);

  const { where } = await getEtcMonthJobWhere(month);
  const jobs = await prisma.job.findMany({
    where,
    include: { etcEntries: { where: { month } } },
    orderBy: { jobId: "asc" },
  });

  // Same Billable/Non-Billable row filter the grid applies, including the rule that
  // SDC's own projects read as Non-Billable whatever the stored flag says.
  const options = ["Billable", "Non-Billable"];
  const selected = billablesParam === undefined ? options : billablesParam.split(",").filter(Boolean);
  const showBillable = selected.includes("Billable");
  const showNonBillable = selected.includes("Non-Billable");
  const visible = jobs.filter((j) => {
    const effective = j.billable && !isSdcCustomer(j.customer);
    return (effective && showBillable) || (!effective && showNonBillable);
  });

  const columns: SheetColumn[] = [
    { header: "Job Id", type: "text", width: 12 },
    { header: "Job Name", type: "text", width: 38 },
    { header: "Customer", type: "text", width: 24 },
    { header: "Status", type: "text", width: 12 },
    { header: "Billable", type: "text", width: 12 },
    // "Why is this row flagged" — the export's stand-in for the yellow highlighting
    // (§24.4). A colour cannot survive a CSV, so the REASON is a column.
    { header: "Needs New ETC", type: "text", width: 14 },
  ];
  for (const s of ETC_SECTIONS) {
    for (const sub of SUB_COLUMNS) {
      columns.push({ header: sub.header, group: `${s.name} (${s.billingGroup})`, type: sub.type });
    }
  }
  // Parts Cost is MONEY in the same shape as an hours section.
  for (const sub of [
    { header: "Prior ETC", type: "currency" as const },
    { header: "Money Spent Month", type: "currency" as const },
    { header: "Money Left", type: "currency" as const },
    { header: "New ETC", type: "currency" as const },
    { header: "Diff", type: "currency" as const },
  ]) {
    columns.push({ header: sub.header, group: "Parts Cost", type: sub.type });
  }

  const rows: CellValue[][] = [];
  const totalsByIndex = new Map<number, number>();
  const addTotal = (i: number, v: number | null) => {
    if (v === null || !Number.isFinite(v)) return;
    totalsByIndex.set(i, (totalsByIndex.get(i) ?? 0) + v);
  };

  for (const job of visible) {
    const byCode = new Map(job.etcEntries.map((e) => [e.section, e]));
    const row: CellValue[] = [
      job.jobId,
      job.jobName,
      job.customer ?? null,
      job.status,
      job.billable && !isSdcCustomer(job.customer) ? "Billable" : "Non-Billable",
      null, // filled in below, once the cells are known
    ];
    let needsCount = 0;
    let i = 6;

    const pushCell = (entry: (typeof job.etcEntries)[number] | undefined, money: boolean) => {
      if (!entry) {
        // A section the job was never quoted for. Zeroes for the facts (no prior
        // estimate, no time booked) and BLANK for the two judgement columns, which is
        // exactly what the grid shows.
        row.push(0, 0, 0, null, null);
        addTotal(i, 0);
        addTotal(i + 1, 0);
        addTotal(i + 2, 0);
        i += 5;
        return;
      }
      const prior = Number(entry.priorEtc);
      const worked = round2(Number(entry.hoursWorked));
      const left = calcHoursLeft(prior, worked);
      const state: NewEtcCellState = {
        priorEtc: prior,
        hoursWorked: worked,
        draft: entry.newEtcDraft != null ? Number(entry.newEtcDraft) : null,
        confirmed: entry.submittedAt != null ? round2(Number(entry.newEtc)) : null,
        cleared: entry.newEtcClearedAt != null,
        locked: !entry.needsReview,
        monthComplete: true,
        precision: money ? "exact" : "whole",
      };
      // What the cell shows — blank included. NOT effectiveNewEtc, which falls back to
      // the suggestion because that is what a blank would SUBMIT as; the export is a
      // picture of the sheet, and a blank cell is information.
      const seed = newEtcSeedText(state);
      const shown: number | null = seed.trim() === "" ? null : Number(seed);
      const diff = newEtcDiff(entry);
      if (shown === null && worked !== 0 && entry.needsReview) needsCount++;
      row.push(prior, worked, left, shown, diff);
      addTotal(i, prior);
      addTotal(i + 1, worked);
      addTotal(i + 2, left);
      // The New ETC total sums what the month would SUBMIT as (effectiveNewEtc), which
      // is what the grid's own total row does — a column of blanks would otherwise total
      // to less than the month is planned at.
      addTotal(i + 3, effectiveNewEtc(entry));
      addTotal(i + 4, diff);
      i += 5;
    };

    for (const s of ETC_SECTIONS) pushCell(byCode.get(s.code), false);
    pushCell(byCode.get(PARTS_COST_SECTION), true);

    row[5] = needsCount > 0 ? `${needsCount} cell${needsCount === 1 ? "" : "s"} awaiting New ETC` : null;
    rows.push(row);
  }

  // Rounded on the way out: summing 49 rows of Decimal-derived floats produces
  // 1572.6299999999999, and a spreadsheet showing that in its totals row invites the
  // reader to distrust every other figure in the file. round2 is the app's own rounding
  // (lib/etc.ts), so the export agrees with the screen.
  const totals: CellValue[] = columns.map((_, idx) => {
    if (idx === 0) return `TOTAL (${rows.length} jobs)`;
    const v = totalsByIndex.get(idx);
    return v === undefined ? null : round2(v);
  });

  const label = etcMonthLabel(month);
  return {
    rowCount: rows.length,
    monthLabel: label,
    spec: {
      sheetName: `Monthly ETC - ${label}`,
      title: `Monthly ETC — ${label}`,
      subtitle: [
        `Rows: ${selected.join(" + ") || "(none)"}`,
        `New ETC is shown as the grid shows it — a blank cell is one still awaiting a figure. Diff counts an unanswered cell as nothing.`,
        `Exported ${now.toISOString().slice(0, 16).replace("T", " ")} — ${rows.length} job${rows.length === 1 ? "" : "s"}`,
      ],
      columns,
      rows,
      totals,
      freezeColumns: 2,
    },
  };
}

// Exported for the tests: the seed rule the export depends on, in one place.
export { newEtcSeedText, suggestNewEtc };
