import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_DATE_ANCHORS, ANCHOR_LABEL, STORED_ANCHORS } from "../src/lib/key-dates-anchors";

// ── The Dashboard's Key Dates timeline (2026-09-01) ─────────────────────────
//
// Replaced the month-grid Execution Calendar. The milestones are the SDC
// Scheduler's own `tasks.anchor_key` values, so these tests pin the vocabulary
// against the Scheduler's KEYDATES_ANCHORS list — if the two drift, the
// Dashboard and the Scheduler start disagreeing about what a milestone is.

test("the anchor list matches the Scheduler's own, in its order", () => {
  assert.deepEqual(
    KEY_DATE_ANCHORS.map((a) => a.key),
    ["receipt_of_po", "mech_release_1", "parts_panel_ready", "build_start", "machine_power_up", "fat", "ship_machine", "sat"],
  );
  assert.deepEqual(
    KEY_DATE_ANCHORS.map((a) => a.short),
    ["PO", "Mech 1", "Panel Ready", "Build Start", "Power-Up", "FAT", "Ship", "SAT"],
  );
});

test("Build Start is the only DERIVED anchor — it has no row to read", () => {
  // The Scheduler derives it from the first builder assignment rather than
  // storing it, which is why it cannot be fetched with the others.
  const derived = KEY_DATE_ANCHORS.filter((a) => a.derived).map((a) => a.key);
  assert.deepEqual(derived, ["build_start"]);
  assert.ok(!STORED_ANCHORS.includes("build_start"), "must never be queried as an anchor_key");
  assert.equal(STORED_ANCHORS.length, 7);
});

test("every anchor has a short label for its chip", () => {
  for (const a of KEY_DATE_ANCHORS) {
    assert.equal(ANCHOR_LABEL[a.key], a.short);
    assert.ok(a.short.length <= 12, `${a.short} is too long for a chip`);
  }
});

// ── The client boundary ─────────────────────────────────────────────────────

const LIB = join(process.cwd(), "src", "lib");

test("the anchor vocabulary is PURE, so the client timeline can import it", () => {
  // dashboard-key-dates.ts reaches the Scheduler database and is `server-only`.
  // The timeline is a client component and needs the anchor list to draw chips,
  // so the vocabulary lives in its own module. Value-importing the server one
  // would fail tests/client-boundary.test.ts — it did, on the first attempt.
  const pure = readFileSync(join(LIB, "key-dates-anchors.ts"), "utf8");
  // Match IMPORT STATEMENTS, not prose: the module's own header says the words
  // "server-only" and "mysql" while explaining that it uses neither, and the
  // first version of this test failed on exactly that.
  const imports = pure.split(/\r?\n/).filter((l) => /^\s*import\s/.test(l));
  assert.deepEqual(imports, [], `the vocabulary must import nothing at all, found: ${imports.join(" | ")}`);
  const server = readFileSync(join(LIB, "dashboard-key-dates.ts"), "utf8");
  assert.ok(server.includes('import "server-only"'), "the query half stays server-only");
});

test("the timeline never imports the server module by value", () => {
  const ui = readFileSync(join(process.cwd(), "src", "components", "dashboard", "KeyDatesTimeline.tsx"), "utf8");
  assert.ok(!/^import \{[^}]*\} from "@\/lib\/dashboard-key-dates"/m.test(ui), "value import would bundle the database");
});

// ── The rows the timeline is built from ─────────────────────────────────────

test("a job number is taken from the project NAME when the column is unset", () => {
  // Requiring projects.job_number silently dropped two real rows the first time:
  // 1165_Johnson Matthey and 1163_Haemonetics both carry a Mech 1 release and a
  // NULL job_number, so the Dashboard timeline was two rows short against the
  // Scheduler's own view. Every schedule is named "<job>_<customer>_<desc>".
  const db = readFileSync(join(LIB, "scheduler-db.ts"), "utf8");
  assert.ok(db.includes("function jobNumberFor"), "the fallback must exist");
  assert.ok(
    !/anchor_key IN \(\?\)[\s\S]{0,400}?job_number IS NOT NULL/.test(db),
    "the anchor query must not require a job_number again",
  );
});

test("a schedule with no job number anywhere is excluded", () => {
  // Removing the job_number filter let SDC_StandardProject_Template through — it
  // carries is_template = 0 despite the name. Dropping on "no number in the
  // column OR the name" excludes it while keeping 1165/1163.
  const db = readFileSync(join(LIB, "scheduler-db.ts"), "utf8");
  assert.ok(db.includes('jobNumberFor(r.job_number, r.project) !== ""'), "both reads must filter on the derived number");
});

test("the timeline is what the Dashboard renders — the month grid is gone", () => {
  const section = readFileSync(join(process.cwd(), "src", "components", "dashboard", "ExecutionCalendar.tsx"), "utf8");
  assert.ok(section.includes("KeyDatesTimeline"), "the section must render the timeline");
  assert.ok(!section.includes("monthGrid"), "the month-grid builder should have been removed with it");
  assert.ok(!/view === "calendar"/.test(section), "the calendar branch is now the timeline branch");
  assert.ok(section.includes('"upcoming"'), "Upcoming is preserved");
});
