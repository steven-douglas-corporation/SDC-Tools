import "server-only";

import { warehouseSnapshot } from "@/lib/data-warehouse";

// ── The roster and position families, read from the DataWarehouse ──────────
//
// Each reader returns the same grid the spreadsheet produced (a header row, then
// one row of text cells per record), so parseRosterGrid / parsePositionFamiliesGrid
// apply every rule they always did: the header check, duplicate ids, the
// broken-export guards. Only where the grid comes from has changed — see
// data-warehouse.ts for why.

export const WAREHOUSE_ROSTER_LABEL = 'DataWarehouse "Dimension"."Employee" (current rows)';
export const WAREHOUSE_FAMILIES_LABEL = 'DataWarehouse "Paylocity"."PositionFamily"';

export type WarehouseEmployee = {
  employeeId: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  supervisorEmployeeId: string | null;
  isActive: boolean | null;
  positionCode: string | null;
  positionJobTitle: string | null;
};

/** The roster file's layout, from the employee dimension's current rows. */
export function rosterGrid(employees: WarehouseEmployee[]): unknown[][] {
  return [
    ["Employee Id", "First Name", "Last Name", "Job Title", "Supervisor's Employee ID", "Is Active", "Position Code", "Position Job Title"],
    ...employees.map((e) => [
      e.employeeId,
      e.firstName ?? "",
      e.lastName ?? "",
      e.jobTitle ?? "",
      e.supervisorEmployeeId ?? "",
      e.isActive == null ? "" : e.isActive ? "Yes" : "No",
      e.positionCode ?? "",
      e.positionJobTitle ?? "",
    ]),
  ];
}

/**
 * Everyone in Paylocity's latest roster: the current version of each employee,
 * leaving out anyone the warehouse has soft-deleted because they dropped off the
 * roster — the file never listed them either.
 */
export async function readRosterGridFromWarehouse(): Promise<unknown[][]> {
  const employees = await warehouseSnapshot((q) =>
    q<WarehouseEmployee>(
      `SELECT "EmployeeId" AS "employeeId", "FirstName" AS "firstName", "LastName" AS "lastName",
              "JobTitle" AS "jobTitle", "SupervisorEmployeeId" AS "supervisorEmployeeId", "IsActive" AS "isActive",
              "PositionCode" AS "positionCode", "PositionJobTitle" AS "positionJobTitle"
       FROM "Dimension"."Employee"
       WHERE "IsCurrent" AND NOT "IsDeleted" AND "EmployeeKey" > 0
       ORDER BY "EmployeeId"`,
    ),
  );
  return rosterGrid(employees);
}

export type WarehousePositionFamily = {
  familyCode: string | null;
  familyName: string | null;
  positionCode: string | null;
  title: string | null;
  totalHeadcount: number | null;
};

/** The Position_Families file's layout. */
export function positionFamilyGrid(rows: WarehousePositionFamily[]): unknown[][] {
  return [
    ["Family Code", "Family Name", "Position Code", "Title", "Total Headcount"],
    ...rows.map((r) => [r.familyCode ?? "", r.familyName ?? "", r.positionCode ?? "", r.title ?? "", r.totalHeadcount == null ? "" : String(r.totalHeadcount)]),
  ];
}

/** Paylocity's Position_Families report, latest file. The overrides file is still read from disk. */
export async function readPositionFamilyGridFromWarehouse(): Promise<unknown[][]> {
  const rows = await warehouseSnapshot((q) =>
    q<WarehousePositionFamily>(
      `SELECT "FamilyCode" AS "familyCode", "FamilyName" AS "familyName", "PositionCode" AS "positionCode",
              "Title" AS "title", "TotalHeadcount" AS "totalHeadcount"
       FROM "Paylocity"."PositionFamily"
       ORDER BY "PositionCode", "FamilyCode"`,
    ),
  );
  return positionFamilyGrid(rows);
}
