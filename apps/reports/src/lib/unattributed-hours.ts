import "server-only";
import { prisma } from "@/lib/prisma";
import { SECTIONS } from "@/lib/sections";
import { punchIdentity, splitRawPair } from "@/lib/hours-filters";
import {
  UNDEFINED_REASON_LABEL,
  UNDEFINED_REASON_FIX,
  roundedHoursVisible,
  visibleUndefinedTotals,
  type UndefinedReason,
  type UndefinedTotal,
} from "@/lib/undefined-hours-rules";
import type { HoursDetailRow } from "@/lib/job-hours-detail";

// Punch-level detail behind the "Undefined hours" KPI card — the time booked to
// something that isn't a usable job number ("Not Defined", "2026 SERVICE", a job
// number the app has never heard of) and so reaches no figure anywhere on the ETC
// page.
//
// ── What changed on 2026-08-05, and why it was a real defect (§42.11) ───────
//
// This used to recompute the drill from the source on every click, while the KPI card
// read stored totals. Two sources for one number. The previous version of this file
// said so in its own header and called it an acceptable trade-off:
//
//     "this can disagree with the card if the file has changed since the last sync"
//
// It is not acceptable — a card and its own detail stating different numbers is the
// exact failure this app was already bitten by once (DEVLOG §12), and §42.11 requires
// `Undefined Hours KPI = sum of the drill-through rows`, treating any mismatch as a
// calculation failure.
//
// Both now read UndefinedHoursRow, written by ONE pass over ONE import inside ONE
// transaction (lib/paylocity-import.ts). The reconciliation is therefore structural:
// there is no second computation left to disagree.
//
// It is also much faster. The old path called fetchJobHoursRowsWithIssues() per click
// — a live DAX round-trip, measured at ~750ms after an earlier fix and ~4,936ms before
// it. This is one indexed read of a table with a few thousand rows in it.
//
// ── Employee names are NOT stored alongside ─────────────────────────────────
// Only the Paylocity id is persisted; the name, department and supervisor are joined
// at read time. Correcting an employee record therefore fixes every historical drill
// row at once, instead of leaving stale copies behind in a table nobody thinks to
// re-run.

const SECTION_NAME = new Map(SECTIONS.map((s) => [s.code, s.name]));

export type UndefinedGroup = {
  reason: UndefinedReason;
  label: string;
  // What to actually do about it — §42.27 asks the drill for "corrective data needed",
  // and a reason code alone does not say where to go.
  fix: string;
  rows: number;
  hours: number;
  countsTowardKpi: boolean;
};

export type UnattributedDetail = {
  // `job` is REQUIRED here, unlike on HoursDetailRow where it is optional. On a normal
  // punch list the job column is only present when the selection spans jobs; on this
  // one the raw job cell IS the offending value, so a row without it is meaningless.
  rows: (Omit<HoursDetailRow, "job"> & {
    job: string;
    reason: UndefinedReason;
    reasonLabel: string;
    sourceRow: number;
  })[];
  total: number;
  sections: { code: string; name: string; hours: number }[];
  truncated: boolean;
  // What the KPI card shows. Kept in the payload so the panel can display the
  // reconciliation state (§42.28) rather than leaving a reader to compare two numbers
  // on different parts of the screen.
  storedTotal: number;
  // Breakdown by reason, for the drill's grouping control (§42.12).
  groups: UndefinedGroup[];
  // Rejections that are CORRECT exclusions rather than faults — phase 80/90 work the
  // app does not model, the four Standard Fees pool sections. Surfaced separately so
  // §42.7 ("do not silently drop unmatched rows") holds without polluting the KPI.
  excluded: { rows: number; hours: number; groups: UndefinedGroup[] };
  // Distinct people affected — §42.27 asks for this on the Undefined Hours drill
  // specifically, because "12 employees" is what tells you whether it is one person
  // mis-coding or a systemic problem.
  employeesAffected: number;
  // Which file version these rows came from, so the panel can say what it is showing.
  sourceFile: string | null;
  importedAt: Date | null;
};

export async function getUnattributedDetail(month: string): Promise<UnattributedDetail> {
  const [stored, employees, latestImport] = await Promise.all([
    // Everything for the month, counted and excluded alike — the split happens below
    // so both halves come from one read.
    prisma.undefinedHoursRow.findMany({
      where: { month },
      orderBy: [{ workDate: "desc" }, { hours: "desc" }],
    }),
    prisma.employee.findMany({
      where: { paylocityId: { not: null } },
      select: { paylocityId: true, name: true, department: true },
    }),
    prisma.paylocityImport.findFirst({ orderBy: { id: "desc" }, select: { fileName: true, completedAt: true } }),
  ]);

  const byPaylocityId = new Map(employees.map((e) => [e.paylocityId!, e]));

  // A row whose hours round to 0 is dropped here — before it ever becomes a table row,
  // a section subtotal, a reason group or the total below — not merely hidden from
  // view while still padding a number nobody can see the source of (see
  // roundedHoursVisible).
  const counted = stored.filter((r) => r.countsTowardKpi && roundedHoursVisible(Number(r.hours)));
  const excludedRows = stored.filter((r) => !r.countsTowardKpi);

  const toRow = (r: (typeof stored)[number]) => {
    const emp = byPaylocityId.get(r.employeeId);
    const reason = r.reason as UndefinedReason;
    return {
      date: r.workDate ? r.workDate.toISOString().slice(0, 10) : "—",
      employee: emp?.name ?? (r.employeeId ? `#${r.employeeId}` : "—"),
      department: emp?.department ?? "—",
      section: r.section,
      // 10-311 is counted here un-split: it is rejected before the design/software
      // split happens, so showing it as two lines would invent detail the source
      // never carried.
      sectionName: SECTION_NAME.get(r.section) ?? r.section,
      hours: Number(r.hours),
      // Section and Function split out, from the one shared projection (2026-08-21).
      // These rows are rejected BEFORE standardization, so `r.section` already IS the
      // raw code — passing it as both the standardized and the raw argument is exact
      // here, not an approximation: no alias, split or merge has been applied to it.
      ...punchIdentity(...splitRawPair(r.section)),
      job: r.label, // the raw cell value that isn't a usable job number
      reason,
      reasonLabel: UNDEFINED_REASON_LABEL[reason] ?? r.reason,
      sourceRow: r.sourceRow,
    };
  };

  const rows = counted.map(toRow);

  const bySection = new Map<string, number>();
  for (const r of rows) bySection.set(r.section, (bySection.get(r.section) ?? 0) + r.hours);

  const group = (list: typeof stored): UndefinedGroup[] => {
    const by = new Map<string, UndefinedGroup>();
    for (const r of list) {
      const reason = r.reason as UndefinedReason;
      const cur = by.get(r.reason) ?? {
        reason,
        label: UNDEFINED_REASON_LABEL[reason] ?? r.reason,
        fix: UNDEFINED_REASON_FIX[reason] ?? "Review this punch in Paylocity.",
        rows: 0,
        hours: 0,
        countsTowardKpi: r.countsTowardKpi,
      };
      cur.rows += 1;
      cur.hours += Number(r.hours);
      by.set(r.reason, cur);
    }
    return [...by.values()].sort((a, b) => b.hours - a.hours);
  };

  return {
    rows,
    total: rows.reduce((s, r) => s + r.hours, 0),
    sections: [...bySection.entries()]
      .map(([code, hours]) => ({ code, name: SECTION_NAME.get(code) ?? code, hours }))
      .sort((a, b) => b.hours - a.hours),
    // Bounded by how much bad data exists rather than by a row cap — 56 entries in
    // 2026-07. If that ever stops being true the cap belongs here, not in the UI.
    truncated: false,
    // The KPI's own number — computed independently from the SAME raw rows (grouped by
    // reason/label via aggregateUndefined rather than summed directly), not read back
    // from a second table. If this ever disagrees with `total` above, the panel says so
    // loudly (§42.28) rather than letting one of the two quietly win.
    storedTotal: visibleUndefinedTotals(
      stored.map((r) => ({
        reason: r.reason as UndefinedReason,
        countsTowardKpi: r.countsTowardKpi,
        month: r.month,
        label: r.label,
        hours: Number(r.hours),
      })),
    ).reduce((s, g) => s + g.hours, 0),
    groups: group(counted),
    excluded: {
      rows: excludedRows.length,
      hours: excludedRows.reduce((s, r) => s + Number(r.hours), 0),
      groups: group(excludedRows),
    },
    employeesAffected: new Set(counted.map((r) => r.employeeId).filter(Boolean)).size,
    sourceFile: latestImport?.fileName ?? null,
    importedAt: latestImport?.completedAt ?? null,
  };
}

// ── The KPI card's own figure (§37.13, §42.11) ──────────────────────────────
//
// What EtcMonthKpiCards' "Data Quality — Undefined Hours" card and its amber-banner
// label list read — computed straight off the punch-level rows, not off
// HoursImportIssue: that table has no per-punch granularity, so it cannot apply the
// same "hide rows that round to 0" rule the drill above does. Reading it here instead
// means the card can never show a number the drill's own rows don't sum to.
export async function getUndefinedHoursTotals(month: string): Promise<{ hours: number; entries: number; issues: UndefinedTotal[] }> {
  const rows = await prisma.undefinedHoursRow.findMany({
    where: { month },
    select: { reason: true, countsTowardKpi: true, month: true, label: true, hours: true },
  });
  const issues = visibleUndefinedTotals(rows.map((r) => ({ ...r, reason: r.reason as UndefinedReason, hours: Number(r.hours) })));
  return { hours: issues.reduce((s, i) => s + i.hours, 0), entries: issues.reduce((s, i) => s + i.rows, 0), issues };
}

// The reconciliation test (§42.28) lives in lib/undefined-hours-rules.ts with the rest
// of the definition, so the panel, the export and the tests all use one implementation.
export { reconcileUndefined, reconciliationMessage } from "@/lib/undefined-hours-rules";
