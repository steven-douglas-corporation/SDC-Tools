import "server-only";

import { warehouseConfigured, warehouseSnapshot } from "@/lib/data-warehouse";
import { toHiringPositions, type WarehouseHiringPosition, type WarehouseHiringRow } from "@/lib/hiring-warehouse-parse";

// ── Open positions, read from the DataWarehouse ─────────────────────────────
//
// The Paylocity Recruiting export no longer sits on the share as Job.xlsx: the
// warehouse loader takes it, and "Paylocity"."HiringPosition" is its latest file.
// Same arrangement as the roster and position families (paylocity-warehouse.ts):
// when the warehouse isn't configured or can't be read this throws, and
// hiring-positions.ts turns that into the page's hiring error note while
// positions created inside SDC Reports keep showing. There is no file fallback;
// a stale copy answering for a live requisition list is the failure
// data-warehouse.ts exists to prevent.

export const WAREHOUSE_HIRING_LABEL = 'DataWarehouse "Paylocity"."HiringPosition"';

export async function readHiringPositionsFromWarehouse(): Promise<WarehouseHiringPosition[]> {
  if (!warehouseConfigured()) {
    throw new Error("The DataWarehouse is not configured: set DATAWAREHOUSE_URL in .env.");
  }
  const rows = await warehouseSnapshot((q) =>
    q<WarehouseHiringRow>(
      `SELECT "HiringJobId" AS "hiringJobId", "JobTitle" AS "jobTitle", "HiringDepartment" AS "hiringDepartment",
              "HiringManagers" AS "hiringManagers", "JobStatus" AS "jobStatus", "JobSubStatus" AS "jobSubStatus",
              "PublishedAt" AS "publishedAt"
       FROM "Paylocity"."HiringPosition"
       ORDER BY "PublishedAt" DESC NULLS LAST, "HiringJobId"`,
    ),
  );
  return toHiringPositions(rows);
}
