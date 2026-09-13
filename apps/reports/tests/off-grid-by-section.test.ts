import { test } from "node:test";
import assert from "node:assert/strict";
import { offGridBySection, compareSections, type OffGridJob } from "../src/lib/off-grid-hours";

// "Hours off the grid", split by section (2026-08-03, by request).
//
// The invariant to protect: the by-section view and the by-job view must total the same
// figure, because the card above them shows that total too and all three are on screen
// at once. A section rollup that dropped or double-counted a job's hours would put three
// different numbers in front of the reader for the same thing.

// July 2026's actual off-grid set, from the drill panel.
const JULY: OffGridJob[] = [
  {
    jobId: "4000",
    jobName: "Non-Billable",
    status: "Active",
    hours: 170,
    sections: [
      { section: "10-313", hours: 71 },
      { section: "10-211", hours: 37 },
      { section: "10-411", hours: 33 },
      { section: "10-312", hours: 29 },
    ],
  },
  { jobId: "1083", jobName: "SDC Showroom", status: "Active", hours: 7, sections: [{ section: "10-412", hours: 7 }] },
  { jobId: "7000", jobName: "Team Inititives", status: "Active", hours: 4, sections: [{ section: "10-312", hours: 4 }] },
];

const jobTotal = (jobs: OffGridJob[]) => jobs.reduce((s, j) => s + j.hours, 0);
const sectionTotal = (jobs: OffGridJob[]) => offGridBySection(jobs).reduce((s, x) => s + x.hours, 0);

test("the two views total the same hours", () => {
  assert.equal(jobTotal(JULY), 181);
  assert.equal(sectionTotal(JULY), 181);
});

test("a section shared by two jobs is summed, and both jobs are named", () => {
  // 10-312 is 29h on job 4000 and 4h on job 7000. Getting this wrong is the whole
  // reason a rollup can disagree with its source.
  const rows = offGridBySection(JULY);
  const shared = rows.find((r) => r.section === "10-312")!;
  assert.equal(shared.hours, 33);
  assert.deepEqual(shared.jobIds, ["4000", "7000"]);
});

test("one row per distinct section, no duplicates", () => {
  const rows = offGridBySection(JULY);
  assert.equal(rows.length, 5); // 10-313, 10-211, 10-411, 10-312, 10-412
  assert.equal(new Set(rows.map((r) => r.section)).size, rows.length);
});

test("ordered like the Monthly ETC grid's columns, NOT by hours", () => {
  // 2026-08-03, by request. The grid's column order is the sheet's order and it is what
  // a reader already has in their head; a second ordering on the same set of sections
  // costs them a re-orientation for nothing.
  const rows = offGridBySection(JULY);
  const order = rows.map((r) => r.section);
  const expected = [...order].sort(compareSections);
  assert.deepEqual(order, expected);
  // Explicitly: 10-211 (ME Gen) precedes 10-313 (Software) even though Software has far
  // more hours — which is exactly what the old hours-descending sort got wrong.
  assert.ok(order.indexOf("10-211") < order.indexOf("10-313"), `got ${order.join(", ")}`);
  const software = rows.find((r) => r.section === "10-313")!;
  assert.equal(software.hours, 71);
});

test("a section the app does not model sorts after every grid column", () => {
  // It must not interleave with the real columns, and it must not vanish.
  const rows = offGridBySection([
    { jobId: "1", jobName: "a", status: null, hours: 8, sections: [{ section: "99-999", hours: 3 }, { section: "10-211", hours: 5 }] },
  ]);
  assert.deepEqual(rows.map((r) => r.section), ["10-211", "99-999"]);
  assert.equal(rows.reduce((s, r) => s + r.hours, 0), 8);
});

test("section codes are given their names", () => {
  // Canonical wording (2026-08-20) — see paylocity-canonical.ts. "ME Gen"/"Design &
  // Drawings" were sections.ts's own hand-typed abbreviations; the name now comes
  // straight from the centralized Function-ID vocabulary.
  const rows = offGridBySection(JULY);
  assert.equal(rows.find((r) => r.section === "10-211")!.name, "General");
  assert.equal(rows.find((r) => r.section === "10-312")!.name, "System Design & Drawings");
});

test("an unrecognised code still counts, just unnamed", () => {
  // Dropping it would break the totals; the code alone is still actionable.
  const rows = offGridBySection([
    { jobId: "9999", jobName: "Odd", status: null, hours: 5, sections: [{ section: "99-999", hours: 5 }] },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hours, 5);
  assert.equal(rows[0].name, undefined);
});

test("no off-grid jobs means no rows and a zero total", () => {
  assert.deepEqual(offGridBySection([]), []);
  assert.equal(sectionTotal([]), 0);
});

test("a job listed twice for one section cannot double-list the job id", () => {
  // Upstream sums per section, so this shouldn't arise — but the hours must still add
  // up and the job must appear once.
  const rows = offGridBySection([
    {
      jobId: "4000",
      jobName: "Non-Billable",
      status: "Active",
      hours: 10,
      sections: [
        { section: "10-211", hours: 6 },
        { section: "10-211", hours: 4 },
      ],
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hours, 10);
  assert.deepEqual(rows[0].jobIds, ["4000"]);
});

test("fractional hours are not rounded away in the rollup", () => {
  const rows = offGridBySection([
    { jobId: "1", jobName: "a", status: null, hours: 0.4, sections: [{ section: "10-211", hours: 0.4 }] },
    { jobId: "2", jobName: "b", status: null, hours: 0.3, sections: [{ section: "10-211", hours: 0.3 }] },
  ]);
  assert.ok(Math.abs(rows[0].hours - 0.7) < 1e-9);
});
