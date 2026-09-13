// Recon: the Projects grid's "Actual hours" vs the Power BI semantic model.
//
// Reported 2026-08-03: "a lot of actuals of a lot of projects are wrong" — the
// grid shows /0 for whole rows of completed jobs that plainly took hours (e.g.
// 810 Automated Wire Harness Kitting, 2,000 quoted / 0 actual).
//
// The app builds actuals from three non-overlapping eras (see actual-hours.ts):
// the Excel migration snapshot, frozen EtcEntry.hoursWorked for months the punch
// import doesn't cover, and JobHoursDetail punches for the months it does. This
// asks the model for the same figure per job/section and prints the gap, so the
// fix is aimed at whatever is actually missing rather than at a guess.
//
// Read-only. Writes nothing.
//
// Run: npx tsx scripts/_recon_actuals_vs_pbi.ts
import "dotenv/config";
import { runDax } from "@/lib/powerbi-client";
import { prisma } from "@/lib/prisma";

// actual-hours.ts can't be imported here: it starts with `import "server-only"`,
// which resolves through Next's bundler alias and does not exist as a real
// package, so tsx can't load it. Copied verbatim below instead — if the rule in
// actual-hours.ts changes, this recon is measuring the old one.
const PARTS_COST_SECTION = "PARTS_COST";

async function loadActualHoursBySection(jobPks: number[]): Promise<Map<number, Map<string, number>>> {
  const out = new Map<number, Map<string, number>>();
  if (jobPks.length === 0) return out;
  const covered = (await prisma.jobHoursDetail.groupBy({ by: ["month"] })).map((r) => r.month);
  const [historical, frozen, punches] = await Promise.all([
    prisma.estimatedHours.findMany({
      where: { jobId: { in: jobPks } },
      select: { jobId: true, section: true, actualHistoricalHours: true },
    }),
    prisma.etcEntry.groupBy({
      by: ["jobId", "section"],
      where: { jobId: { in: jobPks }, section: { not: PARTS_COST_SECTION }, month: { notIn: covered } },
      _sum: { hoursWorked: true },
    }),
    prisma.jobHoursDetail.groupBy({
      by: ["jobId", "section"],
      where: { jobId: { in: jobPks }, month: { in: covered } },
      _sum: { hours: true },
    }),
  ]);
  const add = (jobId: number, section: string, hours: number) => {
    if (!hours) return;
    let sections = out.get(jobId);
    if (!sections) out.set(jobId, (sections = new Map()));
    sections.set(section, (sections.get(section) ?? 0) + hours);
  };
  for (const h of historical) add(h.jobId, h.section, Number(h.actualHistoricalHours ?? 0));
  for (const f of frozen) add(f.jobId, f.section, Number(f._sum.hoursWorked ?? 0));
  for (const p of punches) add(p.jobId, p.section, Number(p._sum.hours ?? 0));
  return out;
}

type Row = {
  "Job[Job Id]": string | null;
  "Function Hierarchy[Section-Function Code]": string | null;
  // Extension columns come back WITHOUT brackets ("Hours"), unlike the table
  // columns above. Getting this wrong is silent: every row still arrives, the
  // hours just read 0, so the whole model looks empty.
  Hours: number | null;
};

// PBI zero-pads Job Id ("0814", "0867"); the app stores it unpadded ("814").
// Joining raw makes every older job look like it has no hours at all.
const normJobId = (raw: string) => raw.trim().replace(/^0+(?=\d)/, "");

async function main() {
  // No date filter: every hour the model holds, at the job/section grain the
  // grid renders. SELECTCOLUMNS isn't needed here because SUMMARIZECOLUMNS never
  // touches the broken 'Hours Actual'[Hours Actual Est to Date] calculated
  // column (see docs/SEMANTIC-MODEL-MAP.md).
  const dax = `
EVALUATE
FILTER(
  SUMMARIZECOLUMNS(
    'Job'[Job Id],
    'Function Hierarchy'[Section-Function Code],
    "Hours", SUM('Hours Actual'[Hours Actual])
  ),
  [Hours] <> 0
)`;
  const rows = (await runDax(dax)) as Row[];
  console.log(`PBI rows (job x section, non-zero): ${rows.length}`);

  const pbi = new Map<string, number>(); // "jobId::section" -> hours
  const pbiByJob = new Map<string, number>();
  let notDefined = 0;
  for (const r of rows) {
    const rawJobId = (r["Job[Job Id]"] ?? "").trim();
    const jobId = normJobId(rawJobId);
    const section = (r["Function Hierarchy[Section-Function Code]"] ?? "").trim();
    const hours = Number(r.Hours ?? 0);
    if (!jobId || rawJobId === "NOT DEFINED") {
      notDefined += hours;
      continue;
    }
    pbi.set(`${jobId}::${section}`, (pbi.get(`${jobId}::${section}`) ?? 0) + hours);
    pbiByJob.set(jobId, (pbiByJob.get(jobId) ?? 0) + hours);
  }
  console.log(`PBI hours under Job Id "NOT DEFINED" (unattributable): ${notDefined.toFixed(1)}`);
  console.log(`PBI jobs with hours: ${pbiByJob.size}, total ${[...pbiByJob.values()].reduce((a, b) => a + b, 0).toFixed(1)}h`);

  // App side, through the SAME function the grid calls.
  const jobs = await prisma.job.findMany({
    where: { type: { in: ["Custom", "Duplicate", "Hybrid", "Service", "T&M"] } },
    select: { id: true, jobId: true, jobName: true, status: true },
  });
  const app = await loadActualHoursBySection(jobs.map((j) => j.id));

  let appTotal = 0;
  const appByJob = new Map<string, number>();
  for (const j of jobs) {
    const sections = app.get(j.id);
    let t = 0;
    for (const [, h] of sections ?? []) t += h;
    appByJob.set(j.jobId, t);
    appTotal += t;
  }
  console.log(`APP total actual hours across ${jobs.length} jobs: ${appTotal.toFixed(1)}h`);

  // Per-job comparison, biggest absolute gap first.
  const gaps = jobs
    .map((j) => {
      const a = appByJob.get(j.jobId) ?? 0;
      const p = pbiByJob.get(j.jobId) ?? 0;
      return { ...j, app: a, pbi: p, gap: p - a };
    })
    .filter((g) => Math.abs(g.gap) >= 1)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

  const pbiHigher = gaps.filter((g) => g.gap > 0);
  const appHigher = gaps.filter((g) => g.gap < 0);
  console.log(`\njobs where they disagree by >=1h: ${gaps.length} of ${jobs.length}`);
  console.log(`  PBI higher (app is missing hours): ${pbiHigher.length}, total +${pbiHigher.reduce((s, g) => s + g.gap, 0).toFixed(1)}h`);
  console.log(`  APP higher (PBI has no such hours): ${appHigher.length}, total ${appHigher.reduce((s, g) => s + g.gap, 0).toFixed(1)}h`);

  console.log(`\n--- worst 25 gaps ---`);
  console.log("jobId".padEnd(8) + "status".padEnd(10) + "app".padStart(10) + "pbi".padStart(10) + "gap".padStart(10) + "  name");
  for (const g of gaps.slice(0, 25)) {
    console.log(
      g.jobId.padEnd(8) +
        (g.status ?? "").padEnd(10) +
        g.app.toFixed(0).padStart(10) +
        g.pbi.toFixed(0).padStart(10) +
        g.gap.toFixed(0).padStart(10) +
        "  " +
        (g.jobName ?? "").slice(0, 40)
    );
  }

  // The specific complaint: rows showing 0 actual on the grid.
  const zeroInApp = jobs.filter((j) => (appByJob.get(j.jobId) ?? 0) === 0);
  const zeroButPbiHas = zeroInApp.filter((j) => (pbiByJob.get(j.jobId) ?? 0) > 0);
  console.log(`\njobs the grid shows as 0 actual: ${zeroInApp.length}`);
  console.log(`  ...of which PBI DOES have hours: ${zeroButPbiHas.length} (${zeroButPbiHas.reduce((s, j) => s + (pbiByJob.get(j.jobId) ?? 0), 0).toFixed(0)}h)`);
  console.log(`  ...of which PBI ALSO has nothing: ${zeroInApp.length - zeroButPbiHas.length}`);
  for (const j of zeroButPbiHas.slice(0, 15)) {
    console.log(`    ${j.jobId.padEnd(8)} ${(pbiByJob.get(j.jobId) ?? 0).toFixed(0).padStart(8)}h  ${(j.jobName ?? "").slice(0, 40)}`);
  }

  // Section-code sanity: does the model's Section-Function Code vocabulary match
  // the app's? A mismatch here would look exactly like "missing actuals".
  const { SECTIONS } = await import("@/lib/sections");
  const appCodes = new Set(SECTIONS.map((s) => s.code));
  const pbiCodes = new Set([...pbi.keys()].map((k) => k.split("::")[1]));
  const unknown = [...pbiCodes].filter((c) => !appCodes.has(c));
  console.log(`\nPBI section codes not modelled by the app (${unknown.length}): ${unknown.slice(0, 30).join(", ")}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
