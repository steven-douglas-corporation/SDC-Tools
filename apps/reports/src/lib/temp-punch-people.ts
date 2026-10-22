import type { WarehousePunch } from "@/lib/paylocity-workbook";
import {
  contractorCandidatesByName,
  normalizeName,
  resolveContractorEmployeeId,
  type ContractorIdCandidate,
} from "@/lib/manual-contractor-hours";

// ── Who a temp punch belongs to (2026-10-22) ────────────────────────────────
//
// Paylocity's PunchDetail report for the TEMPS group carries a NAME on every punch and
// no Employee Id. The hours reader, the drills and the roster all work in ids, so each
// name is turned into the id this app already holds for that person — `Employee.paylocityId`,
// which for a temp is whatever someone typed on the Employees page (TEMP1, 100700...).
// That is the same place lib/manual-contractor-hours.ts has always matched a timecard's
// name, with the same rule, so the typed-in timecards and this feed agree about who is who
// and the day-level suppression between them compares like with like.
//
// Pure: no database, so the rules can be tested table by table. lib/temp-punches.ts loads
// the people and calls this.
//
// ── The order, and what is deliberately NOT guessed ─────────────────────────
//
//   1. The report's own Employee Id, when it has one (Paylocity can add the column; the
//      warehouse reads it with no change) and the app knows that id.
//   2. The name, through the app's Employee rows — the single ACTIVE namesake wins over a
//      leaver, and two active namesakes are never chosen between (resolveContractorEmployeeId).
//   3. The name, through the ids on the still-active typed-in timecards. This only matters
//      while both sources run side by side: a temp with no Employee row yet but a placeholder
//      id on their timecards keeps that id, so the two sources suppress each other instead of
//      counting the same day twice.
//   4. Otherwise the person is UNMATCHED. Their hours still count on the job (the job
//      total must not depend on a roster entry) under a visible placeholder id, and they are
//      listed on Data Management until someone adds them on the Employees page.

/** A person the app holds: an Employee row with a Paylocity id. */
export type AppPerson = { name: string; paylocityId: string | null; active: boolean };
/** A name and id from the active typed-in timecards (ManualContractorPunch). */
export type TypedInId = { name: string; paylocityId: string };

export type TempPerson =
  | { kind: "matched"; employeeId: string; via: "id" | "name" | "typed-in"; reportId: string | null }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unmatched"; reportId: string | null };

/** What an unmatched person's hours are filed under. Visible and unmistakable, never an invented id. */
export const UNMATCHED_PREFIX = "NAME:";
export const unmatchedEmployeeId = (name: string | null) => `${UNMATCHED_PREFIX}${(name ?? "(no name)").trim()}`;
export const isUnmatchedEmployeeId = (id: string) => id.startsWith(UNMATCHED_PREFIX);

export type PeopleIndex = {
  byId: Map<string, AppPerson>;
  byName: Map<string, ContractorIdCandidate[]>;
  typedInByName: Map<string, Set<string>>;
};

export function buildPeopleIndex(people: readonly AppPerson[], typedIn: readonly TypedInId[] = []): PeopleIndex {
  const byId = new Map<string, AppPerson>();
  for (const p of people) if (p.paylocityId) byId.set(p.paylocityId.trim(), p);
  const typedInByName = new Map<string, Set<string>>();
  for (const t of typedIn) {
    const key = normalizeName(t.name);
    const ids = typedInByName.get(key) ?? new Set<string>();
    ids.add(t.paylocityId.trim());
    typedInByName.set(key, ids);
  }
  return { byId, byName: contractorCandidatesByName(people), typedInByName };
}

export function resolveTempPerson(who: { name: string | null; employeeId: string | null }, index: PeopleIndex): TempPerson {
  const reportId = who.employeeId?.trim() || null;
  if (reportId && index.byId.has(reportId)) return { kind: "matched", employeeId: reportId, via: "id", reportId };

  const key = who.name ? normalizeName(who.name) : "";
  if (key) {
    const candidates = index.byName.get(key) ?? [];
    if (candidates.length > 0) {
      const r = resolveContractorEmployeeId(candidates, "");
      return r.kind === "resolved"
        ? { kind: "matched", employeeId: r.employeeId, via: "name", reportId }
        : { kind: "ambiguous", candidates: r.candidates };
    }
    const typedIn = index.typedInByName.get(key);
    // One id only: two different ids typed in for one name is the same ambiguity as two people.
    if (typedIn && typedIn.size === 1) return { kind: "matched", employeeId: [...typedIn][0], via: "typed-in", reportId };
  }
  return { kind: "unmatched", reportId };
}

export type TempPersonSummary = {
  name: string;
  person: TempPerson;
  /** The id this person's hours are filed under; null when the punches are held back (ambiguous). */
  employeeId: string | null;
  punches: number;
  hours: number;
  firstDate: string;
  lastDate: string;
};

export type ResolvedTempPunches = {
  /** Ready for the worksheet: employeeId set, travel defaulted. Ambiguous people are NOT in here. */
  punches: WarehousePunch[];
  /** Punches held back because their name matches more than one person. Never filed under either. */
  ambiguous: { punch: WarehousePunch; candidates: string[] }[];
  people: TempPersonSummary[];
};

/**
 * Travel for a temp punch. The report has no travel column; the typed-in timecards filed
 * these under the home site (a blank 4th transfer part means Concord), and Travel % on the
 * Dashboard reads a blank as "not known", so a temp's hours would otherwise vanish from it.
 */
export const TEMP_PUNCH_TRAVEL = "Concord";

export function resolveTempPunches(
  punches: readonly WarehousePunch[],
  people: readonly AppPerson[],
  typedIn: readonly TypedInId[] = [],
): ResolvedTempPunches {
  const index = buildPeopleIndex(people, typedIn);
  const resolved: WarehousePunch[] = [];
  const ambiguous: ResolvedTempPunches["ambiguous"] = [];
  const summaries = new Map<string, TempPersonSummary>();

  for (const p of punches) {
    const name = p.employeeName?.trim() || null;
    const person = resolveTempPerson({ name, employeeId: p.employeeId }, index);
    const employeeId =
      person.kind === "matched"
        ? person.employeeId
        : person.kind === "unmatched"
          ? person.reportId ?? unmatchedEmployeeId(name)
          : null;

    const label = name ?? "(no name)";
    const key = `${normalizeName(label)}|${p.employeeId ?? ""}`;
    const s = summaries.get(key);
    if (s) {
      s.punches += 1;
      s.hours += p.hours;
      if (p.workDate < s.firstDate) s.firstDate = p.workDate;
      if (p.workDate > s.lastDate) s.lastDate = p.workDate;
    } else {
      summaries.set(key, { name: label, person, employeeId, punches: 1, hours: p.hours, firstDate: p.workDate, lastDate: p.workDate });
    }

    if (person.kind === "ambiguous") {
      ambiguous.push({ punch: p, candidates: person.candidates });
      continue;
    }
    resolved.push({ ...p, employeeId, travel: TEMP_PUNCH_TRAVEL });
  }

  const out = [...summaries.values()];
  for (const s of out) s.hours = Math.round(s.hours * 100) / 100;
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { punches: resolved, ambiguous, people: out };
}
