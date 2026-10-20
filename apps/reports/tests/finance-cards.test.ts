import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FINANCE_CARDS, financeCardsFor } from "../src/lib/finance-cards";
import { permissionForPath } from "../src/lib/route-permissions";
import { hasPermission, ROLES } from "../src/lib/permissions";
import { splitRoute } from "../src/lib/split-view";

// The Dashboard's Finances tab (2026-10-20). Its one rule: a card shows a figure the app
// already shows elsewhere and links to that page, so it is only ever offered to a role
// that can open the page. These pin the parts of that rule a refactor could quietly undo.

const src = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");

test("every card links to a real page, scoped to the month, and that page needs the card's permission", () => {
  assert.ok(FINANCE_CARDS.length > 0);
  for (const card of FINANCE_CARDS) {
    const href = card.href("2026-10");
    assert.match(href, /^\/[a-z-]+\?/, `${card.key} links to an app page with a query`);
    const path = href.split("?")[0];
    assert.equal(
      permissionForPath(path),
      card.permission,
      `${card.key}: ${path} must require the permission the card is gated on`,
    );
    assert.ok(card.source.length > 0 && card.title.length > 0, `${card.key} names itself and its source`);
  }
});

test("a card's link carries the Dashboard's month", () => {
  const byKey = Object.fromEntries(FINANCE_CARDS.map((c) => [c.key, c]));
  assert.equal(byKey["parts-spent"].href("2026-02"), "/etc?month=2026-02");
  // February: the range ends on the 28th (2026 is not a leap year), not a fixed 30/31.
  assert.equal(byKey["tm"].href("2026-02"), "/tm?start=2026-02-01&end=2026-02-28");
});

test("each link's destination can be opened as a pane, so More details never leaves the workspace", () => {
  for (const card of FINANCE_CARDS) {
    const path = card.href("2026-10").split("?")[0];
    assert.ok(splitRoute(path), `${path} is a registered split route`);
  }
});

test("a role is offered exactly the cards whose destination it can open, and none otherwise", () => {
  for (const role of ROLES) {
    const offered = financeCardsFor(role).map((c) => c.key);
    const expected = FINANCE_CARDS.filter((c) => hasPermission(role, c.permission)).map((c) => c.key);
    assert.deepEqual(offered, expected, `${role}`);
  }
  assert.deepEqual(financeCardsFor(null), [], "an unknown role sees nothing");
  assert.equal(financeCardsFor("ELT").length, FINANCE_CARDS.length, "ELT holds every permission");
});

test("the page builds Finances only for a role with cards, only when the tab is open", () => {
  const page = src("app/(app)/page.tsx");
  assert.match(page, /const financeCards = financeCardsFor\(session\.user\.role\);/);
  assert.match(page, /const financesOpen = hasFinances && params\.tab === "finances";/);
  assert.match(page, /finances=\{financesOpen \? <FinancesPanel/);
  // No tab strip at all for a role without cards.
  assert.match(page, /hasFinances \? \(\s*<DashboardTabs/);
});

test("the readers never throw and never turn a failed read into a zero", () => {
  const s = src("lib/dashboard-finances.ts");
  assert.equal((s.match(/state: "unavailable"/g) ?? []).length >= 4, true, "every reader has a failure state");
  assert.match(s, /source\.failedJobs > 0/, "T&M: a Total ETO failure is not a $0 result");
});
