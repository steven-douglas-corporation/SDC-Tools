import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAdoptRemoteValue } from "../src/components/ProjectsRemoteCells";
import { BASELINE_ATTR } from "../src/lib/dirty-form";

// Whether a colleague's saved value may overwrite what is on screen (§33.1, §33.10).
//
// Both directions cost real work if wrong: refusing too often leaves the stale display
// this component exists to fix, and adopting too eagerly destroys someone's typing or
// fights a controlled React component. The MoneyCell case below is one I actually got
// wrong first time round and only found by reading the component — it typechecks, lints
// and builds either way.

// A minimal stand-in for a DOM element. Node has no DOM, and the rule only touches
// four things — the two attributes, `value`, and (for selects) `options` — so a fake is
// honest here and keeps the test dependency-free like the rest of this suite.
function fakeCell(opts: {
  value: string;
  baseline?: string | null;
  adoptable?: boolean;
  select?: string[]; // option values; presence makes it a <select>
}) {
  const attrs = new Map<string, string>();
  if (opts.adoptable !== false) attrs.set("data-remote-adopt", "");
  if (opts.baseline !== null && opts.baseline !== undefined) attrs.set(BASELINE_ATTR, opts.baseline);
  const el = {
    value: opts.value,
    hasAttribute: (n: string) => attrs.has(n),
    getAttribute: (n: string) => (attrs.has(n) ? attrs.get(n)! : null),
    ...(opts.select ? { options: opts.select.map((v) => ({ value: v })) } : {}),
  };
  // shouldAdoptRemoteValue uses `instanceof HTMLSelectElement`, which does not exist in
  // Node. Stub the globals so the check is exercised rather than skipped: a plain input
  // must fail the instanceof, a select must pass it.
  return el as unknown as HTMLInputElement | HTMLSelectElement;
}

// Stand-in constructors for the two instanceof checks.
class FakeSelect {}
class FakeInput {}
Object.defineProperty(globalThis, "HTMLSelectElement", { value: FakeSelect, configurable: true, writable: true });
Object.defineProperty(globalThis, "HTMLInputElement", { value: FakeInput, configurable: true, writable: true });
function asSelect(el: unknown): HTMLSelectElement {
  Object.setPrototypeOf(el as object, FakeSelect.prototype);
  return el as HTMLSelectElement;
}

test("an untouched cell adopts the colleague's value", () => {
  // The case the whole component exists for: server sent 40, user never touched it,
  // somebody else saved 72.
  const el = fakeCell({ value: "40", baseline: "40" });
  assert.equal(shouldAdoptRemoteValue(el, "72"), true);
});

test("a cell the user has typed in is left completely alone", () => {
  // Their edit wins on screen; the server decides whose WRITE wins via the __base__
  // belief token. Overwriting here would delete typing in progress.
  const el = fakeCell({ value: "99", baseline: "40" });
  assert.equal(shouldAdoptRemoteValue(el, "72"), false);
});

test("a controlled cell is never touched, even when it looks clean", () => {
  // MoneyCell (Parts Cost Quoted / Actual): its posted field is a React-controlled
  // hidden input whose value and data-baseline are both re-stated on every render, so a
  // DOM write is reverted and the baseline write fights React. It also self-adopts
  // already. Missing the marker is what keeps this component away from it.
  const el = fakeCell({ value: "1200", baseline: "1200", adoptable: false });
  assert.equal(shouldAdoptRemoteValue(el, "1500"), false);
});

test("a cell with no baseline is left alone", () => {
  // No baseline means the control is outside the changed-only save contract, so clean
  // and dirty are indistinguishable. Guessing wrong destroys typing.
  const el = fakeCell({ value: "40", baseline: null });
  assert.equal(shouldAdoptRemoteValue(el, "72"), false);
});

test("a cell already showing the value is not rewritten", () => {
  // Not merely wasteful: the write would move the baseline for no reason, and repeated
  // events would keep touching the DOM on a grid built to avoid exactly that.
  const el = fakeCell({ value: "72", baseline: "72" });
  assert.equal(shouldAdoptRemoteValue(el, "72"), false);
});

test("a cleared value is adopted, not treated as 'nothing to say'", () => {
  // The store uses "" for CLEARED, distinct from having no entry. A colleague clearing
  // a cell must blank it here too (§33.6) — the bug being avoided is the previous value
  // staying visible for everyone else.
  const el = fakeCell({ value: "40", baseline: "40" });
  assert.equal(shouldAdoptRemoteValue(el, ""), true);
});

test("a select adopts a value it has an option for", () => {
  const el = asSelect(fakeCell({ value: "Active", baseline: "Active", select: ["Active", "HeadStart", "Complete"] }));
  assert.equal(shouldAdoptRemoteValue(el, "Complete"), true);
});

test("a select is NOT sent to a value it has no option for", () => {
  // Would blank the control, which reads as data loss rather than as a sync.
  const el = asSelect(fakeCell({ value: "Active", baseline: "Active", select: ["Active", "HeadStart", "Complete"] }));
  assert.equal(shouldAdoptRemoteValue(el, "Cancelled"), false);
});

test("the Billable select's two values round-trip", () => {
  // The server announces "Billable"/"Non-Billable" (formatJobFieldValue), and the
  // select's options are those same strings — if those two ever diverge the cell would
  // silently stop syncing, so it is worth pinning.
  const el = asSelect(fakeCell({ value: "Billable", baseline: "Billable", select: ["Billable", "Non-Billable"] }));
  assert.equal(shouldAdoptRemoteValue(el, "Non-Billable"), true);
});
