import { SECTIONS, ETC_SECTIONS } from "@/lib/sections";

// "Hours off the grid" — time booked to jobs whose EtcEntry rows exist for the month but
// which the grid no longer lists, because the job left Active status after the month was
// seeded. Those rows are deleted by the next Refresh Data or Submit ETC, so these hours
// are on a clock.
//
// Lives in lib/ rather than beside the card that renders it: the card is a client
// component that reaches a "use server" action, which makes it unimportable from a plain
// test. The arithmetic here is the part worth testing, so it is kept separable.

// One job whose hours exist in the month but which the grid does not list.
export type OffGridJob = {
  jobId: string;
  jobName: string;
  status: string | null;
  hours: number;
  sections: { section: string; hours: number }[];
};

export type OffGridSection = {
  section: string;
  name: string | undefined;
  hours: number;
  jobIds: string[];
};

// Section code -> its name. Built from the FULL section list rather than ETC_SECTIONS: an
// off-grid job's rows can carry codes the ETC grid excludes (the pool sections), and
// those still have real names.
const SECTION_NAME = new Map(SECTIONS.map((s) => [s.code, s.name]));

export function sectionName(code: string): string | undefined {
  return SECTION_NAME.get(code);
}

// ── Canonical section order ─────────────────────────────────────────────────
//
// Sections list in the SAME order as the Monthly ETC grid's columns (2026-08-03, by
// request), not by hours descending. The grid's column order is the sheet's order and
// it is what everyone reading this page already has in their head — a second ordering
// on the same set of things costs the reader a re-orientation for no gain.
//
// ETC_SECTIONS is exactly the grid's column sequence, so its index IS that order.
// Anything outside it (the pool sections the grid excludes, or a code the app does not
// model) sorts after the known ones, keeping the full SECTIONS order among themselves
// so the tail is stable rather than arbitrary.
const ETC_ORDER = new Map(ETC_SECTIONS.map((s, i) => [s.code, i]));
const ALL_ORDER = new Map(SECTIONS.map((s, i) => [s.code, i]));

export function sectionSortIndex(code: string): number {
  const inGrid = ETC_ORDER.get(code);
  if (inGrid != null) return inGrid;
  const known = ALL_ORDER.get(code);
  // Offset past every grid column so these always follow, never interleave.
  return ETC_ORDER.size + (known ?? ALL_ORDER.size);
}

export function compareSections(a: string, b: string): number {
  return sectionSortIndex(a) - sectionSortIndex(b) || a.localeCompare(b);
}

// The off-grid hours rolled up by SECTION instead of by job (2026-08-03, by request:
// "split by the sections"). The two views answer different questions — "which jobs am I
// about to lose hours on" versus "which kinds of work" — and the second is what tells you
// whether the loss lands on engineering or on the floor.
//
// Both views must total the same figure as the card above them, since all three are on
// screen at once. Hence the tests: a rollup that dropped or double-counted a job's hours
// would put three different numbers in front of the reader for one thing.
//
// Ordered like the Monthly ETC grid's columns, NOT by hours — see compareSections.
export function offGridBySection(jobs: OffGridJob[]): OffGridSection[] {
  const map = new Map<string, OffGridSection>();
  for (const j of jobs) {
    for (const s of j.sections) {
      const cur = map.get(s.section) ?? { section: s.section, name: SECTION_NAME.get(s.section), hours: 0, jobIds: [] };
      cur.hours += s.hours;
      // A job contributes to a section at most once (rows are summed per section
      // upstream), but guard anyway so a repeat can't double-list the job id.
      if (!cur.jobIds.includes(j.jobId)) cur.jobIds.push(j.jobId);
      map.set(s.section, cur);
    }
  }
  return [...map.values()].sort((a, b) => compareSections(a.section, b.section));
}
