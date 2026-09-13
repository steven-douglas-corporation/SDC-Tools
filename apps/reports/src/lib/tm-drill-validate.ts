// Pure request-shape validation for the T&M drill-through actions — split out
// from tm-drill-actions.ts because that file has `"use server"` and
// value-imports tm-report.ts (the Node-only Power BI client) and tm-hours.ts
// (`server-only` + Prisma) at module scope, either of which throws the
// moment a plain node:test file imports it (same constraint as
// tm-hours-classify.ts's own split from tm-hours.ts). This file imports
// nothing, so it's directly unit-testable.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Job ids reach either a DAX string literal (escaped by buildTmFilters) or a
// Prisma `jobId: { in: [...] }` filter (parameterized by the driver, not
// string-built) — bounded either way so a crafted request can't ask for an
// unbounded list.
export function sanitizeJobIds(jobIds: string[]): string[] {
  return jobIds.filter((s) => typeof s === "string" && s.length > 0 && s.length <= 20).slice(0, 500);
}

// Real calendar dates, not just the right shape — "2026-02-30" matches
// ISO_DATE but `new Date(...)` silently rolls it over to March 2, which would
// quietly query the wrong 24 hours rather than fail loudly.
export function isValidCalendarDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isValidDateRange(startDate: string, endDate: string): boolean {
  return isValidCalendarDate(startDate) && isValidCalendarDate(endDate);
}

// ── The T&M page's date-range resolution ────────────────────────────────────
//
// Lives here, pure and tested, rather than inline in tm/page.tsx, because it is
// the whole correctness of that page's filter and it had two bugs while it was
// four untested lines in a server component:
//
//   1. It validated SHAPE only (/\d{4}-\d{2}-\d{2}/), so "2026-02-30" was
//      accepted and new Date() rolled it to March 2 — querying days the user
//      never selected, while the drill actions rejected the same input. Summary
//      and detail disagreed on what a valid range even was.
//   2. An endpoint that failed validation fell back to the DEFAULT, discarding
//      the other endpoint the user had already chosen. Since a date input reports
//      value="" mid-edit, editing one end reset the whole window.
//
// `fallback*` is used only when an endpoint is absent or unusable — never to
// override one that parses. An inverted range is read in the order that can
// match records rather than returning a silent zero.
export type TmDateRange = { startDate: string; endDate: string };

export function resolveTmDateRange(
  start: string | undefined,
  end: string | undefined,
  fallbackStart: string,
  fallbackEnd: string,
): TmDateRange {
  const startDate = start && isValidCalendarDate(start) ? start : fallbackStart;
  const endDate = end && isValidCalendarDate(end) ? end : fallbackEnd;
  return startDate > endDate ? { startDate: endDate, endDate: startDate } : { startDate, endDate };
}
