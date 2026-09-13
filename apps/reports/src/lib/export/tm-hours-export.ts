import { getTmHoursDrillRows, resolveTmJobPks, type TmHoursDrillKey, type TmHoursDrillRow } from "@/lib/tm-hours";
import { TM_HOURS_KEYS, TM_HOURS_LABELS } from "@/lib/tm-hours-classify";
import { filterTmDrillRows, normalizeTmDrillQuery } from "@/lib/tm-drill-search";
import { isValidDateRange, sanitizeJobIds } from "@/lib/tm-drill-validate";
import type { CellValue, SheetColumn, SheetSpec } from "@/lib/export/sheet";

// ── One T&M Hours card's drill-through, as a spreadsheet (2026-09-08) ───────
//
// Same pipeline as Projects/Monthly ETC/Hours (SheetSpec -> buildCsv/buildXlsx),
// and — the point — the SAME row source the panel itself renders:
// getTmHoursDrillRows, via the same resolveTmJobPks. There is no second query
// here, so "the file matches the table" is structural rather than a promise, the
// same guarantee hours-export.ts gets from sharing hours-filters.ts.
//
// ── The search box is a parameter, and that is deliberate ──────────────────
//
// The drill panel narrows rows client-side with its own search box, and that
// string is not in the page URL. Ignoring it would have made the export quietly
// disagree with the table in the one case a user is most likely to export from:
// having just searched for something. So `q` is forwarded and applied here
// through lib/tm-drill-search.ts — the SAME predicate the panel filters with,
// not a re-statement of it. See that file's header for why it is shared.
//
// The panel's SORT is not forwarded, and that is also deliberate: the sheet is
// emitted in getTmHoursDrillRows' own order (workDate desc, then section), which
// is the panel's default. Column sort is client state that a spreadsheet can
// reproduce natively in one click, unlike a filter, which changes which rows
// exist. Same line hours-export.ts draws around expanded tree nodes.
//
// ── Totals ─────────────────────────────────────────────────────────────────
//
// The totals row sums the EXPORTED rows, not a separate DB aggregate. That is
// the right choice specifically here, and the opposite of what hours-export.ts
// does: this sheet's whole scope is one card's drill after an optional text
// search, so there is no independent server-side aggregate of "that card, minus
// the rows the search box hid" to reconcile against. Summing the rows in the
// file is therefore exactly the figure the panel's own footer shows.
//
// One caveat carried forward honestly: getTmHoursDrillRows caps at MAX_ROWS
// (4000) and reports `truncated`. A truncated export would show a total for the
// rows present rather than for the whole selection, so it is refused outright
// below instead of silently shipping a short file.

export type TmHoursExportParams = {
  key?: string;
  jobs?: string;
  from?: string;
  to?: string;
  q?: string;
};

export type TmHoursExportResult = { spec: SheetSpec; rowCount: number; cardLabel: string };

/** Rejects anything not one of the five real card keys — same guard the drill action applies. */
function parseKey(raw: string | undefined): TmHoursDrillKey {
  if (!raw || !TM_HOURS_KEYS.includes(raw as TmHoursDrillKey)) {
    throw new Error(`Invalid drill key "${raw ?? ""}".`);
  }
  return raw as TmHoursDrillKey;
}

const COLUMNS: SheetColumn[] = [
  { header: "Date", type: "date", width: 12 },
  { header: "Employee", type: "text", width: 24 },
  { header: "Department", type: "text", width: 20 },
  // Headers match the panel's own column labels exactly ("Job ID", "Job /
  // Machine", "Function Name"), not the underlying field names — the file has to
  // be recognisable as the table it came from.
  { header: "Job ID", type: "text", width: 14 },
  { header: "Job / Machine", type: "text", width: 34 },
  { header: "Section", type: "text", width: 12 },
  { header: "Section Name", type: "text", width: 26 },
  { header: "Function", type: "text", width: 12 },
  { header: "Function Name", type: "text", width: 30 },
  { header: "Hours", type: "hours", width: 10 },
];

function rowCells(r: TmHoursDrillRow): CellValue[] {
  return [
    // Already a yyyy-mm-dd string from the drill; handed over as-is rather than
    // re-parsed into a Date, so the sheet cannot shift it by a timezone.
    r.date ?? null,
    r.employee || null,
    r.department || null,
    r.jobId || null,
    r.jobName || null,
    r.rawSection || null,
    r.rawSectionName || null,
    r.rawFunction || null,
    r.standardTaskDescription || null,
    r.hours,
  ];
}

export async function buildTmHoursExport(params: TmHoursExportParams, now: Date): Promise<TmHoursExportResult> {
  const key = parseKey(params.key);
  const startDate = params.from ?? "";
  const endDate = params.to ?? "";
  if (!isValidDateRange(startDate, endDate)) throw new Error("Invalid date range.");

  const jobIds = sanitizeJobIds((params.jobs ?? "").split(",").filter(Boolean));
  const jobPks = await resolveTmJobPks(jobIds);
  const { rows: allRows, truncated } = await getTmHoursDrillRows(jobPks, startDate, endDate, key);
  if (truncated) {
    // Loud rather than short. A file quietly missing rows past the cap is worse
    // than no file, because nothing downstream can tell it was clipped.
    throw new Error("This selection exceeds the 4,000-row drill limit — narrow the date range or job selection and export again.");
  }

  const q = normalizeTmDrillQuery(params.q);
  const rows = filterTmDrillRows(allRows, q);
  const cardLabel = TM_HOURS_LABELS[key];

  const totalHours = rows.reduce((sum, r) => sum + r.hours, 0);
  const totals: CellValue[] = [null, null, null, null, null, null, null, null, "Total", totalHours];

  const subtitle = [
    `Card: ${cardLabel}`,
    `Range: ${startDate} to ${endDate}`,
    `Jobs: ${jobIds.length > 0 ? jobIds.join(", ") : "All"}`,
  ];
  // Stated in the file, not just implied by the row count — someone opening this
  // later needs to know it is a filtered subset rather than the whole card.
  if (q) subtitle.push(`Search: "${params.q?.trim()}" (${rows.length} of ${allRows.length} rows)`);
  // Same stamp format hours-export.ts uses, so the two files read alike.
  subtitle.push(`Exported ${now.toISOString().slice(0, 16).replace("T", " ")} — ${rows.length} punch${rows.length === 1 ? "" : "es"}`);

  const spec: SheetSpec = {
    sheetName: `T&M - ${cardLabel}`,
    title: `T&M — ${cardLabel}`,
    subtitle,
    columns: COLUMNS,
    rows: rows.map(rowCells),
    totals,
    // Date + Employee identify a punch row at a glance when scrolling right.
    freezeColumns: 2,
  };

  return { spec, rowCount: rows.length, cardLabel };
}
