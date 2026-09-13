import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ETC_DEPARTMENTS,
  canManageDepartment,
  completionCaption,
  departmentBlockMessage,
  departmentByCode,
  departmentCellKey,
  departmentIssues,
  fillDepartments,
  DEPARTMENT_COLUMN,
  incompleteDepartmentLabels,
  joinLabels,
  parseDepartmentCellKey,
  parseDepartmentOwners,
  type DepartmentCompletion,
} from "../src/lib/etc-departments";

// ── The department ETC sign-off (§50) ────────────────────────────────────────
//
// What is worth pinning here is the part that is a DECISION rather than a database row:
// which departments exist, who may tick a box, and the two multi-user properties §50
// names — a duplicate request must not flip anything, and a stale session must not
// overwrite a newer status. Those last two are properties of the KEY and of the
// absolute-value write, both of which are testable without a database.

// ── The list ────────────────────────────────────────────────────────────────

test("five departments, in the order the work moves through them", () => {
  assert.deepEqual(
    ETC_DEPARTMENTS.map((d) => d.label),
    ["PM", "ME", "CE", "Mechanical Build", "Electrical Build and Wire"],
  );
});

test("the Electrical Build rename did not change its stored code", () => {
  // The label went from "Electrical Build" to "Electrical Build and Wire" when the two
  // boxes were merged. A rename that moved the code would orphan every row already
  // stored against the old one — which is the entire reason code and label are separate
  // fields, so it is worth a test rather than a comment.
  const elec = ETC_DEPARTMENTS.find((d) => d.label.startsWith("Electrical Build"));
  assert.equal(elec?.code, "elec-build");
  // And the separate "wire" department is gone, not merely hidden.
  assert.equal(departmentByCode("wire"), null);
});

test("codes are unique, lowercase and free of the key separator", () => {
  const codes = ETC_DEPARTMENTS.map((d) => d.code);
  assert.equal(new Set(codes).size, codes.length, "a duplicate code would collide on the unique index");
  for (const c of codes) {
    assert.equal(c, c.toLowerCase(), `${c} must be lowercase — departmentByCode lowercases its input`);
    // The realtime key is `deptEtcComplete__<month>__<code>`; a code containing the
    // separator would parse back as the wrong department on every other browser.
    assert.ok(!c.includes("__"), `${c} must not contain the cell-key separator`);
  }
});

test("the toolbar's short names are distinct, and never longer than the full label", () => {
  // The strip shares a row with the month picker, View, Export and the Standards
  // buttons; `short` is what keeps that row on one line. A short name that duplicated
  // another would put two identical checkboxes in the toolbar.
  const shorts = ETC_DEPARTMENTS.map((d) => d.short);
  assert.equal(new Set(shorts).size, shorts.length, "two departments would look identical");
  for (const d of ETC_DEPARTMENTS) {
    assert.ok(d.short.trim().length > 0, `${d.code} needs a visible name`);
    assert.ok(d.short.length <= d.label.length, `${d.code}: short must not be longer than the label`);
  }
});

test("the blocked-submission sentence uses the FULL label, not the short one", () => {
  // The toolbar abbreviates because it is a toolbar. A message telling somebody the
  // month cannot be submitted should say the department's name.
  assert.match(departmentBlockMessage(["Electrical Build and Wire"]) ?? "", /Electrical Build and Wire/);
  assert.deepEqual(incompleteDepartmentLabels([]).slice(-1), ["Electrical Build and Wire"]);
});

test("every department has a full name that is not just its abbreviation", () => {
  // The checkbox's accessible name uses it. "ME" and "CE" are not words, and a control
  // announced as "C E" tells a screen-reader user nothing.
  for (const d of ETC_DEPARTMENTS) {
    assert.ok(d.fullName.length > d.label.length || d.fullName === d.label, d.code);
    assert.ok(d.fullName.trim().length > 2, `${d.code} needs a spoken name`);
  }
});

// ── Filling the gaps ────────────────────────────────────────────────────────

test("a department with no stored row is incomplete, not missing", () => {
  // The table only holds rows for departments somebody has touched. "No row" and
  // "unticked" are the same fact, and every caller must see the full list either way.
  const filled = fillDepartments([{ code: "pm", completed: true, completedBy: "Lisa", completedAt: null }]);
  assert.equal(filled.length, ETC_DEPARTMENTS.length);
  assert.equal(filled[0].completed, true);
  assert.ok(filled.slice(1).every((f) => !f.completed));
});

test("the blocker names the departments that have not signed off", () => {
  const statuses: DepartmentCompletion[] = [
    { code: "pm", completed: true, completedBy: "Lisa", completedAt: null },
    { code: "me", completed: true, completedBy: "Dan", completedAt: null },
    { code: "mech-build", completed: true, completedBy: "Joe", completedAt: null },
  ];
  assert.deepEqual(incompleteDepartmentLabels(statuses), ["CE", "Electrical Build and Wire"]);
});

test("the blocked sentence reads the way §50 specifies", () => {
  assert.equal(departmentBlockMessage(["CE", "Wire"]), "Submission blocked: CE and Wire have not completed their ETC review.");
  // One department takes the singular verb — "CE have not completed" is the kind of
  // thing that gets a feature described as unfinished.
  assert.equal(departmentBlockMessage(["CE"]), "Submission blocked: CE has not completed their ETC review.");
  // Nothing outstanding is not a message. The caller falls through to the next blocker.
  assert.equal(departmentBlockMessage([]), null);
});

test("the English list joins without an Oxford comma", () => {
  assert.equal(joinLabels([]), "");
  assert.equal(joinLabels(["PM"]), "PM");
  assert.equal(joinLabels(["PM", "CE"]), "PM and CE");
  assert.equal(joinLabels(["PM", "CE", "Wire"]), "PM, CE and Wire");
});

// ── The issues the submission gate is handed (§50) ──────────────────────────

test("each outstanding department becomes one blocking issue", () => {
  const issues = departmentIssues("2026-07", ["CE", "Wire"]);
  assert.equal(issues.length, 2);
  assert.equal(issues[0].section, "Monthly ETC");
  assert.equal(issues[0].department, "CE");
  assert.equal(issues[0].column, "Department ETC Complete");
  // The month, not a job — a rowRef naming a job would send someone to a grid row that
  // is perfectly fine.
  assert.equal(issues[0].rowRef, "2026-07");
  // And the reason says WHERE the fix is, not just that something is wrong.
  assert.match(issues[0].reason, /Tick its box in the checklist/);
  assert.match(issues[0].reason, /2026-07/);
});

test("a fully signed-off month contributes no issues", () => {
  assert.deepEqual(departmentIssues("2026-07", []), []);
});

test("the issue column matches the one the audit log writes", () => {
  // A history search for a department's sign-off uses this string. Two spellings would
  // mean the blocked list and the audit trail describe the same thing differently.
  assert.equal(departmentIssues("2026-07", ["PM"])[0].column, DEPARTMENT_COLUMN);
});

// ── Permission (§50 — backend authorization) ────────────────────────────────

test("nobody signed in may tick anything", () => {
  const owners = parseDepartmentOwners(undefined);
  assert.equal(canManageDepartment({ email: null }, "pm", owners), false);
  // Not even an ELT role with no session — role without an identity is not an identity.
  assert.equal(canManageDepartment({ email: null, role: "ELT" }, "pm", owners), false);
});

test("with no owners configured, any signed-in user may tick — the app's existing grain", () => {
  const owners = parseDepartmentOwners(undefined);
  for (const d of ETC_DEPARTMENTS) {
    assert.equal(canManageDepartment({ email: "someone@sdc.com" }, d.code, owners), true, d.code);
  }
});

test("a configured department is restricted to its owners", () => {
  const owners = parseDepartmentOwners("ce:dan@sdc.com|xiao@sdc.com");
  assert.equal(canManageDepartment({ email: "dan@sdc.com" }, "ce", owners), true);
  assert.equal(canManageDepartment({ email: "nobody@sdc.com" }, "ce", owners), false);
  // Case and surrounding space come from a hand-edited .env and from a login form.
  assert.equal(canManageDepartment({ email: " Dan@SDC.com " }, "ce", owners), true);
  // An UNconfigured department beside a configured one stays open. Listing one owner
  // must not lock the other four — that would be a config change with a blast radius
  // nobody expects.
  assert.equal(canManageDepartment({ email: "nobody@sdc.com" }, "pm", owners), true);
});

test("an ELT user may tick a department they do not own", () => {
  const owners = parseDepartmentOwners("ce:dan@sdc.com");
  assert.equal(canManageDepartment({ email: "abhi@sdc.com", role: "ELT" }, "ce", owners), true);
});

test("an unknown department is refused, however privileged the actor", () => {
  // The action would otherwise create a row for a department the checklist never shows —
  // invisible, and permanently blocking submission if the gate counted it.
  const owners = parseDepartmentOwners(undefined);
  assert.equal(canManageDepartment({ email: "abhi@sdc.com", role: "ELT" }, "wire", owners), false);
  assert.equal(canManageDepartment({ email: "abhi@sdc.com", role: "ELT" }, "", owners), false);
});

test("a malformed owners string does not lock everybody out", () => {
  // Hand-edited in a .env on a server. A stray comma, a missing colon or a department
  // that no longer exists must degrade to "unconfigured", never to "nobody".
  for (const raw of ["", "   ", ",,,", "pm", "pm:", ":a@b.com", "nosuchdept:a@b.com", "pm:  |  "]) {
    const owners = parseDepartmentOwners(raw);
    assert.equal(canManageDepartment({ email: "someone@sdc.com" }, "pm", owners), true, `raw=${JSON.stringify(raw)}`);
  }
});

test("owners parse across departments and accumulate", () => {
  const owners = parseDepartmentOwners("pm:a@x.com,ce:b@x.com|c@x.com,pm:d@x.com");
  assert.deepEqual([...(owners.get("pm") ?? [])].sort(), ["a@x.com", "d@x.com"]);
  assert.equal(owners.get("ce")?.size, 2);
});

// ── The realtime key (§50 — live updates, without wrong ones) ───────────────

test("the cell key round-trips month and department", () => {
  const key = departmentCellKey("2026-07", "elec-build");
  assert.deepEqual(parseDepartmentCellKey(key), { month: "2026-07", code: "elec-build" });
});

test("the key parser ignores every other event on the feed", () => {
  // The change feed carries every cell in the app. A parser that matched loosely would
  // have a New ETC edit toggling a checkbox on five other people's screens.
  for (const other of [undefined, "", "newEtcOverride__123", "quoted__41__10-211", "deptEtcComplete__", "deptEtcComplete__2026-07__nope"]) {
    assert.equal(parseDepartmentCellKey(other), null, String(other));
  }
});

test("a key for a different month is still parsed — the caller filters", () => {
  // Deliberate: the component compares the month itself, so an August event arriving in
  // a July tab is DROPPED by the component rather than silently mis-parsed here. Parsing
  // it correctly is what makes that comparison possible.
  assert.deepEqual(parseDepartmentCellKey(departmentCellKey("2026-08", "pm")), { month: "2026-08", code: "pm" });
});

// ── The caption (kept for the tooltip) ──────────────────────────────────────

test("an unticked department says so plainly", () => {
  assert.equal(completionCaption({ code: "pm", completed: false, completedBy: null, completedAt: null }), "Not complete");
});

test("a ticked department names who and when", () => {
  const at = new Date(2026, 6, 15, 14, 35);
  const caption = completionCaption(
    { code: "pm", completed: true, completedBy: "Lisa", completedAt: at.toISOString() },
    at,
  );
  // §50's example: "Completed by Lisa at 2:35 PM".
  assert.match(caption, /^Completed by Lisa at 2:35 ?\s?PM$/);
});

test("once it is not today, the caption carries the date too", () => {
  const at = new Date(2026, 6, 15, 14, 35);
  const later = new Date(2026, 6, 18, 9, 0);
  const caption = completionCaption({ code: "pm", completed: true, completedBy: "Lisa", completedAt: at.toISOString() }, later);
  // "at 2:35 PM" alone is a lie by Wednesday — it reads as this afternoon.
  assert.match(caption, /Jul 15/);
});

test("a ticked department with no timestamp still names the person", () => {
  // The optimistic state between the click and the server's answer.
  assert.equal(
    completionCaption({ code: "pm", completed: true, completedBy: "Lisa", completedAt: null }),
    "Completed by Lisa",
  );
  assert.equal(
    completionCaption({ code: "pm", completed: true, completedBy: null, completedAt: null }),
    "Completed by someone",
  );
});
