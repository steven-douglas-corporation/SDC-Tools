import { prisma } from "@/lib/prisma";
import { SECTIONS, PARTS_COST_SECTION, offGridActualHours } from "@/lib/sections";
import { validJobTypeFilter, isSdcCustomer } from "@/lib/job-filters";
import { buildProjectsQuery, sortProjectRows, type ProjectsViewParams } from "@/lib/projects-query";
import { loadActualHoursBySection } from "@/lib/actual-hours";
import { getPartsActualSdcSplitByJob } from "@/lib/sync-totaleto";
import type { PartsActualSdcSplit } from "@/lib/parts-actual-sdc";
import { round2 } from "@/lib/etc";
import { deliveryWeeks } from "@/lib/delivery-weeks";
import type { CellValue, SheetColumn, SheetSpec } from "@/lib/export/sheet";

// ── The Projects grid, as a spreadsheet (§24.3) ───────────────────────────────
//
// Built from the SAME query the page renders (lib/projects-query.ts), so the file a
// manager gets is the table they were looking at: same filters, same statuses, same date
// range, same sort, same SDC-projects-at-the-bottom order.
//
// Every field the grid shows, plus the three derived ones a reader would otherwise have
// to compute by hand (hours remaining per section total, and the two cost variances).
// Deliberately NOT exported: internal primary keys, sync timestamps, the
// `costQuotedManuallyEdited` bookkeeping flags — §24.11 says the export must not carry
// backend-only fields, and a numeric internal id is exactly the kind of thing that ends
// up pasted into a support ticket as if it meant something.

export type ProjectsExportResult = { spec: SheetSpec; rowCount: number; filterLabel: string; asOf: string | null };

// `asOf` (YYYY-MM-DD, already validated by parseAsOf) turns the file into "values through
// that day": actual hours by punch date and Parts Cost actuals by AP invoice date. Null,
// the default, is the live export exactly as it has always been. Nothing here writes
// anything, and the Projects grid never sees this value.
export async function buildProjectsExport(
  sp: ProjectsViewParams,
  now: Date,
  asOf: string | null = null,
): Promise<ProjectsExportResult> {
  // ", through 2026-09-30" in a header when a date is set, nothing otherwise — so a
  // default export's headers are byte-for-byte what they were before the date existed.
  const through = asOf ? `, through ${asOf}` : "";
  // The filter menu's own option lists, loaded exactly as the page loads them — the
  // "no filter means everything" rule needs to know what everything IS.
  const [distinctStatuses, distinctCustomers] = await Promise.all([
    prisma.job.findMany({ where: validJobTypeFilter, distinct: ["status"], select: { status: true } }),
    prisma.job.findMany({ where: validJobTypeFilter, distinct: ["customer"], select: { customer: true } }),
  ]);
  const query = buildProjectsQuery(sp, {
    allStatuses: distinctStatuses.map((s) => s.status),
    allCustomers: distinctCustomers.map((c) => c.customer).filter((c): c is string => c != null),
  });

  const jobs = await prisma.job.findMany({
    where: query.where,
    include: { estimatedHours: true },
    orderBy: { [query.sortKey]: query.sortDir },
  });
  const ordered = sortProjectRows(jobs, query.sortKey, query.sortDir, isSdcCustomer);
  // Actual hours come from actual-hours.ts, not from a join on EtcEntry: a closed
  // month's EtcEntry.hoursWorked is frozen while people keep booking late time, so the
  // join understated every finished job. Same source as the grid's Actuals toggle.
  const actuals = await loadActualHoursBySection(ordered.map((j) => j.id), asOf ?? undefined);

  // ── "Excl. SDC" Parts Cost, calculated live at export time (2026-10-02, by request) ──
  //
  // Steven Douglas Corp. never invoices itself, so a manager comparing Parts Cost against
  // Total ETO wants the actual with SDC's own billing taken out. That is offered HERE and
  // only here: the grid, Job.costActualHistorical and the sync keep SDC in, exactly as
  // before, so nothing on screen moves. One Total ETO query, made inside the export
  // request, never on a page render — the grid cannot slow down because of this.
  //
  // Fail-soft for a LIVE export: if Total ETO does not answer, the file still downloads
  // with these columns blank and says so, because a Projects export that fails outright
  // over an optional comparison is worse than one that is missing it.
  //
  // NOT fail-soft with a date (2026-10-05). The stored actual is a lifetime-to-now figure
  // and cannot be cut at a day, so without Total ETO there is no honest number to put in a
  // "through 2026-09-30" file — and falling back to the stored one would print today's
  // total under a Sep 30 heading. A clear error beats a file that looks right and is not.
  let sdcSplit: Map<string, PartsActualSdcSplit> | null = null;
  try {
    sdcSplit = await getPartsActualSdcSplitByJob(asOf);
  } catch (e) {
    console.error("[projects-export] SDC split unavailable:", e);
    if (asOf) {
      throw new Error(
        `Total ETO did not respond, so Parts Cost as of ${asOf} cannot be calculated. Try again in a minute, or export without a date for the live figures.`,
      );
    }
  }

  // Section columns: quoted and actual hours per section, in the grid's own order.
  const sectionColumns: SheetColumn[] = [];
  for (const s of SECTIONS) {
    if (s.code === PARTS_COST_SECTION) continue;
    sectionColumns.push({ header: "Quoted", group: `${s.name}`, type: "hours" });
    sectionColumns.push({ header: "Actual", group: `${s.name}`, type: "hours" });
    sectionColumns.push({ header: "Remaining", group: `${s.name}`, type: "hours" });
  }
  // The grid's two off-grid columns: actual hours on a code with no section column.
  // Already inside "Actual Hours (total)"; broken out so the section columns plus
  // these two add back up to it.
  sectionColumns.push({ header: "Actual", group: "Service & Spare Parts", type: "hours" });
  sectionColumns.push({ header: "Actual", group: "Other / Unmapped", type: "hours" });

  const columns: SheetColumn[] = [
    { header: "Job Id", type: "text", width: 12 },
    { header: "Project Name", type: "text", width: 38 },
    { header: "Customer", type: "text", width: 26 },
    { header: "Type", type: "text", width: 14 },
    { header: "Status", type: "text", width: 12 },
    { header: "Billable", type: "text", width: 12 },
    { header: "Start Date", type: "date" },
    { header: "Quoted Delivery", type: "date" },
    { header: "Weeks to Delivery", type: "number" },
    { header: "Complete Date", type: "date" },
    { header: "Quoted Hours (total)", type: "hours", width: 14 },
    { header: `Actual Hours (total${through})`, type: "hours", width: 14 },
    { header: "Hours Remaining (total)", type: "hours", width: 16 },
    { header: "Parts Cost Quoted", type: "currency" },
    // ── The basis is IN the header (2026-09-04) ──────────────────────────
    //
    // docs/PARTS-COST-VARIANCE-2026-09.md exists because a column called "Parts Cost
    // Actual" in this export was compared against a column called the same thing in a
    // spreadsheet, and the two were measured on different bases — GL-posted here,
    // everything-billed there. Neither said which, so the difference read as an app
    // error for weeks.
    //
    // The filename already carries todayStamp(now), so the as-of half is answered.
    // This is the other half: a comparison is now either like-for-like or visibly not.
    { header: `Parts Cost Actual (GL-posted${through})`, type: "currency" },
    { header: `Parts Cost Remaining${asOf ? ` (through ${asOf})` : ""}`, type: "currency" },
    // ── Excl. SDC block: live from Total ETO at export time, not stored anywhere ──
    //
    // Same GL-posted basis as the Actual column above (both read the same predicate), with
    // every AP line billed under Steven Douglas Corp. removed. "SDC Credit Card" and
    // "Steven Douglas Corp. Expense Reports" are NOT removed — isSdcVendor refuses them.
    // The last column says, per row, where the figure came from.
    { header: `SDC Billed (GL-posted, ${asOf ? `through ${asOf}` : "lifetime"})`, type: "currency", width: 18 },
    { header: `Parts Cost Actual (GL-posted, excl. SDC${through})`, type: "currency", width: 20 },
    { header: `Parts Cost Remaining (excl. SDC${through})`, type: "currency", width: 18 },
    { header: "Excl. SDC basis", type: "text", width: 42 },
    ...sectionColumns,
  ];

  const rows: CellValue[][] = [];
  // Column totals, accumulated as the rows are built so the footer can never disagree
  // with the body (§24.13.12).
  const totalsByIndex = new Map<number, number>();
  const addTotal = (i: number, v: number | null) => {
    if (v === null || !Number.isFinite(v)) return;
    totalsByIndex.set(i, (totalsByIndex.get(i) ?? 0) + v);
  };

  for (const job of ordered) {
    const quotedBySection = new Map(job.estimatedHours.map((h) => [h.section, Number(h.quotedHours)]));
    const actualBySection = actuals.get(job.id) ?? new Map<string, number>();
    const quotedTotal = [...quotedBySection.entries()]
      .filter(([code]) => code !== PARTS_COST_SECTION)
      .reduce((s, [, v]) => s + v, 0);
    const actualTotal = [...actualBySection.entries()]
      .filter(([code]) => code !== PARTS_COST_SECTION)
      .reduce((s, [, v]) => s + Number(v), 0);
    const costQuoted = job.costQuoted != null ? Number(job.costQuoted) : null;
    const costActual = job.costActualHistorical != null ? Number(job.costActualHistorical) : null;

    // The excl. SDC block. Three cases, each named in the last column so nobody has to
    // guess which kind of number they are looking at:
    //   * Total ETO has AP spend for the job  -> live total minus the SDC share. Computed
    //     entirely from the one live read, so the three figures agree with each other even
    //     if the stored (on-screen) actual has not caught up with a recent invoice; when it
    //     has not, the basis says by how much.
    //   * Total ETO has none, stored is blank/0 -> nothing to exclude.
    //   * Total ETO has none, stored is typed    -> a manually entered historical figure
    //     (116 jobs pre-date Total ETO's data). SDC cannot be separated out of a typed
    //     number, so it is carried through unchanged and labelled as such.
    //
    // With a date (asOf) the "Parts Cost Actual" column itself changes source: the stored
    // value is lifetime-to-the-last-sync and cannot be cut at a day, so every job Total ETO
    // has AP spend for takes its through-date figure from the SAME read the excl. SDC
    // columns use. Actual, SDC Billed and Actual (excl. SDC) therefore come from one query
    // and one cutoff and cannot disagree. A job Total ETO has no AP for (a typed historical
    // figure, or nothing at all) keeps its stored value, which is correct for any date: that
    // spend pre-dates Total ETO's data.
    let sdcBilled: number | null = null;
    let costActualExcl: number | null = null;
    let costRemainingExcl: number | null = null;
    let exclBasis: string;
    const split = sdcSplit?.get(job.jobId);
    const costActualShown = asOf !== null && split ? round2(split.actual) : costActual;
    if (sdcSplit === null) {
      exclBasis = "Unavailable - Total ETO did not respond";
    } else if (split) {
      sdcBilled = round2(split.sdc);
      costActualExcl = round2(split.actual - split.sdc);
      if (asOf !== null) {
        exclBasis = `Total ETO, through ${asOf}`;
      } else {
        const lag = costActual === null ? null : round2(split.actual - costActual);
        exclBasis =
          costActual !== null && lag !== null && Math.abs(lag) < 1
            ? "Total ETO, live"
            : `Total ETO, live (the app's stored actual is ${costActual === null ? "blank" : `$${costActual.toFixed(2)}`}, not yet synced)`;
      }
    } else {
      sdcBilled = 0;
      costActualExcl = costActual;
      exclBasis = (costActual ?? 0) === 0 ? "No Total ETO AP spend" : "Manual historical figure - SDC not separable";
    }
    if (sdcSplit !== null) costRemainingExcl = costQuoted === null ? null : costQuoted - (costActualExcl ?? 0);

    const row: CellValue[] = [
      job.jobId,
      job.jobName,
      job.customer ?? null,
      job.type ?? null,
      job.status,
      // The same effective rule the grid paints rows by: SDC's own projects read as
      // Non-Billable whatever the stored flag says.
      job.billable && !isSdcCustomer(job.customer) ? "Billable" : "Non-Billable",
      job.startDate ?? null,
      job.quotedDeliveryDate ?? null,
      deliveryWeeks(job.startDate?.toISOString().slice(0, 10), job.quotedDeliveryDate?.toISOString().slice(0, 10)),
      job.completeDate ?? null,
      quotedTotal,
      actualTotal,
      quotedTotal - actualTotal,
      costQuoted,
      costActualShown,
      // Blank rather than 0 when there is no quote: "no figure on file" and "nothing
      // left" are different answers, and a 0 here would be the export inventing one.
      costQuoted === null ? null : costQuoted - (costActualShown ?? 0),
      sdcBilled,
      costActualExcl,
      costRemainingExcl,
      exclBasis,
    ];
    // Fixed-column totals.
    addTotal(10, quotedTotal);
    addTotal(11, actualTotal);
    addTotal(12, quotedTotal - actualTotal);
    addTotal(13, costQuoted);
    addTotal(14, costActualShown);
    addTotal(15, costQuoted === null ? null : costQuoted - (costActualShown ?? 0));
    addTotal(16, sdcBilled);
    addTotal(17, costActualExcl);
    addTotal(18, costRemainingExcl);

    // 20, not 14: the four excl. SDC columns above (16-19, after the two delivery columns) sit
    // before the section columns.
    let i = 20;
    for (const s of SECTIONS) {
      if (s.code === PARTS_COST_SECTION) continue;
      const q = quotedBySection.get(s.code) ?? 0;
      const a = Number(actualBySection.get(s.code) ?? 0);
      row.push(q, a, q - a);
      addTotal(i, q);
      addTotal(i + 1, a);
      addTotal(i + 2, q - a);
      i += 3;
    }
    const { service, unmapped } = offGridActualHours(actualBySection);
    row.push(service.total, unmapped.total);
    addTotal(i, service.total);
    addTotal(i + 1, unmapped.total);
    rows.push(row);
  }

  // Rounded, for the same reason as the ETC totals: a summed column of Decimal-derived
  // floats otherwise prints as 1572.6299999999999 and makes the whole file look wrong.
  const totals: CellValue[] = columns.map((_, i) => {
    if (i === 0) return `TOTAL (${rows.length} projects)`;
    const v = totalsByIndex.get(i);
    return v === undefined ? null : round2(v);
  });

  return {
    rowCount: rows.length,
    filterLabel: query.filterLabel,
    asOf,
    spec: {
      sheetName: "Projects",
      title: asOf ? `Projects - values as of ${asOf}` : "Projects",
      subtitle: [
        `Filters: ${describeFilters(query.selected)}`,
        `Sorted by ${query.sortKey} ${query.sortDir}`,
        `Exported ${now.toISOString().slice(0, 16).replace("T", " ")} — ${rows.length} project${rows.length === 1 ? "" : "s"}`,
        ...(asOf
          ? [
              `Values as of ${asOf}: actual hours are counted by punch date and Parts Cost actuals by AP invoice date, through that day, calculated live from today's data. ` +
                `Quoted hours, Parts Cost Quoted, Status and dates are CURRENT values (no history of them is kept), so the Remaining columns compare today's quote with the as-of actual.`,
            ]
          : []),
        sdcSplit === null
          ? "Excl. SDC columns are blank: Total ETO did not respond at export time. The rest of the file is unaffected."
          : `Excl. SDC columns are calculated live from Total ETO at export time (GL-posted AP, Steven Douglas Corp. removed${asOf ? `, through ${asOf}` : ""}); the grid still includes SDC.`,
      ],
      columns,
      rows,
      totals,
      // Job Id + Project Name stay in view when scrolling across the section columns.
      freezeColumns: 2,
    },
  };
}

function describeFilters(selected: {
  types: string[];
  statuses: string[];
  billables: string[];
  customers: string[] | null;
}): string {
  const parts = [
    `status ${selected.statuses.join("/") || "(none)"}`,
    `${selected.billables.join("/") || "(none)"}`,
    `type ${selected.types.join("/")}`,
  ];
  if (selected.customers) parts.push(`customers ${selected.customers.length === 1 ? selected.customers[0] : `${selected.customers.length} selected`}`);
  return parts.join(", ");
}
