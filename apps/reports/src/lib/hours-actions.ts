"use server";

import { auth } from "@/lib/auth";
import { queryHoursGrouped, queryHoursDrillRows, type HoursDrillRows } from "@/lib/hours-explorer";
import { HOURS_GROUP_BY_VALUES, type HoursFilters, type HoursGroupBy, type HoursGroupRow } from "@/lib/hours-filters";

// The Hours tab's nested Group By tree fetches every level past the first ON EXPAND
// (page.tsx computes level 0 server-side, same as before) — same "fetch on open, not
// with the page" judgement hours-detail-actions.ts already makes for the ETC drills,
// applied to this table's own group-by rollup instead of its punch lines.
//
// The caller (HoursGroupedTree.tsx) computes each node's fully-narrowed HoursFilters
// itself, via the pure narrowFiltersForGroupValue (hours-filters.ts) applied once per
// ancestor — this action never reconstructs an ancestor path, it just runs the SAME
// queryHoursGrouped the page's own SSR already calls for level 0, under whatever
// filters it's given. That means this grants no capability beyond what a signed-in
// user's own URL-edited filters already expose; the validation below is DoS hygiene
// (an oversized IN-clause from a hand-posted request), not an access boundary.

const MAX_IDS = 500;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

function ids(v: unknown, pattern?: RegExp): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 100 && (!pattern || pattern.test(x))).slice(0, MAX_IDS);
  return list.length > 0 ? list : undefined;
}

// Same DoS-hygiene shape as ids() above, for the two raw-narrowing scalars
// (sectionNumber/functionId) rather than a list. No character-class pattern —
// a real raw MachineSec/Function value can be non-numeric ("Not Defined") — just
// the same type/length check every other field here gets.
function rawId(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= 100 ? v : undefined;
}

function sanitize(f: HoursFilters): HoursFilters {
  return {
    jobIds: ids(f.jobIds),
    employeeIds: ids(f.employeeIds),
    sections: ids(f.sections),
    departments: ids(f.departments),
    months: ids(f.months, ISO_MONTH),
    from: f.from && ISO_DATE.test(f.from) ? f.from : undefined,
    to: f.to && ISO_DATE.test(f.to) ? f.to : undefined,
    // "Section"/"Function" narrow via these two (see HoursFilters' own header) — left
    // out of this allow-list once already, which silently dropped the narrowing on
    // every server-action drill (though never on the page's own SSR level 0, which
    // reads HoursFilters directly with no sanitize() in between) and re-ran the
    // child level completely unfiltered. Found live: expanding an unmapped "Section"
    // row's Function children returned the WHOLE dataset's Function breakdown
    // instead of that section's own ~23h.
    //
    // Renamed to rawSectionNumber/rawFunctionId (2026-08-21): narrowFiltersForGroupValue
    // now sets those fields (matching what these dimensions actually group on — the
    // RAW columns), so forwarding the OLD field names here would drop the narrowing all
    // over again, the identical class of bug the comment above already describes once.
    rawSectionNumber: rawId(f.rawSectionNumber),
    rawFunctionId: rawId(f.rawFunctionId),
  };
}

/** Fetches ONE tree node's children — the row set for `groupBy`, under `filters`
 *  already narrowed by every ancestor's chosen value. */
export async function loadHoursGroupChildren(filters: HoursFilters, groupBy: HoursGroupBy): Promise<HoursGroupRow[]> {
  // Signed-in only. Every page is already behind the (app) layout's login gate, but a
  // server action is a public endpoint of its own and has to say so itself — same
  // posture as hours-detail-actions.ts's loadEtcMonthHoursDetail.
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  if (!(HOURS_GROUP_BY_VALUES as readonly string[]).includes(groupBy)) throw new Error(`Invalid group-by "${groupBy}".`);
  return queryHoursGrouped(sanitize(filters), groupBy);
}

/** Fetches the raw punch rows behind a leaf group — the tree's terminal level, once
 *  every configured Group By dimension has already narrowed `filters`. Same
 *  signed-in guard and the same DoS-hygiene sanitize() as loadHoursGroupChildren;
 *  there is no extra dimension to validate here since queryHoursDrillRows takes no
 *  groupBy argument. */
export async function loadHoursDetailRows(filters: HoursFilters): Promise<HoursDrillRows> {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  return queryHoursDrillRows(sanitize(filters));
}
