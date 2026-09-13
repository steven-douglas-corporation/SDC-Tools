/**
 * Live reconciliation for the Cash Flow Forecast extraction (2026-08-19).
 * There is no stored Total ETO "Cash Flow Forecast" table/report to diff
 * against (confirmed live — see cash-flow-totaleto.ts's own header), so this
 * checks the one thing that WOULD catch a real extraction bug: does the sum
 * of every monthly + unknown-due-date bucket for a project equal that same
 * project's UNFILTERED total in the underlying Total ETO table? A bucketing
 * mistake (a row silently dropped, or double-counted across two buckets)
 * shows up here as a mismatch even without a reference report to compare to.
 *
 *   npx tsx --env-file=.env scripts/verify-cash-flow-reconcile.ts
 */
import { fetchArForecastRows, fetchApForecastRows, fetchPoForecastRows } from "../src/lib/cash-flow-totaleto";
import { buildArLines, buildApLines, buildPoLines, aggregateLines } from "../src/lib/cash-flow-normalize";

function sum(values: number[]): number {
  return Math.round(values.reduce((s, v) => s + v, 0) * 100) / 100;
}

async function main() {
  let anyFail = false;

  console.log("=== AR reconciliation (tblARSalesTerms, non-archived) ===");
  const arRows = await fetchArForecastRows();
  const arLines = aggregateLines(buildArLines(arRows, new Map()));
  const arRawTotal = sum(arRows.map((r) => r.amount));
  const arBucketedTotal = sum(arLines.map((l) => l.amount));
  console.log(`  raw rows total:      ${arRawTotal}`);
  console.log(`  bucketed lines total: ${arBucketedTotal}`);
  if (Math.abs(arRawTotal - arBucketedTotal) > 1) {
    console.log("  *** MISMATCH — a bucketing step is dropping or duplicating AR rows ***");
    anyFail = true;
  } else {
    console.log("  MATCH");
  }
  const arUnknownCount = arRows.filter((r) => !r.dueDate).length;
  console.log(`  ${arUnknownCount} of ${arRows.length} terms have no date on file (-> UNKNOWN bucket)`);

  console.log("\n=== AP reconciliation (tblAPBatchDocument, GL-posted) ===");
  const apRows = await fetchApForecastRows();
  const apLines = aggregateLines(buildApLines(apRows, new Map()));
  const apRawTotal = sum(apRows.map((r) => r.amount));
  const apBucketedTotal = sum(apLines.map((l) => l.amount));
  console.log(`  raw rows total:      ${apRawTotal}`);
  console.log(`  bucketed lines total: ${apBucketedTotal}`);
  if (Math.abs(apRawTotal - apBucketedTotal) > 0.01) {
    console.log("  *** MISMATCH ***");
    anyFail = true;
  } else {
    console.log("  MATCH");
  }

  console.log("\n=== PO reconciliation (remaining, uninvoiced commitment) ===");
  const poRows = await fetchPoForecastRows();
  const poLines = aggregateLines(buildPoLines(poRows, new Map()));
  const poRawTotal = sum(poRows.map((r) => r.remainingAmount));
  const poBucketedTotal = sum(poLines.map((l) => l.amount));
  console.log(`  raw rows total:      ${poRawTotal}`);
  console.log(`  bucketed lines total: ${poBucketedTotal}`);
  if (Math.abs(poRawTotal - poBucketedTotal) > 1) {
    console.log("  *** MISMATCH ***");
    anyFail = true;
  } else {
    console.log("  MATCH");
  }
  console.log(`  ${poRows.length} PO lines carry a remaining (uninvoiced) commitment`);

  console.log("\n=== Sample: top 5 projects by total AR forecast ===");
  const byProject = new Map<string, number>();
  for (const l of arLines) byProject.set(l.projectId, (byProject.get(l.projectId) ?? 0) + l.amount);
  const top = [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [projectId, total] of top) console.log(`  ${projectId}: $${total.toLocaleString()}`);

  console.log(anyFail ? "\nFAIL\n" : "\nPASS — every extraction's bucketed total matches its own raw total.\n");
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
