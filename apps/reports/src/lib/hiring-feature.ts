// Hiring Positions is decommissioned until it is automated (2026-10-02, by
// request): the Employees page neither reads the Paylocity Recruiting workbook
// nor shows any hiring UI — no Hiring Positions summary or list, no position
// drawers, no Open Positions / Planned Headcount, no openings on department
// cards. The code, its data (HiringPositionAssignment) and its permission stay,
// so bringing it back is this one line.
export const HIRING_POSITIONS_ENABLED = false;
