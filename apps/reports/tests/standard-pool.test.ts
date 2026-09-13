import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  poolCategoryForPunch,
  POOL_CATEGORIES,
  POOL_QUOTED_SECTION,
  ETC_TRACKED_CODES,
  RESTRICTED_SECTION_CODES,
} from "../src/lib/sections";

// The four Standard Fees pools and the punch-bucketing behind their "Hours
// Worked this Month". The buckets were pinned against the archived Power BI
// figures on 2026-07-31 (scripts/_recon_pool_local_dryrun.ts): both Warranty
// pools reproduce the stored value exactly for 2026-02/04/05, and Manufacturing
// lands within 0.03h for 2026-04. These tests hold that mapping in place.

test("the four pools are exactly the sections the ETC grid excludes", () => {
  // Not a coincidence to be tidied away later: PM, Manufacturing and both
  // Warranty phases have no grid column BECAUSE they are planned company-wide
  // in these pools instead of job by job.
  for (const category of POOL_CATEGORIES) {
    assert.equal(
      ETC_TRACKED_CODES.has(POOL_QUOTED_SECTION[category]),
      false,
      `${category}'s section ${POOL_QUOTED_SECTION[category]} must not also be an ETC grid column`,
    );
  }
  assert.equal(new Set(Object.values(POOL_QUOTED_SECTION)).size, 4);
});

test("PM and Manufacturing bucket from phase 10 only", () => {
  assert.equal(poolCategoryForPunch("10", "111"), "ENGINEERING_PM");
  // The punch data books manufacturing to 414; 413 is the app's column code.
  assert.equal(poolCategoryForPunch("10", "414"), "SHOP_MANUFACTURING");
  assert.equal(poolCategoryForPunch("10", "413"), "SHOP_MANUFACTURING");

  // Counting 414 in every phase ran ~40h/month above the archived figure, and
  // would contradict the app's own alias, which maps 10-414 and no other.
  assert.equal(poolCategoryForPunch("40", "414"), null);
  assert.equal(poolCategoryForPunch("50", "414"), null);
  assert.equal(poolCategoryForPunch("40", "111"), null);
});

test("warranty splits into engineering and shop by function", () => {
  for (const fn of ["211", "311", "312", "313"]) {
    assert.equal(poolCategoryForPunch("70", fn), "ENGINEERING_WARRANTY", `70-${fn}`);
  }
  for (const fn of ["411", "412"]) {
    assert.equal(poolCategoryForPunch("70", fn), "SHOP_WARRANTY", `70-${fn}`);
  }
});

test("everything else buckets nowhere rather than into the nearest pool", () => {
  // Ordinary Design & Build engineering — belongs to the grid, not a pool.
  assert.equal(poolCategoryForPunch("10", "211"), null);
  assert.equal(poolCategoryForPunch("10", "312"), null);
  assert.equal(poolCategoryForPunch("10", "411"), null);
  // Phases the app does not model at all.
  assert.equal(poolCategoryForPunch("80", "311"), null);
  assert.equal(poolCategoryForPunch("90", "411"), null);
  // Junk in, null out — never a wrong bucket.
  assert.equal(poolCategoryForPunch("", ""), null);
});

test("every pool category has a quoted section, and vice versa", () => {
  assert.equal(POOL_CATEGORIES.length, 4);
  for (const category of POOL_CATEGORIES) {
    assert.ok(POOL_QUOTED_SECTION[category], `${category} has no quoted section`);
  }
  assert.deepEqual(
    [...POOL_CATEGORIES].sort(),
    Object.keys(POOL_QUOTED_SECTION).sort(),
  );
});

// The Projects grid hides these four behind its password gate (projects-gate.ts).
// Pinned because the consequence of the set silently shrinking is a section
// becoming visible to everyone with no error anywhere — the quiet kind of
// failure, not the loud kind.
test("the gated Projects sections are exactly the four pool sections", () => {
  assert.deepEqual([...RESTRICTED_SECTION_CODES].sort(), ["10-111", "10-413", "70-211", "70-411"]);
});

test("the gated set stays derived from the pool sections, not hand-listed", () => {
  // Same membership, checked from the other direction: if someone adds a fifth
  // pool, the gate must pick it up without a second edit.
  assert.equal(RESTRICTED_SECTION_CODES.size, Object.keys(POOL_QUOTED_SECTION).length);
  for (const code of Object.values(POOL_QUOTED_SECTION)) {
    assert.ok(RESTRICTED_SECTION_CODES.has(code), `${code} is a pool section but isn't gated`);
  }
});

// ── Why an eligible new project can contribute ZERO pool hours ──────────────
//
// The 1169 report (2026-09-01): "Job 1169 is being excluded from New projects
// this month" — Active, Billable, Custom, started 2026-08-11, quoted 11
// sections. It was never excluded from the membership rule; it contributed
// 0/0/0/0 because none of its 11 quoted sections is one of the four the
// Standard Fees pools are built from, and zero-contribution rows were being
// dropped from the panel.
//
// This is the structural fact behind that, and it is why the situation is
// normal rather than a bug: the pool sections and the ETC grid's sections are
// DISJOINT sets. A job quoted only for grid departments necessarily adds
// nothing to these pools.
test("the four pool sections are disjoint from the ETC grid's tracked codes", () => {
  const poolCodes = Object.values(POOL_QUOTED_SECTION);
  assert.equal(poolCodes.length, 4);
  for (const code of poolCodes) {
    assert.ok(
      !ETC_TRACKED_CODES.has(code),
      `${code} is both a pool section and an ETC grid column — the two must not overlap or New Hours Added would double-count against the grid`,
    );
  }
});

test("a job quoted only for ETC grid sections contributes nothing to any pool", () => {
  // Job 1169's real quoted set, verbatim from the database on 2026-09-01.
  const quoted1169 = [
    "10-211", "10-312", "10-313", "10-515", "10-517",
    "10-518", "10-411", "10-412", "40-211", "40-411", "50-411",
  ];
  const poolCodes = new Set<string>(Object.values(POOL_QUOTED_SECTION));
  const overlap = quoted1169.filter((c) => poolCodes.has(c));
  assert.deepEqual(overlap, [], "1169 quoted none of the pool sections — 0/0/0/0 is the correct contribution");
  // And it IS a real quote: the job is not unquoted, which is the distinction
  // the panel now makes visible instead of hiding.
  assert.ok(quoted1169.length > 0);
});

// ── The panel opens CLOSED (2026-09-02) ─────────────────────────────────────
//
// It defaulted to `useState(true)`, so anyone with standards:view lost 320px of the
// Monthly ETC grid on arrival whether they wanted the panel or not. Permission to
// open a panel is not a request to have it open — and the two are easy to conflate
// again, since the role check and the collapse state live in different components.
// Source-level assertions because this is a `"use client"` component with no DOM in
// this suite; the behaviour itself was driven in the running app.

test("the Standard Fees panel starts collapsed, and only a reload can restore it open", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "StandardPoolPanel.tsx"), "utf8");
  assert.match(src, /const \[open, setOpen\] = useState\(false\)/, "the panel must not initialize expanded");
  // Only a genuine reload restores. A client-side navigation into Monthly ETC is a
  // fresh entry and must start collapsed, however the tab was left earlier.
  assert.match(src, /nav\?\.type === "reload"/);
  assert.match(src, /sessionStorage/, "session-only: a saved preference would reinstate the old default");
  // Comments stripped first — the note explaining why localStorage is wrong here
  // mentions it by name, and a guard that trips on its own documentation gets deleted.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/localStorage/.test(code), "localStorage would carry an expanded panel into a future visit");
});

test("both toggles write through the one setter, so the marker cannot drift", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "StandardPoolPanel.tsx"), "utf8");
  // A stray setOpen would change the panel without updating what a reload restores.
  const strays = src.match(/setOpen\(/g) ?? [];
  assert.equal(strays.length, 2, "expected only the reload restore and setPanelOpen's own call");
  assert.match(src, /onClick=\{\(\) => setPanelOpen\(true\)\}/, "the collapsed rail expands");
  assert.match(src, /onClick=\{\(\) => setPanelOpen\(false\)\}/, "the header collapses");
});

test("the header's collapse target spans the bar, not just the chevron", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "StandardPoolPanel.tsx"), "utf8");
  const header = src.slice(src.indexOf("aria-expanded={open}") - 400, src.indexOf("aria-expanded={open}") + 200);
  assert.match(header, /flex-1/, "the toggle should fill the header width");
});

test("an unauthorized role gets no panel at all — not a collapsed one", () => {
  // Criterion 3 is about reserved space as much as secrecy: the rail, the header and
  // the gap must all be absent, which is what returning null (rather than rendering a
  // collapsed aside) achieves. `initialData` is null for a role without standards:view.
  const card = readFileSync(join(process.cwd(), "src", "components", "StandardFeesCard.tsx"), "utf8");
  assert.match(card, /const show = initialData != null && !hidden;/);
  assert.match(card, /if \(!show\) return null;/);
});
