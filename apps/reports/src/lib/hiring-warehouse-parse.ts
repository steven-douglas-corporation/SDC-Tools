import type { HiringPositionSourceRow } from "@/lib/hiring-workbook-parse";

// The pure half of hiring-warehouse.ts: no database, no "server-only", so the
// mapping rules are directly unit-testable. Same split as
// hiring-workbook-parse.ts / paylocity-roster-parse.ts.
//
// Open positions come from the DataWarehouse's "Paylocity"."HiringPosition" view
// (the Recruiting export, latest file) since Paylocity files stopped living on
// the share. The view carries far less than the old Job.xlsx did: no function
// code, section or location text, no remote/internal flags, no created-by. Those
// stay null/false on the row below; the one new signal is who is hiring.

/** One row of "Paylocity"."HiringPosition", as the reader selects it. */
export type WarehouseHiringRow = {
  hiringJobId: string | null;
  jobTitle: string | null;
  hiringDepartment: string | null;
  hiringManagers: string | null;
  jobStatus: string | null;
  jobSubStatus: string | null;
  publishedAt: Date | null;
};

export type WarehouseHiringPosition = {
  row: HiringPositionSourceRow;
  /** Paylocity employee ids of the hiring managers, in the order the export lists them. */
  managerIds: string[];
};

/**
 * The employee ids in a "Hiring Managers" cell: "Neil Simpson [48003052]" or
 * "Michael Czenszak [48003015], Daniel Belliveau [48003xxx]". The id in the
 * brackets is the same id the roster carries, which is what lets a position
 * borrow its manager's team. A name with no bracketed id contributes nothing.
 */
export function parseManagerIds(managers: string | null | undefined): string[] {
  if (!managers) return [];
  return [...managers.matchAll(/\[(\d+)\]/g)].map((m) => m[1]);
}

/**
 * An evergreen posting rather than a requisition for a seat — "General Job
 * Posting" is Paylocity's catch-all that stays published so unsolicited
 * applicants have somewhere to land. It is never a position to hire for, so it
 * is dropped at the source instead of being hidden after the fact, where it
 * would still count toward Open Positions and Planned Headcount.
 */
export function isEvergreenPosting(title: string | null | undefined): boolean {
  return /^general\s+(job\s+)?posting$/i.test((title ?? "").trim());
}

function usDate(d: Date | null): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/**
 * Warehouse rows to the shape hiring-positions.ts already reconciles. Drops
 * rows with no Job ID or title (nothing to key an assignment on) and evergreen
 * postings, and keeps the first of any repeated Job ID.
 */
export function toHiringPositions(rows: WarehouseHiringRow[]): WarehouseHiringPosition[] {
  const seen = new Set<string>();
  const out: WarehouseHiringPosition[] = [];
  for (const r of rows) {
    const sourceId = r.hiringJobId?.trim();
    const title = r.jobTitle?.trim();
    if (!sourceId || !title) continue;
    if (isEvergreenPosting(title)) continue;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    out.push({
      managerIds: parseManagerIds(r.hiringManagers),
      row: {
        sourceId,
        title,
        status: r.jobStatus?.trim() || "Unknown",
        subStatus: r.jobSubStatus?.trim() || null,
        functionCode: null,
        functionDescription: null,
        sectionCode: null,
        sectionDescription: null,
        hiringDepartment: r.hiringDepartment?.trim() || null,
        workLocDescription: null,
        createdDate: usDate(r.publishedAt),
        createdBy: null,
        modifiedBy: null,
        archived: false,
        archiveDate: null,
        remote: false,
        internal: false,
      },
    });
  }
  return out;
}

/**
 * The department card a position belongs on by default: the card of its first
 * hiring manager who is on the roster. `cardKeyByPaylocityId` maps a Paylocity
 * employee id to the card key that employee sits on (the same key the
 * Employees tab's cards use), so the result slots straight onto that card.
 * Null when no manager resolves — the position is then Unassigned until someone
 * moves it by hand.
 */
export function departmentFromHiringManagers(
  managerIds: readonly string[],
  cardKeyByPaylocityId: ReadonlyMap<string, string>,
): string | null {
  for (const id of managerIds) {
    const key = cardKeyByPaylocityId.get(id);
    if (key) return key;
  }
  return null;
}
