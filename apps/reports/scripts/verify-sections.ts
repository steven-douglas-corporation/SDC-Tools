// Drift check for src/lib/sections.ts's hardcoded SECTIONS list against the
// live Power BI "Function Hierarchy" table. Run with: npx tsx scripts/verify-sections.ts
//
// SECTIONS is intentionally hardcoded (a fixed job-costing taxonomy that rarely
// changes) rather than synced live on every page load — this script exists so
// drift can be checked on demand instead of never being detected at all.
import { runDax } from "../src/lib/powerbi-client";
import { SECTIONS } from "../src/lib/sections";

interface FunctionHierarchyRow {
  "Function Hierarchy[Section-Function Code]": string;
  "Function Hierarchy[Section Name]": string;
  "Function Hierarchy[Is Total]": boolean;
  "Function Hierarchy[Is Valid]": boolean;
}

async function main() {
  const rows = (await runDax(`
    EVALUATE
    SUMMARIZECOLUMNS(
      'Function Hierarchy'[Section-Function Code],
      'Function Hierarchy'[Section Name],
      'Function Hierarchy'[Is Total],
      'Function Hierarchy'[Is Valid]
    )
  `)) as FunctionHierarchyRow[];

  const byCode = new Map(
    rows.filter((r) => !r["Function Hierarchy[Is Total]"]).map((r) => [r["Function Hierarchy[Section-Function Code]"], r])
  );

  let driftFound = false;

  for (const s of SECTIONS) {
    const live = byCode.get(s.code);
    if (!live) {
      console.log(`✗ ${s.code} ("${s.name}", phase "${s.phase}") — NOT FOUND in live Function Hierarchy table`);
      driftFound = true;
      continue;
    }
    if (!live["Function Hierarchy[Is Valid]"]) {
      console.log(`✗ ${s.code} ("${s.name}") — marked Is Valid=false in the live model`);
      driftFound = true;
      continue;
    }
    const livePhase = live["Function Hierarchy[Section Name]"];
    // "&" vs "and" is a known cosmetic difference, not drift.
    const normalize = (p: string) => p.replace(/&/g, "and").toLowerCase();
    if (normalize(livePhase) !== normalize(s.phase)) {
      console.log(`✗ ${s.code} — hardcoded phase "${s.phase}" but live model has "${livePhase}"`);
      driftFound = true;
      continue;
    }
    console.log(`✓ ${s.code} ("${s.name}") — matches live model, phase "${livePhase}"`);
  }

  console.log();
  console.log(driftFound ? "DRIFT FOUND — see ✗ lines above." : `All ${SECTIONS.length} hardcoded sections match the live model. No drift.`);
  process.exit(driftFound ? 1 : 0);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
