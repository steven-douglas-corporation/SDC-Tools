import "server-only";
import { prisma } from "@/lib/prisma";
import { poolCategoryForPunch } from "@/lib/sections";
import type { JobHoursRow, PoolHoursByMonth } from "@/lib/job-hours-source";
import type { RejectedPunch } from "@/lib/paylocity-workbook";

// ── Manual contractor punches, merged into the ONE hours feed ────────────────
//
// TEMPORARY (2026-09-01). Paylocity's Job Hours report is not carrying
// temp/contractor punches for July-August 2026. The supplied timecards are
// transcribed into ManualContractorPunch (one row per punch segment, hours
// derived from in/out — see scripts/seed-manual-contractor-punches.ts) and joined
// here, at readHoursFeed, which is the single doorway every hours consumer
// already goes through.
//
// That placement is the whole design. Monthly ETC's Hours Worked, the job
// rollups, the punch drill, Projects' actual hours, T&M's four hours cards, the
// Standard Fees pools, the Dashboard and the exports all read the feed and
// nothing else, so ONE merge reaches all of them. No page has contractor logic
// of its own, and no figure anywhere is hard-coded.
//
// The rows produced below are ordinary JobHoursRows: same shape, same
// standardization, same section codes, resolved by the same normalizers a
// workbook punch uses (lib/manual-contractor-punch-parse.ts). Downstream code
// cannot tell them apart, which is exactly what makes the department mapping
// come out right without a second mapping table.
//
// ── Double-counting is prevented by CONTENT, not by memory ──────────────────
//
// The failure mode to design against: Paylocity fixes its report, the
// contractors start appearing in the Excel, and nobody remembers to delete the
// manual rows — so every hour counts twice.
//
// So suppression is decided from the feed that was just read, every time. If the
// official punches contain ANY hours for an (employee, work date), every manual
// segment for that employee and day is dropped and the official record wins.
//
// (employee, work date) rather than a segment-level key, deliberately. The
// official export carries no in/out times — it arrives pre-aggregated per punch —
// so a segment key like employee+date+in+out+job+function cannot be compared
// against it at all. Day granularity is the finest grain both sides actually
// share, and it is the SAFE direction: a day Paylocity reports at all is taken
// entirely from Paylocity, so a partial official day can never be topped up into
// a double count.
//
// Employee identity is resolved through the Employee table BY NAME, so the id the
// merge compares on is whatever that row currently holds. When Paylocity issues
// Lahu Shedole a real employee id, updating his Employee row is the single action
// that switches this dedup on for him — no change here, and no change to the
// seeded data.

export type ManualContractorMerge = {
  rows: JobHoursRow[];
  /** Manual segments dropped because the official feed already covers that employee/day. */
  suppressed: { employeeName: string; workDate: string; hours: number; segments: number }[];
  /** Manual segments whose job number the app does not know — reported, never emitted. */
  unknownJobs: { employeeName: string; workDate: string; jobNumber: string; hours: number }[];
  /**
   * Manual segments whose timecard NAME matches more than one roster row and cannot
   * be attributed without guessing — reported here AND as `rejected` punches, never
   * emitted under either candidate. See resolveContractorEmployeeId.
   */
  ambiguousEmployees: { employeeName: string; workDate: string; candidates: string[]; hours: number }[];
  /**
   * The same ambiguous segments in the feed's own rejection shape (EMPLOYEE_NOT_MAPPED),
   * so readHoursFeed can append them to `rejected` and the Undefined Hours drill shows
   * them as unattributed alongside the workbook's rejections — visibly in need of a
   * fix, rather than silently filed under the wrong person. Not counted toward the KPI
   * (countsTowardKpi: false): the KPI's definition is job-number faults.
   */
  rejected: RejectedPunch[];
  /** For the provenance line, so a reader can see manual hours are in play. */
  totalHours: number;
};

// ── Resolving a timecard name to ONE employee id (2026-09-14) ───────────────
//
// This used to be `new Map(employees.map((e) => [name.toLowerCase(), e.paylocityId]))`
// over the whole roster — last-writer-wins, so two rows sharing a name (a rehire, a
// namesake, a leaver kept for history) silently sent every segment to whichever row
// happened to be read last, and the dedup against the official feed compared on that
// id too. Wrong person, wrong dedup, and nothing said so.
//
// The rule now: no roster match keeps the id seeded with the punch (the contractor has
// no Paylocity id yet — the designed case); exactly one match uses it; several matches
// prefer the single ACTIVE row, because a leaver's row is history and a timecard is
// current work; anything still ambiguous is NOT guessed — the caller records it as a
// rejected punch and skips it. Pure and exported so the rule table is tested directly.
export type ContractorIdCandidate = { paylocityId: string; active: boolean };
export type ContractorIdResolution = { kind: "resolved"; employeeId: string } | { kind: "ambiguous"; candidates: string[] };

export function resolveContractorEmployeeId(candidates: readonly ContractorIdCandidate[], seededId: string): ContractorIdResolution {
  if (candidates.length === 0) return { kind: "resolved", employeeId: seededId };
  if (candidates.length === 1) return { kind: "resolved", employeeId: candidates[0].paylocityId };
  const active = candidates.filter((c) => c.active);
  if (active.length === 1) return { kind: "resolved", employeeId: active[0].paylocityId };
  return { kind: "ambiguous", candidates: candidates.map((c) => c.paylocityId) };
}

/** Roster rows keyed by the normalised name a timecard is matched on. */
export function contractorCandidatesByName(employees: readonly { name: string; paylocityId: string | null; active: boolean }[]): Map<string, ContractorIdCandidate[]> {
  const byName = new Map<string, ContractorIdCandidate[]>();
  for (const e of employees) {
    if (!e.paylocityId) continue;
    const key = normalizeName(e.name);
    const list = byName.get(key);
    const candidate = { paylocityId: e.paylocityId, active: e.active };
    if (list) list.push(candidate);
    else byName.set(key, [candidate]);
  }
  return byName;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

type PunchRow = {
  id: number;
  employeeName: string;
  paylocityId: string;
  workDate: Date;
  jobNumber: string;
  machineSec: string;
  functionId: string;
  hours: unknown;
  location: string;
};

const EMPTY: ManualContractorMerge = { rows: [], suppressed: [], unknownJobs: [], ambiguousEmployees: [], rejected: [], totalHours: 0 };

/**
 * Reads the active manual contractor punches and turns them into feed rows.
 *
 * @param officialRows the workbook rows already read for this same scope — what
 *        suppression is decided against. Passing them in (rather than re-reading)
 *        is what guarantees the comparison is against the very data being merged.
 * @param knownJobNumbers the job master, so a transfer naming a job the app has
 *        never heard of is surfaced instead of silently attributed.
 */
export async function mergeManualContractorHours(opts: {
  officialRows: JobHoursRow[];
  knownJobNumbers: Set<string>;
  onlyMonth?: string;
}): Promise<ManualContractorMerge> {
  // $queryRaw, not the typed client: `prisma generate` cannot run while a server
  // holds node_modules/.prisma open, so ManualContractorPunch has no generated
  // type yet — the same standing constraint RolePermission lives with.
  const punches = await prisma.$queryRaw<PunchRow[]>`
    SELECT id, employeeName, paylocityId, workDate, jobNumber, machineSec, functionId, hours, location
    FROM ManualContractorPunch
    WHERE active = true
    ORDER BY workDate, employeeName, startTime
  `;
  if (punches.length === 0) return EMPTY;

  // Name -> the roster rows that carry it, with `active` so a namesake can be told
  // apart from a leaver (resolveContractorEmployeeId). This is the hook that makes the
  // dedup start working the moment a real Paylocity id is filled in.
  const employees = await prisma.$queryRaw<{ name: string; paylocityId: string | null; active: boolean }[]>`
    SELECT name, paylocityId, active FROM Employee WHERE paylocityId IS NOT NULL
  `;
  const candidatesByName = contractorCandidatesByName(employees);

  // Every (employee id, day) the OFFICIAL feed carries. Built from the rows just
  // read, so this is never stale.
  const officialDays = new Set(officialRows(opts.officialRows));

  const rows: JobHoursRow[] = [];
  const suppressedBy = new Map<string, { employeeName: string; workDate: string; hours: number; segments: number }>();
  const unknownJobs: ManualContractorMerge["unknownJobs"] = [];
  const ambiguousEmployees: ManualContractorMerge["ambiguousEmployees"] = [];
  const rejected: RejectedPunch[] = [];
  let totalHours = 0;

  for (const p of punches) {
    const iso = isoDate(p.workDate);
    const month = iso.slice(0, 7);
    if (opts.onlyMonth && month !== opts.onlyMonth) continue;

    const hours = Number(p.hours);
    if (!Number.isFinite(hours) || hours <= 0) continue;

    // The CURRENT id for this person, falling back to the one seeded with the row —
    // or, when the name matches several roster rows and neither `active` nor count
    // settles it, no id at all: the segment is surfaced as unattributed rather than
    // booked under whichever row happened to be read last.
    const resolution = resolveContractorEmployeeId(candidatesByName.get(normalizeName(p.employeeName)) ?? [], p.paylocityId);
    if (resolution.kind === "ambiguous") {
      ambiguousEmployees.push({ employeeName: p.employeeName, workDate: iso, candidates: resolution.candidates, hours });
      rejected.push({
        month,
        reason: "EMPLOYEE_NOT_MAPPED",
        label: p.employeeName,
        workDate: new Date(`${iso}T00:00:00.000Z`),
        // The seeded id, so the drill still names the card the segment came from.
        employeeId: p.paylocityId,
        section: `${p.machineSec}-${p.functionId}`,
        hours,
        // The workbook's sourceRow is a sheet row; a manual segment's nearest
        // equivalent is its ManualContractorPunch id.
        sourceRow: p.id,
        countsTowardKpi: false,
      });
      continue;
    }
    const employeeId = resolution.employeeId;

    if (officialDays.has(`${employeeId}|${iso}`)) {
      const key = `${employeeId}|${iso}`;
      const acc = suppressedBy.get(key) ?? { employeeName: p.employeeName, workDate: iso, hours: 0, segments: 0 };
      acc.hours += hours;
      acc.segments += 1;
      suppressedBy.set(key, acc);
      continue;
    }

    if (!opts.knownJobNumbers.has(p.jobNumber)) {
      unknownJobs.push({ employeeName: p.employeeName, workDate: iso, jobNumber: p.jobNumber, hours });
      continue;
    }

    const [y, m] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7))];
    rows.push({
      jobId: p.jobNumber,
      // The raw pair, exactly as the workbook reader stores it — folding to ETC
      // columns happens later, at aggregation time, for manual and official rows
      // alike.
      section: `${p.machineSec}-${p.functionId}`,
      year: y,
      month: m,
      date: new Date(`${iso}T00:00:00.000Z`),
      hours,
      employeeId,
      rawSection: p.machineSec,
      rawFunction: p.functionId,
      // The timecard's 4th transfer part is a site, and the feed's `travel` field
      // is the same idea: "Concord" is the home site, which is what a blank means
      // too (see normalizeTravel). Anything else is passed through rather than
      // guessed at.
      travel: p.location.trim() || "Concord",
    });
    totalHours += hours;
  }

  return { rows, suppressed: [...suppressedBy.values()], unknownJobs, ambiguousEmployees, rejected, totalHours };
}

/** Pool tally for the merged rows — same rule, same raw phase/function, as the workbook's. */
export function manualContractorPoolHours(rows: JobHoursRow[]): PoolHoursByMonth {
  const pools: PoolHoursByMonth = new Map();
  for (const r of rows) {
    const category = poolCategoryForPunch(r.rawSection, r.rawFunction);
    if (!category) continue;
    const k = `${String(r.year)}-${String(r.month).padStart(2, "0")}::${category}`;
    pools.set(k, (pools.get(k) ?? 0) + r.hours);
  }
  return pools;
}

function officialRows(rows: JobHoursRow[]): string[] {
  return rows.map((r) => `${r.employeeId}|${isoDate(r.date)}`);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
