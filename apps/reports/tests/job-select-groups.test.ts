import { test } from "node:test";
import assert from "node:assert/strict";
import { groupSelectionState, nextSelectionForGroup } from "../src/lib/job-select-groups";

// Group-select on the Job Hours job picker (2026-08-24): a tri-state checkbox on
// each Job Status header, so "Active — 59" is one click.
//
// The fixture mirrors the real shape — jobs ordered as the picker lists them,
// split across status groups — because ORDER is part of the contract here: the
// chips and the ?jobs= param are both rendered from the returned list.
const ACTIVE = [{ jobId: "1083" }, { jobId: "1101" }, { jobId: "1104" }];
const COMPLETE = [{ jobId: "0901" }, { jobId: "0902" }];
const BLANK = [{ jobId: "1200" }];
const ALL_JOBS = [...ACTIVE, ...COMPLETE, ...BLANK];

test("state is none / some / all as the group fills up", () => {
  assert.equal(groupSelectionState(ACTIVE, []), "none");
  assert.equal(groupSelectionState(ACTIVE, ["1101"]), "some");
  assert.equal(groupSelectionState(ACTIVE, ["1083", "1101"]), "some");
  assert.equal(groupSelectionState(ACTIVE, ["1083", "1101", "1104"]), "all");
});

test("selections outside the group never affect its state", () => {
  // Every Complete job selected, no Active ones — Active must still read "none",
  // or its checkbox would lie about a group the user has not touched.
  assert.equal(groupSelectionState(ACTIVE, ["0901", "0902"]), "none");
  assert.equal(groupSelectionState(ACTIVE, ["1083", "0901", "0902"]), "some");
});

test("an empty group reads none, not vacuously all", () => {
  // Rendering a ticked box over nothing would claim a selection that does not
  // exist. (JobSelect drops empty groups before rendering; this keeps the
  // function honest standalone.)
  assert.equal(groupSelectionState([], []), "none");
  assert.equal(groupSelectionState([], ["1083"]), "none");
});

test("clicking an empty group selects all of it", () => {
  assert.deepEqual(nextSelectionForGroup(ACTIVE, [], ALL_JOBS), ["1083", "1101", "1104"]);
});

test("clicking a full group clears exactly that group", () => {
  const next = nextSelectionForGroup(ACTIVE, ["1083", "1101", "1104"], ALL_JOBS);
  assert.deepEqual(next, []);
});

test("clicking a PARTIAL group fills it in rather than clearing it", () => {
  // A part-filled box invites completing it. Clearing on a mixed click would
  // silently discard the picks already made inside the group — the opposite of
  // what the tick appears to offer.
  const next = nextSelectionForGroup(ACTIVE, ["1101"], ALL_JOBS);
  assert.deepEqual(next, ["1083", "1101", "1104"]);
});

test("selecting one group does NOT disturb another group's selections", () => {
  // The request states this explicitly. Selecting all of Active while two
  // Complete jobs are picked must keep both.
  const next = nextSelectionForGroup(ACTIVE, ["0901", "0902"], ALL_JOBS);
  assert.deepEqual(next, ["1083", "1101", "1104", "0901", "0902"]);
});

test("deselecting one group leaves every other group's selections intact", () => {
  const everything = ALL_JOBS.map((j) => j.jobId);
  const next = nextSelectionForGroup(ACTIVE, everything, ALL_JOBS);
  assert.deepEqual(next, ["0901", "0902", "1200"], "only the Active ids come out");
});

test("the result is ordered by the full job list, so chips never reshuffle", () => {
  // Selected out of order, then a group added: the output must follow ALL_JOBS
  // order, not the order the user happened to click in.
  const next = nextSelectionForGroup(COMPLETE, ["1104", "1083"], ALL_JOBS);
  assert.deepEqual(next, ["1083", "1104", "0901", "0902"]);
});

test("clearing a group preserves the order of what remains", () => {
  const next = nextSelectionForGroup(COMPLETE, ["1083", "0901", "0902", "1200"], ALL_JOBS);
  assert.deepEqual(next, ["1083", "1200"]);
});

test("no duplicates when the group overlaps what is already selected", () => {
  const next = nextSelectionForGroup(ACTIVE, ["1083"], ALL_JOBS);
  assert.deepEqual(next, ["1083", "1101", "1104"]);
  assert.equal(new Set(next).size, next.length, "ids must be unique");
});

test("a search-narrowed group acts only on what is visible", () => {
  // JobSelect passes the FILTERED contents, so with a query active the header
  // selects what is shown beneath it — the only reading consistent with the
  // count on that same header, which is filtered too.
  const visible = [{ jobId: "1101" }];
  const next = nextSelectionForGroup(visible, [], ALL_JOBS);
  assert.deepEqual(next, ["1101"], "the other two Active jobs are not swept in");

  // And with only that one visible job selected, the narrowed group reads "all"
  // even though the wider Active group is not fully selected.
  assert.equal(groupSelectionState(visible, ["1101"]), "all");
  assert.equal(groupSelectionState(ACTIVE, ["1101"]), "some");
});

test("group selection is expressible as a plain id list — no parallel filter path", () => {
  // The request's "do not create a separate filtering system". The output is
  // just ?jobs= ids, indistinguishable from having clicked each job by hand,
  // which is what guarantees identical downstream filtering.
  const byHand = nextSelectionForGroup(ACTIVE, [], ALL_JOBS);
  const oneAtATime = ACTIVE.reduce<string[]>(
    (acc, j) => nextSelectionForGroup([j], acc, ALL_JOBS),
    [],
  );
  assert.deepEqual(oneAtATime, byHand, "one group click === clicking each member");
});
