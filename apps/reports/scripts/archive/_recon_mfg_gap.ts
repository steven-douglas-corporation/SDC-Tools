// Chase the Manufacturing gap: local punches run short of PBI by -4.52 / -18 /
// 0 / -0.03 / -31.50 / -184.50 across 2026-01..06, worst in the most recent
// complete month. Two candidate explanations, and they predict different things:
//
//   (a) the local export file is stale / missing recent rows
//         -> the gap is spread across many jobs, and the export's latest work
//            date sits well before month end.
//   (b) the app's code mapping misses some manufacturing punches
//         -> the gap concentrates in particular jobs or particular raw codes.
//
// Compares per JOB against PBI's plain [Hours Actual], filtered on the Date
// table by calendar month, so the ETC-period naming mess plays no part.
//
// Run: npx tsx scripts/_recon_mfg_gap.ts
import "dotenv/config";
import { runDax } from "@/lib/powerbi-client";
import { prisma } from "@/lib/prisma";
import { fetchJobHoursRows, latestWorkDate } from "@/lib/job-hours-source";
import { round2 } from "@/lib/etc";

// What PBI calls Manufacturing (function 414) and what the app codes it as.
const MFG_SECTIONS = new Set(["10-413", "10-414"]);
const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];

async function main() {
  const rows = await fetchJobHoursRows();
  console.log(`Export's latest work date: ${latestWorkDate(rows)?.toISOString().slice(0, 10) ?? "n/a"}`);

  // Raw code census for the shop-ish functions, so a mis-mapped code shows up.
  console.log("\n=== Every section code the export carries, by month, for functions 400-420 ===");
  const census = new Map<string, number>(); // `${month}::${section}`
  for (const r of rows) {
    const fn = r.section.split("-")[1] ?? "";
    if (!(Number(fn) >= 400 && Number(fn) <= 420)) continue;
    const m = `${r.year}-${String(r.month).padStart(2, "0")}`;
    const k = `${m}::${r.section}`;
    census.set(k, (census.get(k) ?? 0) + r.hours);
  }
  const sections = [...new Set([...census.keys()].map((k) => k.split("::")[1]))].sort();
  console.log("month     " + sections.map((s) => s.padStart(11)).join(""));
  for (const m of MONTHS.concat("2026-07")) {
    console.log(`${m}  ` + sections.map((s) => (census.get(`${m}::${s}`) ?? 0).toFixed(2).padStart(11)).join(""));
  }

  // Per-job comparison for each month.
  const appJobs = await prisma.job.findMany({ select: { jobId: true } });
  const appJobIds = new Set(appJobs.map((j) => j.jobId));

  for (const month of MONTHS) {
    const [Y, MO] = month.split("-").map(Number);
    const dax = (await runDax(
      `EVALUATE SUMMARIZECOLUMNS('Job'[Job Id], 'Function Hierarchy'[Section-Function Code], ` +
        `FILTER(ALL('Date'), 'Date'[Year]=${Y} && 'Date'[Month]=${MO}), "H", [Hours Actual])`,
    )) as Record<string, unknown>[];

    const pbi = new Map<string, number>();
    for (const r of dax) {
      const j = r["Job[Job Id]"], s = String(r["Function Hierarchy[Section-Function Code]"] ?? "");
      if (j == null || !MFG_SECTIONS.has(s)) continue;
      const key = String(Number(j));
      pbi.set(key, (pbi.get(key) ?? 0) + Number(r.H ?? 0));
    }

    const loc = new Map<string, number>();
    for (const r of rows) {
      if (r.year !== Y || r.month !== MO || r.section !== "10-413") continue;
      loc.set(r.jobId, (loc.get(r.jobId) ?? 0) + r.hours);
    }

    const keys = [...new Set([...pbi.keys(), ...loc.keys()])].sort();
    const diffs: string[] = [];
    let pbiTot = 0, locTot = 0, pbiNonApp = 0;
    for (const k of keys) {
      const p = round2(pbi.get(k) ?? 0), l = round2(loc.get(k) ?? 0);
      pbiTot += p; locTot += l;
      if (!appJobIds.has(k)) pbiNonApp += p;
      if (Math.abs(p - l) >= 0.01) diffs.push(`    job ${k.padEnd(6)} pbi=${p.toFixed(2).padStart(8)} local=${l.toFixed(2).padStart(8)} Δ${(l - p).toFixed(2).padStart(8)}${appJobIds.has(k) ? "" : "   <- not an app job"}`);
    }
    console.log(`\n── ${month}: pbi=${pbiTot.toFixed(2)} local=${locTot.toFixed(2)} Δ${(locTot - pbiTot).toFixed(2)}  (of which pbi hours on non-app jobs: ${pbiNonApp.toFixed(2)})`);
    console.log(`   jobs differing: ${diffs.length}`);
    for (const d of diffs.slice(0, 15)) console.log(d);
    if (diffs.length > 15) console.log(`    ... and ${diffs.length - 15} more`);
  }
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
