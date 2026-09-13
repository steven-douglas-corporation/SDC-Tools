import { EMPLOYEE_TEAMS, teamFor } from "@/lib/employee-teams";

// Department card colors for the Employees tab (2026-08-18 redesign), matched
// as closely as possible to the SDC Scheduler's own Departments board
// (public/app.js's DISCIPLINES array) — a pastel band + a darker on-band text
// color per department, same palette family Scheduler already uses for the
// same departments. Deliberately a SEPARATE table from employee-teams.ts's
// own `theme` field: that one is this app's SDC-brand-color scheme, shared by
// three other features (Hours, ETC department ordering) that were never
// asked to be re-themed — changing it there would recolor screens nobody
// asked to touch.
export type CardColors = { bg: string; text: string };

const CARD_COLORS: Record<string, CardColors> = {
  pm: { bg: "#e9d5ff", text: "#581c87" },
  mech: { bg: "#bfdbfe", text: "#1e3a8a" },
  controls: { bg: "#bbf7d0", text: "#14532d" },
  build: { bg: "#fed7aa", text: "#7c2d12" },
  wire: { bg: "#fef08a", text: "#713f12" },
  service: { bg: "#99f6e4", text: "#134e4a" },
  // General Engineering (2026-08-24). A blue, keeping it visually in the
  // Engineering family it rolls up into, but distinct from Mechanical's.
  geneng: { bg: "#c7d2fe", text: "#1e3a8a" },
  mfgops: { bg: "#c7d2fe", text: "#312e81" },
  growth: { bg: "#fecdd3", text: "#881337" },
  finance: { bg: "#d9f99d", text: "#365314" },
  sales: { bg: "#fbcfe8", text: "#831843" },
  exec: { bg: "#f5d0fe", text: "#701a75" },
  // Operations got a card of its own on 2026-08-24 (see HIDDEN_DEPARTMENT_CARDS
  // below). The slate tone is the value Scheduler's own Departments board
  // already uses for Operations — the same one OTHER_COLORS carries — so this
  // is the established color for this department, named explicitly now that it
  // is a card rather than falling through to the neutral default.
  operations: { bg: "#e2e8f0", text: "#1e293b" },
};

// Anything not in the map above — a genuinely unknown department, or the
// no-department bucket — gets this neutral tone rather than an arbitrary
// color. Same value Scheduler itself uses for "Operations".
const OTHER_COLORS: CardColors = { bg: "#e2e8f0", text: "#1e293b" };

export const NO_DEPARTMENT = "No department";

// Non-team departments that don't get a card of their own. Returning null here
// means "on no card", so anyone in one of these appears in the toolbar totals
// and the department filter but on no card — which is exactly why Operations
// was removed from this set on 2026-08-24: the request asks for an Operations
// card, and its one employee was previously reachable on no card at all.
//
// "unassigned" stays hidden. It is not a department — it is the absence of one,
// and it has its own NO_DEPARTMENT bucket below.
const HIDDEN_DEPARTMENT_CARDS = new Set(["unassigned"]);

export type EmployeeGroup = {
  key: string;
  title: string;
  colors: CardColors;
};

// Growth/Business Development has no `team` code from Scheduler (it isn't a
// delivery team Scheduler schedules work through) and its people are split
// across two department spellings in real data — "Growth / Business
// Development" and "Business Development" — that teamFor() can't resolve
// into one bucket. Matched here the same way employee-teams.ts matches its
// own departments: case-insensitive, against every known spelling.
const GROWTH_DEPARTMENTS = new Set(["growth / business development", "business development", "growth"]);
const GROWTH_DISCIPLINE = "growth / business development";

function matchesGrowth(r: { department?: string | null; discipline?: string | null }): boolean {
  const dept = r.department?.trim().toLowerCase();
  if (dept && GROWTH_DEPARTMENTS.has(dept)) return true;
  return r.discipline?.trim().toLowerCase() === GROWTH_DISCIPLINE;
}

// Back-office departments Scheduler's own board also colors, even though
// they aren't delivery teams — matched the same case-insensitive way.
const NAMED_OTHER: { match: (dept: string) => boolean; key: string; title: string }[] = [
  { match: (d) => d === "finance", key: "finance", title: "Finance" },
  { match: (d) => d === "sales", key: "sales", title: "Sales" },
  { match: (d) => d === "executive leadership", key: "exec", title: "Executive Leadership" },
  // NOT the same department as "Manufacturing Operations", which is a Shop
  // delivery team resolved by teamFor() above and never reaches this list.
  { match: (d) => d === "operations", key: "operations", title: "Operations" },
];

/**
 * Which card a row belongs to, or null if it belongs to none (hidden
 * departments like Operations/Unassigned). Reuses teamFor() for the seven
 * delivery teams — same department-spelling/discipline fallback logic
 * EmployeesTable.tsx already relied on — then layers Growth and the named
 * back-office departments on top, then a raw-department/"No department"
 * catch-all, exactly matching the prior table's grouping so nobody moves
 * cards by accident.
 */
export function resolveEmployeeGroup(
  r: { team?: string | null; department?: string | null; discipline?: string | null },
): EmployeeGroup | null {
  const team = teamFor(r);
  if (team) return { key: team.schedulerCode, title: team.name, colors: CARD_COLORS[team.schedulerCode] ?? OTHER_COLORS };

  if (matchesGrowth(r)) return { key: "growth", title: "Growth / Business Development", colors: CARD_COLORS.growth };

  const dept = r.department?.trim();
  const key = dept && dept !== "—" ? dept : NO_DEPARTMENT;
  if (HIDDEN_DEPARTMENT_CARDS.has(key.toLowerCase())) return null;

  const named = NAMED_OTHER.find((n) => n.match(key.toLowerCase()));
  if (named) return { key: named.key, title: named.title, colors: CARD_COLORS[named.key] };

  return { key, title: key, colors: OTHER_COLORS };
}

// Canonical card order: the seven delivery teams in the order work moves
// through them (employee-teams.ts), then Growth and the named back-office
// departments, then any other real department A→Z, with "No department"
// forced last — same ordering rule EmployeesTable.tsx used for its "extras".
export function compareGroupOrder(a: string, b: string): number {
  const fixed = [...EMPLOYEE_TEAMS.map((t) => t.schedulerCode), "growth", "sales", "finance", "exec", "operations"];
  const ai = fixed.indexOf(a);
  const bi = fixed.indexOf(b);
  if (ai !== -1 || bi !== -1) return (ai === -1 ? fixed.length : ai) - (bi === -1 ? fixed.length : bi);
  if (a === NO_DEPARTMENT) return 1;
  if (b === NO_DEPARTMENT) return -1;
  return a.localeCompare(b);
}
