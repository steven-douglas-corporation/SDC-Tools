// Part 2 of the actuals recon: WHERE the 69,327h the app is missing actually
// lives. Two very different causes look identical on the grid:
//
//   (a) hours booked to a section code the app does not model at all — there is
//       no column for them, so no sync can put them anywhere; and
//   (b) hours on a section the app DOES model, which the app's three eras
//       genuinely miss — a real backfill target.
//
// Only (b) is fixed by pulling from Power BI. Splitting them decides the work.
//
// Read-only. Writes nothing.
//
// Run: npx tsx scripts/_recon_actuals_gap_split.ts
import "dotenv/config";
import { runDax } from "@/lib/powerbi-client";
import { prisma } from "@/lib/prisma";
import { SECTIONS } from "@/lib/sections";

type Row = {
  "Job[Job Id]": string | null;
  "Function Hierarchy[Section-Function Code]": string | null;
  Hours: number | null;
};

const normJobId = (raw: string) => raw.trim().replace(/^0+(?=\d)/, "");
const PARTS_COST_SECTION = "PARTS_COST";
const VALID = ["Custom", "Duplicate", "Hybrid", "Service", "T&M"];

async function appActuals(jobPks: number[]) {
  const out = new Map<string, number>(); // "jobPk::section"
  const covered = (await prisma.jobHoursDetail.groupBy({ by: ["month"] })).map((r) => r.month);
  const [historical, frozen, punches] = await Promise.all([
    prisma.estimatedHours.findMany({ where: { jobId: { in: jobPks } }, select: { jobId: true, section: true, actualHistoricalHours: true } }),
    prisma.etcEntry.groupBy({ by: ["jobId", "section"], where: { jobId: { in: jobPks }, section: { not: PARTS_COST_SECTION }, month: { notIn: covered } }, _sum: { hoursWorked: true } }),
    prisma.jobHoursDetail.groupBy({ by: ["jobId", "section"], where: { jobId: { in: jobPks }, month: { in: covered } }, _sum: { hours: true } }),
  ]);
  const add = (jobId: number, section: string, h: number) => {
    if (!h) return;
    out.set(`${jobId}::${section}`, (out.get(`${jobId}::${section}`) ?? 0) + h);
  };
  for (const h of historical) add(h.jobId, h.section, Number(h.actualHistoricalHours ?? 0));
  for (const f of frozen) add(f.jobId, f.section, Number(f._sum.hoursWorked ?? 0));
  for (const p of punches) add(p.jobId, p.section, Number(p._sum.hours ?? 0));
  return { out, covered };
}

async function main() {
  const rows = (await runDax(`
EVALUATE
FILTER(
  SUMMARIZECOLUMNS(
    'Job'[Job Id],
    'Function Hierarchy'[Section-Function Code],
    "Hours", SUM('Hours Actual'[Hours Actual])
  ),
  [Hours] <> 0
)`)) as Row[];

  const jobs = await prisma.job.findMany({ where: { type: { in: VALID } }, select: { id: true, jobId: true } });
  const pkByJobId = new Map(jobs.map((j) => [j.jobId, j.id]));
  const { out: app, covered } = await appActuals(jobs.map((j) => j.id));
  console.log(`punch import covers ${covered.length} months: ${[...covered].sort().join(", ")}`);

  const appCodes = new Set(SECTIONS.map((s) => s.code));

  // Gap per section code, split by whether the app models that code.
  const bySection = new Map<string, { pbi: number; app: number; gap: number; modelled: boolean; jobs: Set<string> }>();
  let unmatchedJob = 0;
  let notDefinedJob = 0;

  for (const r of rows) {
    const rawJobId = (r["Job[Job Id]"] ?? "").trim();
    const section = (r["Function Hierarchy[Section-Function Code]"] ?? "").trim();
    const hours = Number(r.Hours ?? 0);
    if (rawJobId === "NOT DEFINED" || !rawJobId) {
      notDefinedJob += hours;
      continue;
    }
    const jobId = normJobId(rawJobId);
    const pk = pkByJobId.get(jobId);
    if (pk === undefined) {
      unmatchedJob += hours; // job in PBI that the app has no row for at all
      continue;
    }
    let e = bySection.get(section);
    if (!e) bySection.set(section, (e = { pbi: 0, app: 0, gap: 0, modelled: appCodes.has(section), jobs: new Set() }));
    e.pbi += hours;
    const a = app.get(`${pk}::${section}`) ?? 0;
    e.app += a;
    e.gap += hours - a;
    if (Math.abs(hours - a) >= 1) e.jobs.add(jobId);
  }

  const all = [...bySection.entries()].sort((a, b) => b[1].gap - a[1].gap);
  const modelled = all.filter(([, v]) => v.modelled);
  const unmodelled = all.filter(([, v]) => !v.modelled);

  const sum = (xs: typeof all, f: (v: (typeof all)[0][1]) => number) => xs.reduce((s, [, v]) => s + f(v), 0);

  console.log(`\nPBI hours that can't be attributed to an app job:`);
  console.log(`  Job Id "NOT DEFINED": ${notDefinedJob.toFixed(0)}h`);
  console.log(`  job not in the app (or wrong Type): ${unmatchedJob.toFixed(0)}h`);

  console.log(`\n=== sections the app MODELS (${modelled.length} codes) ===`);
  console.log(`  PBI ${sum(modelled, (v) => v.pbi).toFixed(0)}h   app ${sum(modelled, (v) => v.app).toFixed(0)}h   GAP ${sum(modelled, (v) => v.gap).toFixed(0)}h`);
  console.log("  code".padEnd(12) + "pbi".padStart(10) + "app".padStart(10) + "gap".padStart(10) + "  jobs");
  for (const [code, v] of modelled) {
    console.log("  " + code.padEnd(10) + v.pbi.toFixed(0).padStart(10) + v.app.toFixed(0).padStart(10) + v.gap.toFixed(0).padStart(10) + "  " + v.jobs.size);
  }

  console.log(`\n=== sections the app does NOT model (${unmodelled.length} codes) ===`);
  console.log(`  PBI ${sum(unmodelled, (v) => v.pbi).toFixed(0)}h — no column exists, so no sync can place these`);
  console.log("  code".padEnd(12) + "pbi".padStart(10) + "  jobs");
  for (const [code, v] of unmodelled.slice(0, 25)) {
    console.log("  " + code.padEnd(10) + v.pbi.toFixed(0).padStart(10) + "  " + v.jobs.size);
  }
  if (unmodelled.length > 25) console.log(`  ... and ${unmodelled.length - 25} more codes, ${sum(unmodelled.slice(25), (v) => v.pbi).toFixed(0)}h`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
