import "server-only";
import { prisma } from "@/lib/prisma";
import { ETC_SECTIONS, PARTS_COST_SECTION, mapPunchToColumns, billingGroupForSection } from "@/lib/sections";
import { calcHoursLeft, round2, effectiveNewEtc, newEtcDiff, isNewEtcDecided } from "@/lib/etc";

// KPI cards for the top of the Monthly ETC page: hours worked and variance for
// Engineering and Shop, parts money spent, and how many people booked time in
// each group.
//
// The hours/variance figures are computed from the SAME EtcEntry rows the grid
// already has in memory, with the same effective-New-ETC rule and the same
// billing-group split, so a card can never disagree with the grand-total row at
// the bottom of the grid. That's the whole reason this takes the rows as an
// argument instead of re-querying: a second query would be a second definition,
// and the two would drift the first time someone changed a rule.
//
// Headcount is the one figure that needs its own read, because the grid doesn't
// carry it: it comes from JobHoursDetail (the punch-level Paylocity rows added
// 2026-07-30), counting DISTINCT employees per billing group.

const SECTION_GROUP = new Map(ETC_SECTIONS.map((s) => [s.code, s.billingGroup]));

export type GroupKpi = {
  prior: number;
  worked: number;
  hoursLeft: number;
  newEtc: number;
  // Sum of the per-cell variances across EVERY cell.
  diff: number;
  // The part of `diff` contributed by cells NOBODY HAS PLANNED yet.
  //
  // Since 2026-08-03 an untyped New ETC counts as 0, so an untouched cell
  // contributes its whole Hours Left. That is the right number, but it is not a
  // variance — printing "+4,070 under" when the truth is "nobody has planned
  // 4,070 hours" would be the card lying. Split out so the strip can say which it
  // is; `diff - diffUnplanned` is the genuine over/under from decided cells.
  diffUnplanned: number;
  // The two operands that actually produce `diff`, summed over the DECIDED cells only
  // and clamped exactly as the per-cell formula clamps (§28). `hoursLeft − newEtc`
  // above does NOT equal `diff`: an undecided cell contributes 0 to diff while its
  // Hours Left and New ETC still land in those totals. These two do:
  //
  //     plannedHoursLeft − plannedNewEtc === diff
  //
  // which is what lets a card explain its variance with figures that foot. Mirrors
  // the same pair in lib/etc-live-totals.ts, so the server figure and the live one
  // are the same quantity.
  plannedHoursLeft: number;
  plannedNewEtc: number;
  people: number; // distinct employees who booked time in this group this month
};

export type EtcMonthKpis = {
  engineering: GroupKpi;
  shop: GroupKpi;
  parts: { prior: number; spent: number; moneyLeft: number; newEtc: number; diff: number; plannedMoneyLeft: number; plannedNewEtc: number };
  // There was a `peopleTotal` here — distinct people across BOTH groups, which is
  // deliberately not engineering.people + shop.people (someone who booked to both
  // would be double-counted). It was the "People booked" KPI's headline; that block
  // was retired in §64 and the field went unread, so it was removed in §66 rather
  // than left as a computation nothing consumes. The per-group counts that DID
  // survive are GroupKpi.people on engineering/shop.
  // False when JobHoursDetail holds nothing for this month, so the cards can say
  // "no punch data" rather than showing a confident zero.
  hasPunchData: boolean;
};

// The entry shape both this and the grid rely on. Structural, so the caller can
// pass its Prisma rows straight through.
type EntryLike = {
  section: string;
  priorEtc: unknown;
  hoursWorked: unknown;
  newEtc: unknown;
  newEtcDraft: unknown;
  needsReview: boolean;
};


export async function getEtcMonthKpis(
  month: string,
  // Exactly the jobs the grid is rendering (i.e. after its Billable filter), so
  // the cards move with the grid rather than describing a different set.
  jobs: { id: number; etcEntries: EntryLike[] }[],
): Promise<EtcMonthKpis> {
  // Summed PER CELL, not derived from the group totals: the suggestion that
  // stands in for an untouched cell clamps at 0 per cell, and that clamp cannot
  // be reproduced from the sums. Every cell counts now — see newEtcDiff.
  const eng = { prior: 0, worked: 0, newEtc: 0, diff: 0, diffUnplanned: 0, plannedHoursLeft: 0, plannedNewEtc: 0 };
  const shop = { prior: 0, worked: 0, newEtc: 0, diff: 0, diffUnplanned: 0, plannedHoursLeft: 0, plannedNewEtc: 0 };
  const parts = { prior: 0, spent: 0, newEtc: 0, diff: 0, plannedLeft: 0, plannedNewEtc: 0 };

  for (const job of jobs) {
    for (const entry of job.etcEntries) {
      if (entry.section === PARTS_COST_SECTION) {
        parts.prior += Number(entry.priorEtc);
        parts.spent += Number(entry.hoursWorked);
        parts.newEtc += effectiveNewEtc(entry);
        parts.diff += newEtcDiff(entry);
        // Decided cells only, clamped exactly as the per-cell formula clamps, so that
        // plannedMoneyLeft − plannedNewEtc === diff. See GroupKpi.
        if (isNewEtcDecided(entry)) {
          parts.plannedLeft += calcHoursLeft(Number(entry.priorEtc), Number(entry.hoursWorked));
          parts.plannedNewEtc += Math.max(effectiveNewEtc(entry), 0);
        }
        continue;
      }
      const group = SECTION_GROUP.get(entry.section);
      if (!group) continue; // a code the ETC grid doesn't track
      const bucket = group === "Engineering" ? eng : shop;
      bucket.prior += Number(entry.priorEtc);
      bucket.worked += Number(entry.hoursWorked);
      bucket.newEtc += effectiveNewEtc(entry);
      bucket.diff += newEtcDiff(entry);
      // Attributed to "unplanned" only while the cell is genuinely undecided.
      if (!isNewEtcDecided(entry)) bucket.diffUnplanned += newEtcDiff(entry);
      else {
        bucket.plannedHoursLeft += calcHoursLeft(Number(entry.priorEtc), Number(entry.hoursWorked));
        bucket.plannedNewEtc += Math.max(effectiveNewEtc(entry), 0);
      }
    }
  }

  // Headcount PER GROUP, from the punch rows. Restricted to the same jobs so it
  // can't count someone who only booked to a job the grid is filtering out.
  //
  // Per-group only since §66: the distinct-across-both-groups total was the
  // retired "People booked" card's headline and nothing reads it now, so the
  // third Set that accumulated it is gone with it.
  const jobIds = jobs.map((j) => j.id);
  const punches = jobIds.length
    ? await prisma.jobHoursDetail.findMany({
        where: { month, jobId: { in: jobIds } },
        select: { section: true, employeeId: true },
      })
    : [];
  // ── The raw pair has to be folded first (2026-09-02) ──────────────────────
  //
  // `section` is the RAW Paylocity pair and SECTION_GROUP is keyed on the ETC
  // grid's column codes, so a punch coded 13-211, 11-211, 40-311 or 10-311
  // matched nothing and the person who worked it was counted in NEITHER group.
  // The hours were never wrong here — this KPI counts PEOPLE — but a headcount
  // that quietly omits whoever happened to book to an aliased code is a headcount
  // nobody can reconcile against the roster.
  //
  // Same fold as every other punch consumer; billingGroupForSection covers the
  // codes ETC_SECTIONS has no column for (10-413, 70-*), which SECTION_GROUP
  // alone misses.
  const engPeople = new Set<string>();
  const shopPeople = new Set<string>();
  for (const p of punches) {
    if (!p.employeeId) continue;
    for (const col of mapPunchToColumns(p.section, 1)) {
      const group = SECTION_GROUP.get(col.section) ?? billingGroupForSection(col.section);
      if (group === "Engineering") engPeople.add(p.employeeId);
      else if (group === "Shop") shopPeople.add(p.employeeId);
    }
  }

  const finish = (
    b: { prior: number; worked: number; newEtc: number; diff: number; diffUnplanned: number; plannedHoursLeft: number; plannedNewEtc: number },
    people: number,
  ): GroupKpi => {
    const hoursLeft = calcHoursLeft(b.prior, b.worked);
    return {
      prior: round2(b.prior),
      worked: round2(b.worked),
      hoursLeft: round2(hoursLeft),
      newEtc: round2(b.newEtc),
      diff: round2(b.diff),
      diffUnplanned: round2(b.diffUnplanned),
      plannedHoursLeft: round2(b.plannedHoursLeft),
      plannedNewEtc: round2(b.plannedNewEtc),
      people,
    };
  };

  const partsLeft = calcHoursLeft(parts.prior, parts.spent);
  return {
    engineering: finish(eng, engPeople.size),
    shop: finish(shop, shopPeople.size),
    parts: {
      prior: round2(parts.prior),
      spent: round2(parts.spent),
      moneyLeft: round2(partsLeft),
      newEtc: round2(parts.newEtc),
      diff: round2(parts.diff),
      plannedMoneyLeft: round2(parts.plannedLeft),
      plannedNewEtc: round2(parts.plannedNewEtc),
    },
    hasPunchData: punches.length > 0,
  };
}
