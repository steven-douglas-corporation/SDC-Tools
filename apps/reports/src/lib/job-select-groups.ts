// ── Selecting a whole Job Status group in the Job Hours job picker ──────────
//
// The rules behind the tri-state checkbox on each status group header
// ("☑ Active — 59"), kept here rather than inside JobSelect.tsx so they can be
// tested directly. The COMPONENT still owns the picker — this is only the
// arithmetic of "what should be selected after that click", which is the part
// with edge cases worth pinning down.
//
// Dependency-free on purpose, same as employee-workforce-groups.ts and
// hiring-openings.ts: imported by a client component and loadable by
// `tsx --test` with no React or Prisma in the way.
//
// Nothing here talks to the URL. JobSelect's apply() writes the returned list to
// `?jobs=` in a single router.push, which is what keeps a 59-job group selection
// one navigation and one refetch instead of 59 — and what keeps group selection
// on exactly the same filtering path as picking those jobs by hand, rather than
// a second parallel mechanism.

/** The minimum a job needs for these rules. Structural, so JobOpt satisfies it. */
export type SelectableJob = { jobId: string };

export type GroupSelectionState = "all" | "some" | "none";

/**
 * How much of one group is currently selected — the three checkbox states.
 *
 * An EMPTY group reports "none" rather than "all". Vacuously every member is
 * selected, but rendering a ticked box over nothing would read as a selection
 * that does not exist. (In practice JobSelect drops empty groups before
 * rendering; this keeps the function honest on its own.)
 */
export function groupSelectionState(items: readonly SelectableJob[], selected: readonly string[]): GroupSelectionState {
  if (items.length === 0) return "none";
  const selectedSet = new Set(selected);
  let hits = 0;
  for (const j of items) if (selectedSet.has(j.jobId)) hits++;
  if (hits === 0) return "none";
  return hits === items.length ? "all" : "some";
}

/**
 * The complete next selection after clicking a group's checkbox.
 *
 * Two deliberate decisions:
 *
 *   * "all" clears the group; "some" FILLS IT IN. A part-filled box invites
 *     completing it, and clicking a mixed group to empty it would silently
 *     discard the picks already made inside — the opposite of what the tick
 *     appears to offer.
 *   * The result is ordered by `allJobs`, not by insertion. JobSelect renders
 *     its chips and writes `?jobs=` from this list, so ordering it any other way
 *     would make the chips reshuffle whenever a group is added.
 *
 * Selections in OTHER groups are always carried through untouched, which is the
 * request's "selecting one group must not remove selections from another" — it
 * falls out of only ever adding or removing this group's own ids.
 *
 * `items` is whatever the caller considers the group to contain. JobSelect
 * passes the SEARCH-FILTERED contents, so with a query active the header acts on
 * what is visible beneath it — the only reading consistent with the count shown
 * on that same header, which is filtered too.
 */
export function nextSelectionForGroup(
  items: readonly SelectableJob[],
  selected: readonly string[],
  allJobs: readonly SelectableJob[],
): string[] {
  const groupIds = new Set(items.map((j) => j.jobId));
  if (groupSelectionState(items, selected) === "all") {
    return selected.filter((id) => !groupIds.has(id));
  }
  const selectedSet = new Set(selected);
  return allJobs.filter((j) => selectedSet.has(j.jobId) || groupIds.has(j.jobId)).map((j) => j.jobId);
}
