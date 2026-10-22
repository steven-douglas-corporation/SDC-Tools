import { hasPermission, type AppRole, type Permission } from "@/lib/permissions";
import { monthBounds } from "@/lib/hours-etc-scope-rules";

// ── The Dashboard's Finances tab: what may be on it (2026-10-20) ─────────────
//
// One rule decides what belongs here: a card shows a figure the app ALREADY shows
// somewhere else, computed by that page's own function, and ends in a link to that
// page. The tab is a set of windows onto existing views, not a place figures get
// defined — so a card here can never disagree with the page behind it, and nothing
// on it is a number a reader cannot trace.
//
// Each card therefore carries the permission of the page it links to. A card is only
// offered to a role that can open its destination (a "More details" link to a page
// you cannot open is a dead end), and the tab itself exists only for a role that can
// see at least one card. No new permission: widening a card is a click on
// /admin/permissions for the page behind it. tests/finance-cards.test.ts pins that
// every href resolves, through permissionForPath, to the permission declared here.

export type FinanceCardKey = "parts-spent" | "tm";

export type FinanceCardDef = {
  key: FinanceCardKey;
  title: string;
  /** Where the figure comes from, in the name the destination page goes by. */
  source: string;
  /** What the destination page requires, so the card is never shown without access to it. */
  permission: Permission;
  /** The destination, already scoped to the Dashboard's month where the page can be. */
  href: (month: string) => string;
};

export const FINANCE_CARDS: readonly FinanceCardDef[] = [
  {
    key: "parts-spent",
    title: "Parts spent",
    source: "Monthly ETC",
    permission: "monthly-etc:view",
    href: (month) => `/etc?month=${month}`,
  },
  {
    key: "tm",
    title: "T&M parts and expenses",
    source: "T&M",
    permission: "tm:view",
    href: (month) => {
      const { from, to } = monthBounds(month);
      return `/tm?start=${from}&end=${to}`;
    },
  },
];

// ── Parts cost vs budget, every job (2026-10-22) ────────────────────────────
//
// The section under "This month" follows the same rule as the cards: every figure is the one the Job
// Details Parts Cost card shows for that job (lib/parts-budget-analysis.ts assembles each job with the
// card's own function), and each row ends in a link to that job's Job Details. So it carries Job Details'
// permission and is only offered to a role that can open it — including its Excel export, which the
// export route gates the same way.
export const PARTS_BUDGET_SECTION = {
  title: "Parts cost vs budget",
  source: "Job Details",
  permission: "job-hour-details:view" as Permission,
  href: (jobId: string) => `/job-hours?jobs=${encodeURIComponent(jobId)}`,
} as const;

export function canSeePartsBudget(role: AppRole | null | undefined): boolean {
  return hasPermission(role, PARTS_BUDGET_SECTION.permission);
}

/** The cards this role may see — each one's destination is a page the role can open. */
export function financeCardsFor(role: AppRole | null | undefined): FinanceCardDef[] {
  return FINANCE_CARDS.filter((c) => hasPermission(role, c.permission));
}
