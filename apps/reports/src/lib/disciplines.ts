// The team-grouping vocabulary shared with the SDC Scheduler.
//
// The Scheduler stores short codes on team_members.discipline; ETC stores the
// full label on Employee.discipline. Both sides must agree, and this used to be
// three hand-kept copies in this repo (the Employees page list, the integration
// route's allowlist, and the sync map) each carrying a "must match" comment.
// One definition instead, so adding a bucket is a single edit here.
//
// Mirrored by: DISCIPLINES in the Scheduler's public/app.js and
// TEAM_DISCIPLINES / ETC_DISCIPLINE_LABEL in its routes/team.js. Those are a
// separate app, so the two lists still have to be changed together — but each
// app now has exactly one place to change.
//
// v2 (2026-07-29): extended from the five delivery teams to one bucket per
// company department, matching Employee_Department_Map.xlsx.
export const DISCIPLINE_LABEL: Record<string, string> = {
  pm: "Project Management",
  mech: "Mechanical Engineers",
  controls: "Controls Engineers",
  build: "Builders",
  wire: "Electricians",
  service: "Service Engineering",
  mfgops: "Manufacturing Operations",
  ops: "Operations",
  finance: "Finance",
  growth: "Growth / Business Development",
  sales: "Sales",
  exec: "Executive Leadership",
};

// Display/edit order for the Employees page dropdown — delivery teams first,
// since those are the ones most rows use.
export const DISCIPLINE_LABELS: string[] = Object.values(DISCIPLINE_LABEL);

// Accept-list for the Scheduler → ETC push (api/integration/employees PATCH).
export const DISCIPLINE_LABEL_SET: ReadonlySet<string> = new Set(DISCIPLINE_LABELS);
