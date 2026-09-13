import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── "No Purchase Order" card vs. Parts List "Uncovered (no PO)" filter ──────
//
// Reported bug: the risk card showed ~8 parts while the Parts-List filter for
// the exact same job showed 2. The card computed its own "no PO" set with a
// raw `!poNumber` check (plus a part-number dedup on top of an already
// id-deduped list) instead of reusing the canonical, release-status/stock/
// process-aware `status === "noPO"` the Parts List filter and the readiness
// summary already used — so it counted every stock- and process-covered part
// (which legitimately has no PO) as a gap.
//
// job-bom-rules.ts exports `isUncoveredPart` as the one rule; this is a
// source-shape regression guard (same convention as
// tests/job-procurement-collapse.test.ts — no React test renderer in this
// repo) pinning down that every call site routes through it, and that the old
// raw-PO-null pattern doesn't come back.
//
// ── Why this guard had to be rewritten (2026-08-28) ─────────────────────────
//
// It asserted the card's filter appeared literally in JobProcurement.tsx as
// `const noPo = parts.filter(isUncoveredPart);`. That computation was later
// (correctly) extracted into lib/procurement-risk.ts's computeRiskCards, so
// the pattern left the file this guard was reading — and the guard went red
// and STAYED red. A permanently failing guard protects nothing: it is
// indistinguishable from the bug it exists to catch, and it teaches everyone
// to scroll past a real signal.
//
// It now reads whichever module actually owns each computation, and adds the
// check that matters more than any single call site: that no file re-derives
// coverage from a raw PO field or a bare status compare.

const SRC = join(import.meta.dirname, "..", "src");

/** Drop comments, so a rule merely NAMED in prose is never read as a call site. */
function strip(raw: string): string {
  const blockJsx = /\{\/\*[\s\S]*?\*\/\}/g;
  const block = /\/\*[\s\S]*?\*\//g;
  const wholeLine = /^\s*\/\/.*$/gm;
  const trailing = /\/\/[^\n"'`]*$/gm;
  return raw.replace(blockJsx, "").replace(block, "").replace(wholeLine, "").replace(trailing, "");
}

const CODE = strip(readFileSync(join(SRC, "components", "JobProcurement.tsx"), "utf8"));
const RISK_RAW = readFileSync(join(SRC, "lib", "procurement-risk.ts"), "utf8");
const RISK = strip(RISK_RAW);

test("JobProcurement imports the centralized isUncoveredPart rule", () => {
  assert.match(CODE, /import \{[^}]*\bisUncoveredPart\b[^}]*\} from "@\/lib\/job-bom-rules";/);
});

test("the No Purchase Order risk card counts via isUncoveredPart, not a raw PO-null check", () => {
  // The card's own computation lives in computeRiskCards now, not in the
  // component — so this reads the module that owns it rather than the file it
  // used to live in.
  assert.match(RISK_RAW, /import \{[^}]*\bisUncoveredPart\b[^}]*\} from "\.\/job-bom-rules";/);
  assert.match(RISK, /const noPo = parts\.filter\(isUncoveredPart\);/);
  // The exact original defect: a bare `if (p.poNumber) return false` treats
  // "no PO" as "missing", which is wrong the moment a part is covered by stock
  // or an in-house process schedule.
  assert.doesNotMatch(
    RISK,
    /if \(!?p\.poNumber\) return false;\s*$/m,
    "the risk card must not re-derive coverage from a raw poNumber check",
  );
});

test("no surface re-derives uncovered from a bare status compare", () => {
  // build-readiness-tree.ts counted `p.status === "noPO"` without the `!hold`
  // half of the rule (found 2026-08-28), making it the one view that could
  // disagree with the card, the Parts List and build-readiness-sync. Measured
  // across all parts on live jobs at the time: 15 vs 7 on job 1122 and 315 vs
  // 300 on 1130, the difference being exactly their held parts.
  //
  // po-detail.ts's partStatus is the deliberate exception and is NOT listed:
  // it maps a part to a display badge and returns "hold" on the line above, so
  // its "noPO" branch is hold-free by construction.
  const files = ["build-readiness-tree.ts", "build-readiness-sync.ts", "procurement-risk.ts"];
  for (const file of files) {
    const src = strip(readFileSync(join(SRC, "lib", file), "utf8"));
    assert.doesNotMatch(
      src,
      /status === "noPO"/,
      `${file} must call isUncoveredPart rather than comparing status directly — a held part still carries status "noPO"`,
    );
  }
});

test("the readiness summary's uncovered count uses isUncoveredPart", () => {
  assert.match(CODE, /const noPO = parts\.filter\(isUncoveredPart\)\.length;/);
});

test('the Parts List "Uncovered (no PO)" filter uses isUncoveredPart for the noPO status', () => {
  // 2026-08-15: Status became a checkbox multi-select (any number of statuses
  // at once, by request), so the single-status ternary this used to pin
  // became an OR across every currently-selected status — same per-status
  // rule as before (noPO still resolves via isUncoveredPart, not p.st.key),
  // just no longer limited to exactly one at a time.
  assert.match(
    CODE,
    /s === "noPO" \? isUncoveredPart\(p\) : p\.st\.key === s/,
    "the noPO branch of the status filter must call the same rule as the card and the summary",
  );
});

test("the Uncovered (no PO) filter option is still present and labeled", () => {
  assert.match(CODE, /\{ value: "noPO", label: "Uncovered \(no PO\)" \}/);
});

test("the three risk cards are mounted once, above the tab switch", () => {
  // They used to render inside PartsListTab, so the Assemblies view had no
  // cards at all (2026-08-28). Mounted once at the top of JobProcurement, both
  // tabs share ONE instance — which is what makes "counts must match between
  // tabs" true by construction rather than by two code paths agreeing.
  const mount = CODE.indexOf("<RiskCards");
  const tabs = CODE.indexOf('active={tab === "assemblies"}');
  assert.notEqual(mount, -1, "RiskCards is not mounted anywhere");
  assert.equal(CODE.split("<RiskCards").length - 1, 1, "RiskCards must be mounted exactly once, not per tab");
  assert.ok(mount < tabs, "RiskCards must render above the tab chips so both tabs show it");
});
