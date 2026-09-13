// One-off reconciliation for the CURRENT live month (July 2026):
// the app's off-Power-BI direct pulls vs Power BI's own measures.
//   Hours: SharePoint Paylocity transform (app helper) vs PBI [Hours Actual]
//   Parts: TotalETO SQL (app helper)             vs PBI [Part Cost Purchased]
// Reuses the app's real helpers so this checks the exact code path the grid uses.
//
// Run: npx tsx scripts/_recon_july_2026.ts
import "dotenv/config";
import { runDax } from "@/lib/powerbi-client";
import { prisma } from "@/lib/prisma";
import { ETC_TRACKED_CODES } from "@/lib/sections";
import { round2 } from "@/lib/etc";
import { fetchJobHoursRows, hoursByJobSection } from "@/lib/job-hours-source";
// Archived 2026-08-07 — see the note in scripts/archive/parts-spent-audit.ts.
import { legacyPartsCostSpentByJobWindowed as getPartsCostSpentByJob } from "@/lib/sync-totaleto";

const Y = 2026, MO = 7;
const HOURS_EPS = 0.02;
const DOLLAR_EPS = 1.0; // "to the dollar"

async function reconcileHours() {
  // App path: exact same transform the ETC grid's Hours Worked uses.
  const sp = hoursByJobSection(await fetchJobHoursRows(), Y, MO); // key `${jobId}::${section}`

  // PBI plain [Hours Actual] for the month by job/section.
  const dax = (await runDax(
    `EVALUATE SUMMARIZECOLUMNS('Job'[Job Id], 'Function Hierarchy'[Section-Function Code], ` +
      `FILTER(ALL('Date'), 'Date'[Year]=${Y} && 'Date'[Month]=${MO}), "H", [Hours Actual])`,
  )) as Record<string, unknown>[];
  const pbi = new Map<string, number>();
  for (const r of dax) {
    const j = r["Job[Job Id]"], s = r["Function Hierarchy[Section-Function Code]"];
    if (j != null && s != null && ETC_TRACKED_CODES.has(String(s))) {
      pbi.set(`${String(Number(j))}::${s}`, Number(r.H ?? 0));
    }
  }

  const keys = new Set([...sp.keys(), ...pbi.keys()]);
  let match = 0, diff = 0; const diffs: string[] = [];
  for (const k of keys) {
    const a = round2(sp.get(k) ?? 0), b = round2(pbi.get(k) ?? 0);
    if (Math.abs(a) < HOURS_EPS && Math.abs(b) < HOURS_EPS) continue;
    if (Math.abs(a - b) < HOURS_EPS) match++;
    else { diff++; if (diffs.length < 30) diffs.push(`${k}: sharepoint=${a} pbi=${b} (Δ${round2(a - b)})`); }
  }
  console.log(`\n=== HOURS — SharePoint transform vs PBI [Hours Actual] (${Y}-${String(MO).padStart(2, "0")}) ===`);
  console.log(`per job/section: match=${match} differ=${diff}`);
  for (const d of diffs) console.log("  ✗ " + d);
}

async function reconcileParts() {
  const start = new Date(Date.UTC(Y, MO - 1, 1));
  const end = new Date(Date.UTC(Y, MO, 1));
  // App path: exact same TotalETO SQL the parts sync uses.
  const eto = await getPartsCostSpentByJob(start, end); // key numeric Job Id string

  // PBI [Part Cost Purchased] by job for the same month (windowed on Invoiced Date via 'Date').
  const dax = (await runDax(
    `EVALUATE SUMMARIZECOLUMNS('Job'[Job Id], ` +
      `FILTER(ALL('Date'), 'Date'[Year]=${Y} && 'Date'[Month]=${MO}), "C", [Part Cost Purchased])`,
  )) as Record<string, unknown>[];
  const pbi = new Map<string, number>();
  for (const r of dax) {
    const j = r["Job[Job Id]"];
    if (j != null) pbi.set(String(Number(j)), Number(r.C ?? 0));
  }

  // Only compare jobs the app actually tracks (PBI includes spare-parts/service buckets the app excludes).
  const appJobIds = new Set((await prisma.job.findMany({ select: { jobId: true } })).map((j) => j.jobId));

  const keys = new Set([...eto.keys(), ...pbi.keys()].filter((k) => appJobIds.has(k)));
  let match = 0, diff = 0; const diffs: string[] = [];
  let etoOnlyNonApp = 0, pbiOnlyNonApp = 0;
  for (const k of new Set([...eto.keys(), ...pbi.keys()])) {
    if (!appJobIds.has(k)) { if (eto.has(k)) etoOnlyNonApp++; if (pbi.has(k) && !eto.has(k)) pbiOnlyNonApp++; }
  }
  for (const k of keys) {
    const a = Math.round(eto.get(k) ?? 0), b = Math.round(pbi.get(k) ?? 0);
    if (Math.abs(a) < DOLLAR_EPS && Math.abs(b) < DOLLAR_EPS) continue;
    if (Math.abs(a - b) < DOLLAR_EPS) match++;
    else { diff++; if (diffs.length < 30) diffs.push(`job ${k}: totaleto=$${a} pbi=$${b} (Δ$${a - b})`); }
  }
  console.log(`\n=== PARTS — TotalETO SQL vs PBI [Part Cost Purchased] (${Y}-${String(MO).padStart(2, "0")}) ===`);
  console.log(`app-tracked jobs: match=${match} differ=${diff}`);
  console.log(`(ignored non-app job ids: ${etoOnlyNonApp} in TotalETO, ${pbiOnlyNonApp} PBI-only)`);
  for (const d of diffs) console.log("  ✗ " + d);
}

async function main() {
  await reconcileHours();
  await reconcileParts();
  console.log("\nDone.");
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
