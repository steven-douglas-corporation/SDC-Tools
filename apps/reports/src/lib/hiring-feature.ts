// Hiring Positions is back on (2026-10-07) now that it is automated: open
// positions come from the DataWarehouse (lib/hiring-warehouse.ts) rather than
// the Job.xlsx workbook. Set this to false to take the Employees page's hiring
// UI away again (no Hiring Positions summary or list, no position drawers, no
// openings on department cards); the code, its data (HiringPositionAssignment)
// and its permission all stay.
export const HIRING_POSITIONS_ENABLED = true;
