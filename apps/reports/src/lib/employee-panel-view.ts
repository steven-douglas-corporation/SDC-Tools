// What the employee panel's Team and Hours tabs show, worked out from rows the
// Employees page already holds. No React and no I/O, so it is tested directly.

import type { EmployeeRow } from "@/lib/employee-row";
import type { EmployeeMonthPunch } from "@/lib/employee-punch-drill";

type Person = Pick<EmployeeRow, "id" | "name" | "supervisorId" | "active">;

/**
 * The people above this one, nearest manager first, ending at the top of the
 * reporting line. Hidden managers are kept: the line is a fact about the
 * organisation, and a gap in it would read as a different boss. Stops if a
 * supervisor loop ever sneaks in (Paylocity data entry) instead of spinning.
 */
export function reportingChain<T extends Person>(rows: T[], id: number): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain: T[] = [];
  const seen = new Set<number>([id]);
  let next = byId.get(id)?.supervisorId ?? null;
  while (next != null && !seen.has(next)) {
    const boss = byId.get(next);
    if (!boss) break;
    chain.push(boss);
    seen.add(next);
    next = boss.supervisorId ?? null;
  }
  return chain;
}

/** Everyone who reports directly to this person: shown people first, then by name. */
export function directReports<T extends Person>(rows: T[], id: number): T[] {
  return rows
    .filter((r) => r.supervisorId === id && r.id !== id)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

export type JobHours = { jobId: string; jobName: string; hours: number; billableHours: number; punches: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One line per job for the month, biggest first (ties by job number), so "on what?" reads top-down. */
export function hoursByJob(punches: EmployeeMonthPunch[]): JobHours[] {
  const byJob = new Map<string, JobHours>();
  for (const p of punches) {
    const line = byJob.get(p.jobId) ?? { jobId: p.jobId, jobName: p.jobName, hours: 0, billableHours: 0, punches: 0 };
    line.hours += p.hours;
    if (p.billable) line.billableHours += p.hours;
    line.punches += 1;
    byJob.set(p.jobId, line);
  }
  return [...byJob.values()]
    .map((l) => ({ ...l, hours: round2(l.hours), billableHours: round2(l.billableHours) }))
    .sort((a, b) => b.hours - a.hours || a.jobId.localeCompare(b.jobId));
}
