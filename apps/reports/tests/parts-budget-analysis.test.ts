import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BANDS,
  bandOf,
  bandTotals,
  filterRows,
  roundPct,
  sortRows,
  focusMatches,
  FOCUS_SORT,
  PARTS_BUDGET_EXCLUDED_TYPES,
  scopeOptions,
  scopeRows,
  breakout,
  groupValue,
  MAX_GROUPS,
  summarize,
  DEFAULT_SORT,
  type PartsBudgetRow,
} from "../src/lib/parts-budget-bands";
import { buildPartsBudgetSheet, parsePartsBudgetQuery } from "../src/lib/export/parts-budget-export";
import { PARTS_BUDGET_SECTION, canSeePartsBudget } from "../src/lib/finance-cards";
import { permissionForPath } from "../src/lib/route-permissions";
import { VALID_JOB_TYPES } from "../src/lib/job-filters";
import { hasPermission, ROLES } from "../src/lib/permissions";

// ── Parts cost vs budget, every job (2026-10-22) ─────────────────────────────

const row = (o: Partial<PartsBudgetRow> & Pick<PartsBudgetRow, "jobId" | "budget" | "projected">): PartsBudgetRow => {
  const delta = o.budget != null ? o.projected - o.budget : null;
  return {
    id: Number(o.jobId), jobName: `Job ${o.jobId}`, customer: "Acme", type: "Custom", status: "Active",
    delta, pct: o.budget ? roundPct((delta! / o.budget) * 100) : null,
    purchased: o.projected, stillToPurchase: 0, excess: 0, basis: "live", ...o,
  };
};

const ROWS = [
  row({ jobId: "1101", budget: 100000, projected: 90000 }), // −10%  under
  row({ jobId: "1102", budget: 100000, projected: 100000 }), // 0%    on budget -> under
  row({ jobId: "1103", budget: 100000, projected: 105000, status: "Complete" }), // +5%
  row({ jobId: "1104", budget: 100000, projected: 110000 }), // +10% -> 10–25
  row({ jobId: "1105", budget: 100000, projected: 124990 }), // +25.0 (24.99 rounds to 25.0) -> 25–50
  row({ jobId: "1106", budget: 100000, projected: 150000, customer: "Beta" }), // +50% -> 50+
  row({ jobId: "1107", budget: null, projected: 40000 }), // no budget
  row({ jobId: "979", budget: 50000, projected: 70000, excess: 1200, status: "Complete", basis: "final" }), // +40%
];

test("a rounded percentage lands in the band its own figure shows; edges belong to the higher band", () => {
  assert.equal(bandOf(-3), "under");
  assert.equal(bandOf(0), "under", "exactly on budget is not over");
  assert.equal(bandOf(0.1), "b0_10");
  assert.equal(bandOf(9.9), "b0_10");
  assert.equal(bandOf(10), "b10_25");
  assert.equal(bandOf(24.9), "b10_25");
  assert.equal(bandOf(25), "b25_50");
  assert.equal(bandOf(49.9), "b25_50");
  assert.equal(bandOf(50), "b50");
  assert.equal(BANDS.length, 5);
  // 24.96% prints as 25.0%, so it must band as 25–50 — not 10–25 beside a "25.0%".
  assert.equal(bandOf(roundPct(24.96)), "b25_50");
});

test("band totals count each job once and add over and under dollars separately", () => {
  const t = Object.fromEntries(bandTotals(ROWS).map((b) => [b.band.key, b]));
  assert.deepEqual([t.under.jobs, t.b0_10.jobs, t.b10_25.jobs, t.b25_50.jobs, t.b50.jobs], [2, 1, 1, 2, 1]);
  assert.equal(t.under.under, 10000);
  assert.equal(t.b0_10.over, 5000);
  assert.equal(t.b25_50.over, 24990 + 20000);
  // The job with no budget is in no band at all.
  assert.equal(bandTotals(ROWS).reduce((s, b) => s + b.jobs, 0), ROWS.length - 1);
});

test("filters: status chip, band, and text search compose; no band shows every job including no-budget ones", () => {
  const f = (o: Partial<Parameters<typeof filterRows>[1]>) => filterRows(ROWS, { status: "both", band: null, q: "", ...o }).map((r) => r.jobId);
  assert.equal(f({}).length, ROWS.length);
  assert.deepEqual(f({ status: "complete" }), ["1103", "979"]);
  assert.equal(f({ status: "active" }).length, ROWS.length - 2);
  assert.deepEqual(f({ band: "b25_50" }), ["1105", "979"]);
  assert.deepEqual(f({ band: "b25_50", status: "complete" }), ["979"]);
  assert.deepEqual(f({ q: "beta" }), ["1106"]);
  assert.deepEqual(f({ q: " 979 " }), ["979"]);
  assert.ok(!f({ band: "under" }).includes("1107"), "a job with no budget has no band");
});

test("the summary cards open what their figure is: the whole over-budget list, the excess jobs, or ONE named job", () => {
  const f = (focus: "over" | "excess" | "pct" | "dollars", status: "both" | "active" | "complete" = "both") =>
    sortRows(filterRows(ROWS, { status, band: null, q: "", focus }), FOCUS_SORT[focus]).map((r) => r.jobId);
  // Total over budget: every over-budget job, largest overrun $ first. Not the under-budget jobs, not the
  // job with no budget — and the list adds up to the figure on the card.
  assert.deepEqual(f("over"), ["1106", "1105", "979", "1104", "1103"]);
  const listed = filterRows(ROWS, { status: "both", band: null, q: "", focus: "over" });
  assert.equal(listed.reduce((s, r) => s + (r.delta as number), 0), summarize(ROWS).totalOver);
  // Highest overrun % and Largest overrun $: exactly one job, the one the card names.
  assert.deepEqual(f("pct"), ["1106"]);
  assert.deepEqual(f("dollars"), ["1106"]);
  assert.equal(f("pct")[0], summarize(ROWS).worstByPct?.jobId);
  // Excess: exactly the jobs counted on the card.
  assert.deepEqual(f("excess"), ["979"]);
  assert.equal(f("excess").length, summarize(ROWS).withExcess);
  // The status chip scopes the card's figure, so it scopes the job the card names.
  assert.deepEqual(f("pct", "complete"), ["979"], "979 is the highest % among completed jobs");
  assert.deepEqual(f("dollars", "complete"), ["979"]);
  assert.deepEqual(f("over", "complete"), ["979", "1103"]);
  // 1105 has the second-largest overrun overall, but the single-job cards never list it.
  assert.ok(!f("dollars").includes("1105"));
  assert.equal(focusMatches(ROWS[0], "over", ROWS), false, "an under-budget job is not over");
  assert.equal(focusMatches(ROWS[6], "over", ROWS), false, "a job with no budget is not over");
});

test("the summary counts over-budget jobs, adds their overruns, and names the worst by % and by $", () => {
  const s = summarize(ROWS);
  assert.equal(s.jobs, 8);
  assert.equal(s.withBudget, 7);
  assert.equal(s.noBudget, 1);
  assert.equal(s.jobsOver, 5);
  assert.equal(s.totalOver, 5000 + 10000 + 24990 + 50000 + 20000);
  assert.equal(s.worstByPct?.jobId, "1106");
  assert.equal(s.worstByDollars?.jobId, "1106");
  assert.equal(s.withExcess, 1);
  const none = summarize([ROWS[0]]);
  assert.equal(none.worstByPct, null);
  assert.equal(none.totalOver, 0);
});

test("sorting: worst % first by default, job ids numerically, blanks last in either direction", () => {
  assert.equal(sortRows(ROWS, DEFAULT_SORT)[0].jobId, "1106");
  assert.equal(sortRows(ROWS, DEFAULT_SORT).at(-1)?.jobId, "1107", "no budget sorts last");
  assert.equal(sortRows(ROWS, { key: "pct", dir: "asc" }).at(-1)?.jobId, "1107", "...also ascending");
  const ids = sortRows(ROWS, { key: "jobId", dir: "asc" }).map((r) => r.jobId);
  assert.equal(ids[0], "979", "979 before 1101, not after");
  assert.deepEqual(ids.slice(-2), ["1106", "1107"]);
  // The input is never reordered.
  assert.equal(ROWS[0].jobId, "1101");
});

test("the export holds exactly the rows the table shows, with totals over the jobs that have a budget", () => {
  const q = parsePartsBudgetQuery({ status: "complete", band: "b25_50", q: "", sort: "pct", dir: "desc" });
  const { spec, rowCount } = buildPartsBudgetSheet(ROWS, q, "2026-10-22T10:00:00.000Z", new Date("2026-10-22T12:00:00Z"));
  assert.equal(rowCount, 1);
  assert.equal(spec.rows.length, 1);
  assert.equal(spec.rows[0][0], "979");
  assert.equal(spec.totals?.length, spec.columns.length);
  assert.equal(spec.rows[0].length, spec.columns.length);
  const all = buildPartsBudgetSheet(ROWS, parsePartsBudgetQuery({}), "2026-10-22T10:00:00.000Z", new Date());
  assert.equal(all.rowCount, ROWS.length);
  // Totals skip the job with no budget so Projected and Over/Under still add up to a Budget total.
  const t = all.spec.totals!;
  assert.equal(t[5], 100000 * 6 + 50000);
  assert.equal(t[6], 90000 + 100000 + 105000 + 110000 + 124990 + 150000 + 70000);
  assert.equal((t[6] as number) - (t[5] as number), t[7]);
  // A blank stays blank, never a zero: the no-budget job has no over/under.
  const noBudget = all.spec.rows.find((r) => r[0] === "1107")!;
  assert.equal(noBudget[5], null);
  assert.equal(noBudget[7], null);
  assert.equal(noBudget[8], null);
});

// ── Customer and Type filters (2026-10-23) ───────────────────────────────────

const MIXED = [
  row({ jobId: "2001", budget: 100000, projected: 130000, customer: "Acme", type: "Custom" }), // +30%
  row({ jobId: "2002", budget: 100000, projected: 110000, customer: "Acme", type: "Duplicate", status: "Complete" }), // +10%
  row({ jobId: "2003", budget: 100000, projected: 160000, customer: "Beta", type: "Custom" }), // +60%
  row({ jobId: "2004", budget: 100000, projected: 90000, customer: "Beta", type: "Hybrid" }), // −10%
  row({ jobId: "2005", budget: 100000, projected: 105000, customer: null, type: null }), // no customer, no type
];
const ids = (rows: readonly PartsBudgetRow[]) => rows.map((r) => r.jobId);

test("Customer and Type narrow like the status chip: nothing chosen keeps every job, and they compose", () => {
  const f = (o: Partial<Parameters<typeof filterRows>[1]>) => ids(filterRows(MIXED, { status: "both", band: null, q: "", ...o }));
  assert.equal(f({}).length, 5);
  assert.equal(f({ customers: [], types: [] }).length, 5, "an empty selection is no filter");
  assert.deepEqual(f({ customers: ["Acme"] }), ["2001", "2002"]);
  assert.deepEqual(f({ customers: ["Acme", "Beta"] }), ["2001", "2002", "2003", "2004"], "several customers are OR");
  assert.deepEqual(f({ types: ["Custom"] }), ["2001", "2003"]);
  assert.deepEqual(f({ customers: ["Beta"], types: ["Custom"] }), ["2003"], "customer AND type");
  assert.deepEqual(f({ customers: ["Acme"], status: "complete" }), ["2002"], "and the status chip");
  assert.deepEqual(f({ customers: [""] }), ["2005"], "a job with no customer is its own choice");
  assert.deepEqual(f({ types: [""] }), ["2005"]);
  assert.deepEqual(f({ customers: ["Nobody"] }), []);
});

test("every figure is computed inside the same scope: summary, bands, and the job a card names", () => {
  const scope = (o: { customers?: string[]; types?: string[]; status?: "both" | "active" | "complete" }) =>
    scopeRows(MIXED, { status: "both", ...o });
  // Beta only: the highest overrun is 2003 (+60%), not an Acme job.
  const beta = scope({ customers: ["Beta"] });
  assert.equal(summarize(beta).worstByPct?.jobId, "2003");
  assert.equal(summarize(beta).jobs, 2);
  // Acme only: the highest overrun is now 2001 (+30%), and a single-job card follows it.
  assert.equal(summarize(scope({ customers: ["Acme"] })).worstByPct?.jobId, "2001");
  assert.deepEqual(ids(filterRows(MIXED, { status: "both", band: null, q: "", focus: "pct", customers: ["Acme"] })), ["2001"]);
  assert.deepEqual(ids(filterRows(MIXED, { status: "both", band: null, q: "", focus: "pct" })), ["2003"]);
  // Band counts follow the scope.
  assert.equal(bandTotals(scope({ types: ["Custom"] })).reduce((s, b) => s + b.jobs, 0), 2);
});

test("menu options carry how many jobs each holds, most first, with an explicit choice for none", () => {
  const c = scopeOptions(MIXED, "customer");
  assert.deepEqual(c.map((o) => [o.label, o.count]), [["Acme", 2], ["Beta", 2], ["(none)", 1]]);
  assert.equal(c.find((o) => o.label === "(none)")?.value, "");
  const t = scopeOptions(MIXED, "type");
  assert.deepEqual(t.map((o) => o.label), ["Custom", "(none)", "Duplicate", "Hybrid"], "count first, then name");
  assert.equal(t[0].count, 2);
});

// ── Break out by (2026-10-23) ─────────────────────────────────────────────────

test("breaking out a band's bar by status, type or customer: slices add up to the band, same order in every band", () => {
  for (const by of ["status", "type", "customer"] as const) {
    const bo = breakout(MIXED, by);
    const perBand = bandTotals(MIXED);
    for (const t of perBand) {
      const slices = bo.byBand[t.band.key];
      assert.equal(slices.reduce((s, x) => s + x.jobs, 0), t.jobs, `${by}: ${t.band.key} slices add up to the band's jobs`);
      assert.ok(Math.abs(slices.reduce((s, x) => s + x.over, 0) - t.over) < 1e-6, `${by}: dollars over add up`);
      assert.ok(Math.abs(slices.reduce((s, x) => s + x.under, 0) - t.under) < 1e-6);
      const order = slices.map((x) => bo.groups.indexOf(x.group));
      assert.deepEqual(order, [...order].sort((a, b) => a - b), "a group keeps its place along every bar");
    }
    // Only jobs that have a band are counted, so the legend adds up to the jobs in the chart.
    assert.equal(bo.groups.reduce((s, g) => s + g.jobs, 0), perBand.reduce((s, t) => s + t.jobs, 0));
  }
  const status = breakout(MIXED, "status");
  assert.deepEqual(status.groups.map((g) => [g.label, g.jobs]), [["Active", 4], ["Complete", 1]]);
  const type = breakout(MIXED, "type");
  assert.deepEqual(type.groups.map((g) => g.label), ["Custom", "(none)", "Duplicate", "Hybrid"], "largest first, then by name");
  assert.equal(type.groups[0].jobs, 2);
});

test("past the colour budget the smallest groups become one Other slice that still lists exactly its jobs", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    row({ jobId: String(3000 + i), budget: 100000, projected: 120000, customer: `Customer ${String(i).padStart(2, "0")}`, type: "Custom" }),
  );
  // Customer 00 has three jobs, 01 has two: the rest have one each.
  many.push(row({ jobId: "3100", budget: 100000, projected: 120000, customer: "Customer 00", type: "Custom" }));
  many.push(row({ jobId: "3101", budget: 100000, projected: 120000, customer: "Customer 00", type: "Custom" }));
  many.push(row({ jobId: "3102", budget: 100000, projected: 120000, customer: "Customer 01", type: "Custom" }));
  const bo = breakout(many, "customer");
  assert.equal(bo.groups.length, MAX_GROUPS);
  const other = bo.groups.at(-1)!;
  assert.match(other.label, /^Other \(\d+\)$/);
  assert.equal(other.values.length, 12 - (MAX_GROUPS - 1));
  assert.equal(bo.groups.reduce((s, g) => s + g.jobs, 0), many.length, "nothing is lost into Other");
  // Choosing the Other slice lists exactly the jobs of the customers it stands for.
  const listed = filterRows(many, { status: "both", band: "b10_25", q: "", segment: { by: "customer", values: other.values } });
  assert.equal(listed.length, other.jobs);
  assert.ok(listed.every((r) => other.values.includes(groupValue(r, "customer"))));
});

test("a slice narrows the table like a band: one group's jobs, and none of another's", () => {
  const f = (segment: { by: "status" | "type" | "customer"; values: string[] } | null) =>
    ids(filterRows(MIXED, { status: "both", band: "b10_25", q: "", segment }));
  assert.deepEqual(f(null), ["2002"], "10–25% holds job 2002 only");
  assert.deepEqual(f({ by: "status", values: ["Complete"] }), ["2002"]);
  assert.deepEqual(f({ by: "status", values: ["Active"] }), []);
  assert.deepEqual(ids(filterRows(MIXED, { status: "both", band: "b25_50", q: "", segment: { by: "customer", values: ["Acme"] } })), ["2001"]);
  assert.deepEqual(ids(filterRows(MIXED, { status: "both", band: "b50", q: "", segment: { by: "type", values: ["Custom"] } })), ["2003"]);
  assert.deepEqual(ids(filterRows(MIXED, { status: "both", band: null, q: "", segment: { by: "customer", values: [""] } })), ["2005"], "no customer is its own slice");
});

test("the export follows a slice, and the broken-out chart is wired to the same pieces", () => {
  const q = parsePartsBudgetQuery({ band: "b25_50", segBy: "customer", seg: ["Acme"] });
  assert.deepEqual(q.segment, { by: "customer", values: ["Acme"] });
  const { spec, rowCount } = buildPartsBudgetSheet(MIXED, q, "2026-10-23T10:00:00.000Z", new Date());
  assert.equal(rowCount, 1);
  assert.equal(spec.rows[0][0], "2001");
  assert.match(spec.subtitle[0], /customer: Acme/);
  assert.equal(parsePartsBudgetQuery({ segBy: "nonsense", seg: ["x"] }).segment, null);
  assert.equal(parsePartsBudgetQuery({}).segment, null);
  const route = noComments(src("src", "app", "api", "export", "parts-budget", "route.ts"));
  assert.match(route, /segBy: searchParams\.get\("segBy"\)/);
  assert.match(route, /seg: searchParams\.getAll\("seg"\)/);
  const view = noComments(src("src", "components", "dashboard", "PartsBudgetAnalysis.tsx"));
  assert.match(view, /breakout\(inStatus, breakBy\)/, "the break-out is computed from the same scoped rows as the chart");
  assert.match(view, /pickSegment\(t\.band\.key, sl\.group\)/);
});

test("the section starts un-broken-out, with the Break out by control", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { PartsBudgetAnalysis } = await import("../src/components/dashboard/PartsBudgetAnalysis");
  const html = renderToStaticMarkup(React.createElement(PartsBudgetAnalysis, { rows: MIXED, notStarted: 0, asOf: "2026-10-23T10:00:00.000Z" }));
  assert.match(html, /Break out by/);
  for (const label of ["None", "Status", "Type", "Customer"]) assert.match(html, new RegExp(`>${label}</button>`));
  assert.doesNotMatch(html, /legend/i, "no legend until a break-out is chosen");
});

test("the export keeps the Customer and Type the table is showing", () => {
  const q = parsePartsBudgetQuery({ customers: ["Beta"], types: ["Custom"] });
  assert.deepEqual(q.customers, ["Beta"]);
  assert.deepEqual(q.types, ["Custom"]);
  const { spec, rowCount } = buildPartsBudgetSheet(MIXED, q, "2026-10-23T10:00:00.000Z", new Date());
  assert.equal(rowCount, 1);
  assert.equal(spec.rows[0][0], "2003");
  assert.match(spec.subtitle[0], /customer: Beta/);
  assert.match(spec.subtitle[0], /type: Custom/);
  const none = buildPartsBudgetSheet(MIXED, parsePartsBudgetQuery({ customers: [""] }), "2026-10-23T10:00:00.000Z", new Date());
  assert.equal(none.rowCount, 1);
  assert.match(none.spec.subtitle[0], /customer: \(none\)/);
  // Bounded: a long list from the URL is cut, never passed on whole.
  assert.equal(parsePartsBudgetQuery({ customers: Array.from({ length: 500 }, (_, i) => `c${i}`) }).customers.length, 200);
  assert.equal(parsePartsBudgetQuery({}).customers.length, 0);
  const route = noComments(src("src", "app", "api", "export", "parts-budget", "route.ts"));
  assert.match(route, /customers: searchParams\.getAll\("customer"\)/);
  assert.match(route, /types: searchParams\.getAll\("type"\)/);
});

test("the section offers Customer and Type menus beside the status chips", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { PartsBudgetAnalysis } = await import("../src/components/dashboard/PartsBudgetAnalysis");
  const html = renderToStaticMarkup(React.createElement(PartsBudgetAnalysis, { rows: MIXED, notStarted: 0, asOf: "2026-10-23T10:00:00.000Z" }));
  assert.match(html, /<span class="font-medium">Customer<\/span>/);
  assert.match(html, /<span class="font-medium">Type<\/span>/);
  assert.doesNotMatch(html, /Clear filters/, "nothing is chosen yet");
  assert.match(html, /Both <span[^>]*>5</);
});

test("the export follows a card's list, and a card wins over a band", () => {
  const q = parsePartsBudgetQuery({ focus: "excess", band: "b25_50", status: "both" });
  assert.equal(q.focus, "excess");
  // A single-job card exports exactly that one job.
  const one = buildPartsBudgetSheet(ROWS, parsePartsBudgetQuery({ focus: "pct" }), "2026-10-22T10:00:00.000Z", new Date());
  assert.equal(one.rowCount, 1);
  assert.equal(one.spec.rows[0][0], "1106");
  const over = buildPartsBudgetSheet(ROWS, parsePartsBudgetQuery({ focus: "over" }), "2026-10-22T10:00:00.000Z", new Date());
  assert.equal(over.rowCount, 5);
  assert.equal(q.band, null, "a card's list and a band are never combined");
  const { spec, rowCount } = buildPartsBudgetSheet(ROWS, q, "2026-10-22T10:00:00.000Z", new Date());
  assert.equal(rowCount, 1);
  assert.equal(spec.rows[0][0], "979");
  assert.match(spec.subtitle[0], /Excess bought this month/);
  assert.equal(parsePartsBudgetQuery({ focus: "nonsense" }).focus, null);
});

test("an unrecognised export filter falls back to the default instead of failing", () => {
  const q = parsePartsBudgetQuery({ status: "nonsense", band: "drop table", sort: "evil", dir: "up", q: "x".repeat(500) });
  assert.equal(q.status, "both");
  assert.equal(q.band, null);
  assert.deepEqual(q.sort, DEFAULT_SORT);
  assert.equal(q.q.length, 200);
});

// ── Access, wiring ───────────────────────────────────────────────────────────

const src = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8").replace(/\r\n/g, "\n");
const noComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

test("the section needs Job Details' permission, and so do its rows' links and its export", () => {
  assert.equal(permissionForPath(PARTS_BUDGET_SECTION.href("1101").split("?")[0]), PARTS_BUDGET_SECTION.permission);
  assert.equal(PARTS_BUDGET_SECTION.href("1101"), "/job-hours?jobs=1101");
  for (const role of ROLES) assert.equal(canSeePartsBudget(role), hasPermission(role, "job-hour-details:view"), role);
  const route = noComments(src("src", "app", "api", "export", "parts-budget", "route.ts"));
  assert.match(route, /requireApiPermission\(session, "job-hour-details:view"\)/);
  assert.match(route, /await logAudit\(/);
  assert.doesNotMatch(route, /req\.json\(\)/, "rows are re-read on the server, never taken from the browser");
});

test("T&M jobs are left out of the report at the query itself, and every other valid type stays", () => {
  assert.deepEqual([...PARTS_BUDGET_EXCLUDED_TYPES], ["T&M"]);
  const a = noComments(src("src", "lib", "parts-budget-analysis.ts"));
  assert.match(a, /type: \{ in: \[\.\.\.PARTS_BUDGET_JOB_TYPES\] \}/, "the job query is gated on the allowed types");
  assert.match(a, /VALID_JOB_TYPES\.filter\(\(t\) => !PARTS_BUDGET_EXCLUDED_TYPES\.includes\(t\)\)/);
  assert.doesNotMatch(a, /validJobTypeFilter/, "the unfiltered valid-type gate (which includes T&M) is not used here");
  // Excluding by type removes only T&M: the allowed list is the app's valid types minus it.
  const allowed = VALID_JOB_TYPES.filter((t) => !PARTS_BUDGET_EXCLUDED_TYPES.includes(t));
  assert.deepEqual([...allowed], ["Custom", "Duplicate", "Hybrid", "Service"]);
});

test("the Finances tab offers the section only to a role that may open Job Details", () => {
  const page = noComments(src("src", "app", "(app)", "page.tsx"));
  assert.match(page, /const partsBudget = canSeePartsBudget\(session\.user\.role\);/);
  assert.match(page, /const hasFinances = financeCards\.length > 0 \|\| partsBudget;/);
  assert.match(page, /partsBudget=\{partsBudget\}/);
  const panel = noComments(src("src", "components", "dashboard", "FinancesPanel.tsx"));
  assert.match(panel, /\{partsBudget && \(/);
});

test("each job is assembled by the Job Details card's own function, from one batched read", () => {
  const a = noComments(src("src", "lib", "parts-budget-analysis.ts"));
  assert.match(a, /assemblePartsCostFinancials\(\{/);
  assert.match(a, /getPartsCostForJobs\(jobs\.map/, "one Total ETO read for every job");
  const card = noComments(src("src", "lib", "parts-cost-financials.ts"));
  assert.match(card, /return assemblePartsCostFinancials\(\{/, "the card goes through the same function");
  // A failed read withholds the section rather than turning every job into $0.
  assert.match(a, /if \(!byJob\) return \{ state: "unavailable" \};/);
  assert.match(a, /if \(!allTransfers\) return \{ state: "unavailable" \};/);
});

test("the analysis ignores the Dashboard's month and is held briefly, never when it failed", () => {
  const a = noComments(src("src", "lib", "parts-budget-analysis.ts"));
  assert.match(a, /const TTL_MS = 5 \* 60_000;/);
  assert.match(a, /if \(value\.state === "ok"\) cache = /);
  assert.doesNotMatch(a, /month: string/, "no month parameter");
});

test("the section renders its summary, five bands and chips from the rows alone", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { PartsBudgetAnalysis } = await import("../src/components/dashboard/PartsBudgetAnalysis");
  const html = renderToStaticMarkup(React.createElement(PartsBudgetAnalysis, { rows: ROWS, notStarted: 2, asOf: "2026-10-22T10:00:00.000Z" }));
  for (const b of BANDS) assert.match(html, new RegExp(b.label));
  assert.match(html, /Both <span[^>]*>8</);
  assert.match(html, /Active <span[^>]*>6</);
  assert.match(html, /Complete <span[^>]*>2</);
  assert.match(html, /5 of 7/, "jobs over budget, of the jobs that have a budget");
  assert.match(html, /1 job has no parts budget on file/);
  assert.match(html, /2 jobs have a Parts Cost row but no purchasing yet/);
  assert.match(html, /Show all jobs/);
  // Nothing is chosen yet, so no table (and no job rows) is on the page.
  assert.doesNotMatch(html, /Export Excel/);
});
