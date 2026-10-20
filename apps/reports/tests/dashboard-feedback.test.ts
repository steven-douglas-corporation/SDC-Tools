import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dashboardFeedbackContext } from "../src/lib/dashboard-feedback";
import { isFeedbackCategory } from "../src/lib/feedback-status";

// The Dashboard's two "Help shape this tab" buttons (2026-10-20). They reuse the existing
// feedback drawer and queue; what is pinned here is what they report about themselves and
// that the Flag pill was left alone.

const src = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");

test("a button reports the exact tab it is on, not whatever pane the shell resolves", () => {
  const fin = dashboardFeedbackContext("finances", "2026-10");
  assert.equal(fin.routePath, "/");
  assert.equal(fin.viewLabel, "Dashboard — Finances");
  assert.deepEqual(fin.params, { m: "2026-10", tab: "finances" });
  assert.equal(fin.periodMonth, "2026-10");
  assert.equal(fin.contextUrl, "/?m=2026-10&tab=finances");

  const exec = dashboardFeedbackContext("executive", "2026-10");
  assert.equal(exec.viewLabel, "Dashboard — Executive");
  assert.deepEqual(exec.params, { m: "2026-10" }, "Executive is the default tab, so it carries no tab param");
  assert.equal(exec.contextUrl, "/?m=2026-10");
});

test("the label fits the column it is stored in", () => {
  // Feedback.viewLabel is VARCHAR(64); the action truncates rather than refuses, but a
  // label that needs truncating would lose the tab name, which is its whole point.
  for (const view of ["executive", "finances"] as const) {
    assert.ok((dashboardFeedbackContext(view, "2026-10").viewLabel ?? "").length <= 64);
  }
});

test("both tabs carry the band, and each names its own view", () => {
  assert.match(src("app/(app)/page.tsx"), /<DashboardFeedbackBand view="executive" month=\{month\} \/>/);
  assert.match(src("components/dashboard/FinancesPanel.tsx"), /<DashboardFeedbackBand view="finances" month=\{month\} \/>/);
});

test("one button opens the suggestion wording, the other the ordinary problem form", () => {
  const band = src("components/dashboard/DashboardFeedbackBand.tsx");
  assert.match(band, /Suggest something to add/);
  assert.match(band, /Something looks wrong/);
  assert.match(band, /open\(\{ suggestion: true, context \}\)/);
  assert.match(band, /open\(\{ suggestion: false, context \}\)/);
  // Offered only to a role that can submit; absent, not present-and-refusing.
  assert.match(band, /if \(!canSubmit\) return null;/);
});

test("a suggestion files as an enhancement at the lowest urgency", () => {
  const drawer = src("components/FeedbackDrawer.tsx");
  assert.match(drawer, /useState<FeedbackCategory>\(suggestion \? "enhancement" : DEFAULT_FEEDBACK_CATEGORY\)/);
  assert.match(drawer, /useState<FeedbackSeverity>\(suggestion \? "cosmetic" : DEFAULT_FEEDBACK_SEVERITY\)/);
  assert.ok(isFeedbackCategory("enhancement"), "the category the drawer files under exists");
});

test("the Flag pill is unchanged: it opens its own drawer without the suggestion wording", () => {
  const button = src("components/FeedbackButton.tsx");
  assert.match(button, /\{open && <FeedbackDrawer context=\{context\} canView=\{canView\} onClose=\{\(\) => setOpen\(false\)\} \/>\}/);
  assert.match(button, /aria-label="Report a problem with this view"/);
  // The shell still renders the drawer in exactly one component.
  const importers = ["components/AppShell.tsx", "components/dashboard/DashboardFeedbackBand.tsx"].filter((f) =>
    src(f).includes("<FeedbackDrawer"),
  );
  assert.deepEqual(importers, [], "only FeedbackButton renders the drawer");
});
