import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTmFilters, buildTmPartsDrillDax, PARTS_CARDS, type TmPartsDrillKey } from "../src/lib/tm-report";

// buildTmFilters is the pure, network-free half of tm-report.ts — the DAX
// query itself is only provably correct against the live Power BI model
// (see the plan's manual verification step), but these lock down the two
// things that would silently corrupt every query if they regressed:
// escaping, and the "no selection" case not degenerating into an empty IN{}
// (which would zero out every job instead of meaning "all of them").

test("no job/status selection produces no filter argument for either", () => {
  const args = buildTmFilters({ startDate: "2026-01-01", endDate: "2026-03-31" });
  assert.ok(!args.some((a) => a.includes("Job Id")));
  assert.ok(!args.some((a) => a.includes("Job Status")));
});

test("the date range is always present as a Between-style filter", () => {
  const args = buildTmFilters({ startDate: "2026-01-01", endDate: "2026-03-31" });
  const dateArg = args.find((a) => a.includes("'Date'[Date]"));
  assert.ok(dateArg);
  assert.equal(dateArg, `'Date'[Date] >= DATE(2026,1,1) && 'Date'[Date] <= DATE(2026,3,31)`);
});

test("multiple job ids produce a DAX IN list", () => {
  const args = buildTmFilters({ jobIds: ["1142", "1150"], startDate: "2026-01-01", endDate: "2026-03-31" });
  assert.ok(args.includes(`'Job'[Job Id] IN {"1142","1150"}`));
});

test("multiple job statuses produce a DAX IN list", () => {
  const args = buildTmFilters({ jobStatuses: ["Active", "Complete"], startDate: "2026-01-01", endDate: "2026-03-31" });
  assert.ok(args.includes(`'Job'[Job Status] IN {"Active","Complete"}`));
});

test("a job id containing a double quote is escaped, not left to break the DAX string", () => {
  const args = buildTmFilters({ jobIds: [`11"42`], startDate: "2026-01-01", endDate: "2026-03-31" });
  assert.ok(args.includes(`'Job'[Job Id] IN {"11""42"}`));
});

test("an empty array is treated the same as omitted — no filter, not an empty IN{}", () => {
  const args = buildTmFilters({ jobIds: [], jobStatuses: [], startDate: "2026-01-01", endDate: "2026-03-31" });
  assert.equal(args.length, 1); // only the date range
});

// ── Regression guard for the KPI-vs-drill fan-out bug (2026-08-19) ──────────
//
// A live mismatch (Engineering Hours KPI = 53, drill-through total = 105 —
// almost exactly 2×) traced to the (now-retired) hours drill query grouping
// by a 'Function Hierarchy' dimension column via SUMMARIZECOLUMNS. The fix
// for the Parts cards (which had the same class of risk) is SELECTCOLUMNS
// directly over the 'Part Purchase' FACT table (a 1:1 row projection, immune
// to a dimension's own fan-out) — this test locks down that STRUCTURAL
// property. The Hours cards themselves moved off Power BI entirely
// (2026-08-19, see tests/tm-hours.test.ts) — their own reconciliation
// guarantee now comes from reading one classifier off one local table
// instead, not from a DAX shape.

const ALL_PARTS_KEYS: TmPartsDrillKey[] = ["partInvoicedAmount", "sdcManufacturedPartsSalesPrice", "expenseReports"];

test("the parts drill never groups by a dimension column — it projects the fact table directly", () => {
  for (const key of ALL_PARTS_KEYS) {
    const dax = buildTmPartsDrillDax({ startDate: "2026-01-01", endDate: "2026-03-31" }, key);
    assert.doesNotMatch(dax, /SUMMARIZECOLUMNS/, `${key}: a GROUP BY over a dimension column can fan out and double-count`);
    assert.match(dax, /SELECTCOLUMNS\(\s*'Part Purchase'/, `${key}: must project 'Part Purchase' (the fact table) directly`);
  }
});

test("every parts drill query carries exactly its OWN card's filter arguments — the reconciliation invariant", () => {
  // Was asserting buildTmFilters(filters) (the DEFAULT basis) appeared in all
  // three drills. That stopped being the invariant on 2026-09-01, when SDC
  // Manufactured Parts moved to a Purchase Date basis: the right test is that a
  // card's drill uses THAT CARD's filters, not that every card uses the same
  // ones. PARTS_CARDS is the single spec both the KPI and the drill build from,
  // so this checks the two really are generated from it.
  const filters = { jobIds: ["1142", "1150"], startDate: "2026-01-01", endDate: "2026-03-31" };
  for (const key of ALL_PARTS_KEYS) {
    const card = PARTS_CARDS[key];
    const dax = buildTmPartsDrillDax(filters, key);
    for (const arg of buildTmFilters(filters, card.basis)) {
      assert.ok(dax.includes(arg), `${key}: missing filter arg "${arg}" — KPI and drill would scope different rows`);
    }
    if (card.rowFilter) {
      assert.ok(dax.includes(card.rowFilter), `${key}: drill is missing the card's own row filter`);
    }
    // The amount column the KPI sums must be a column the drill actually projects.
    assert.ok(dax.includes(`'Part Purchase'[${card.amountColumn}]`), `${key}: drill does not project ${card.amountColumn}`);
  }
});

test("SDC Manufactured Parts filters on Purchase Date, detached from the Invoiced-Date relationship", () => {
  // The structural bug this fixed: 'Part Purchase' joins the Date table on
  // INVOICED Date, and SDC's own internal parts are never invoiced (newest
  // Invoiced Date 2025-10-07; 1,026 of 2,257 rows have none at all). Filtering
  // through that relationship returned blank for every recent range — a
  // guaranteed zero regardless of activity. Measured 2026-05-31..2026-07-31:
  // blank before, 218 rows / $39,102.73 after.
  const filters = { jobIds: [], startDate: "2026-05-31", endDate: "2026-07-31" };
  const args = buildTmFilters(filters, "purchaseDate");
  assert.ok(args.includes("ALL('Date')"), "must detach the Invoiced-Date relationship");
  assert.ok(
    args.some((a) => a.includes("'Part Purchase'[Purchase Date]")),
    "must bound Purchase Date explicitly",
  );
  assert.ok(!args.some((a) => a.includes("'Date'[Date]")), "must not also filter the Date table");
  // The job filter survives the ALL('Date') — scoping a card by job must still work.
  const scoped = buildTmFilters({ ...filters, jobIds: ["1163"] }, "purchaseDate");
  assert.ok(scoped.some((a) => a.includes("'Job'[Job Id]")), "job filter must survive ALL('Date')");
  assert.equal(PARTS_CARDS.sdcManufacturedPartsSalesPrice.basis, "purchaseDate");
  // The other two stay on the model's own basis.
  assert.equal(PARTS_CARDS.partInvoicedAmount.basis, "invoicedDate");
  assert.equal(PARTS_CARDS.expenseReports.basis, "invoicedDate");
});

test("the default date basis is unchanged — Invoiced Date, via the Date table", () => {
  const args = buildTmFilters({ jobIds: [], startDate: "2026-05-31", endDate: "2026-07-31" });
  assert.ok(args.some((a) => a.includes("'Date'[Date] >= DATE(2026,5,31)")));
  assert.ok(!args.includes("ALL('Date')"));
});
