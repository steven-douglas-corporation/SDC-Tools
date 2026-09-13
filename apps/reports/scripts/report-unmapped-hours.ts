// Generates docs/UNMAPPED-HOURS.md — every hour in the Power BI hours feed that does
// NOT reach a per-job figure in the app, listed job by job and code by code.
//
// Three distinct populations, which matter for different reasons:
//
//   A. codes that reach NO figure anywhere — no ETC column, no Standard Fees
//      pool. These are hours the app currently loses entirely.
//   B. codes with no ETC grid column that ARE counted, company-wide, in a
//      Standard Fees pool. Not lost, but never attributed to a job.
//   C. hours booked against Job Id "NOT DEFINED" upstream. Unattributable by
//      construction — a Paylocity coding problem, not an app modelling one.
//
// Read-only against both the model and the database. Writes one .md file.
//
// Run: npx tsx scripts/report-unmapped-hours.ts
import "dotenv/config";
import fs from "fs/promises";
import { runDax } from "../src/lib/powerbi-client";
import { prisma } from "../src/lib/prisma";
import { HOURS_IMPORT_CODES, poolCategoryForPunch } from "../src/lib/sections";
import { buildColumnResolver } from "../src/lib/job-hours-source";

type Row = {
  "Job[Job Id]": string | null;
  "Function Hierarchy[Section-Function Code]": string | null;
  "Date[Date]": string | null;
  Hours: number | null;
};

const normJobId = (raw: string) => raw.trim().replace(/^0+(?=\d)/, "");
const OUT = "docs/UNMAPPED-HOURS.md";

// Same classification the reader applies, but reported instead of acted on.
// Uses the model-derived code->column map, so this report and the sync can never
// disagree about what "unmapped" means.
let resolveColumn: (c: string) => string | null = () => null;
function classify(rawSection: string): "counted" | "pool" | "lost" {
  const [machineSec, fn] = rawSection.split("-");
  if (fn === "417") return "lost"; // dropped upstream by Power BI too
  const mapped = resolveColumn(rawSection) ?? rawSection;
  if (mapped === "10-311" || HOURS_IMPORT_CODES.has(mapped)) return "counted";
  return poolCategoryForPunch(machineSec, fn) ? "pool" : "lost";
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

async function main() {
  resolveColumn = (await buildColumnResolver()).resolve;
  const rows = (await runDax(`
EVALUATE
FILTER(
  SUMMARIZECOLUMNS(
    'Job'[Job Id],
    'Function Hierarchy'[Section-Function Code],
    'Date'[Date],
    FILTER(ALL('Hours Actual'[Data Source]), 'Hours Actual'[Data Source] = "Paylocity Hours"),
    "Hours", SUM('Hours Actual'[Hours Actual])
  ),
  [Hours] <> 0
)`)) as Row[];

  const jobs = await prisma.job.findMany({ select: { jobId: true, jobName: true, status: true, type: true } });
  const jobByJobId = new Map(jobs.map((j) => [j.jobId, j]));

  // code -> jobId -> hours, for the two per-job populations
  const lost = new Map<string, Map<string, number>>();
  const pool = new Map<string, Map<string, number>>();
  // NOT DEFINED: code -> month -> hours
  const notDefined = new Map<string, Map<string, number>>();
  let notDefinedTotal = 0;
  const monthsSeen = new Set<string>();

  const add = (m: Map<string, Map<string, number>>, k1: string, k2: string, h: number) => {
    let inner = m.get(k1);
    if (!inner) m.set(k1, (inner = new Map()));
    inner.set(k2, (inner.get(k2) ?? 0) + h);
  };

  for (const r of rows) {
    const hours = Number(r.Hours ?? 0);
    if (!hours) continue;
    const code = (r["Function Hierarchy[Section-Function Code]"] ?? "").trim();
    if (!code) continue;
    const month = (r["Date[Date]"] ?? "").slice(0, 7);
    monthsSeen.add(month);
    const rawJob = (r["Job[Job Id]"] ?? "").trim();

    if (rawJob === "" || !Number.isFinite(Number(rawJob))) {
      add(notDefined, code, month, hours);
      notDefinedTotal += hours;
      continue;
    }
    const kind = classify(code);
    if (kind === "counted") continue;
    add(kind === "pool" ? pool : lost, code, normJobId(rawJob), hours);
  }

  const codeTotal = (m: Map<string, Map<string, number>>, code: string) =>
    [...(m.get(code)?.values() ?? [])].reduce((a, b) => a + b, 0);
  const grandTotal = (m: Map<string, Map<string, number>>) =>
    [...m.keys()].reduce((s, c) => s + codeTotal(m, c), 0);

  const months = [...monthsSeen].sort();
  const lostTotal = grandTotal(lost);
  const poolTotal = grandTotal(pool);

  const L: string[] = [];
  L.push("# Hours that never reach a project figure");
  L.push("");
  L.push(
    `Generated from the Power BI \`Hours Actual\` table (\`Data Source = "Paylocity Hours"\`), ` +
      `covering **${months[0]} – ${months[months.length - 1]}**. Every hour below is real booked time ` +
      `that does **not** appear against a job on the Projects grid.`,
  );
  L.push("");
  L.push("| bucket | hours | codes | why |");
  L.push("|---|---:|---:|---|");
  L.push(`| A. Lost entirely | **${fmt(lostTotal)}** | ${lost.size} | no ETC column and no Standard Fees pool |`);
  L.push(`| B. Pool-only | ${fmt(poolTotal)} | ${pool.size} | counted company-wide in a pool, never per job |`);
  L.push(`| C. Job Id \`NOT DEFINED\` | ${fmt(notDefinedTotal)} | ${notDefined.size} | no job on the punch, upstream in Paylocity |`);
  L.push(`| **Total** | **${fmt(lostTotal + poolTotal + notDefinedTotal)}** | | |`);
  L.push("");
  L.push(
    "The app imports every code in `HOURS_IMPORT_CODES` (`src/lib/sections.ts`) — the 17 ETC/Quoted grid columns plus " +
      "PM, Warranty, Manufacturing, Service, Spare Parts, and (2026-08-20) Engineering \"Other\" (Function 112/118/119/120, " +
      "the centralized canonical mapping's catch-all for engineering-shaped work with no per-function breakout). Every other " +
      "code is folded onto one of them using the model's OWN `Function Hierarchy` table, which files each code under a " +
      "(Section Name, Section Function Name) pair. Anything outside that set has nowhere to go — the bucket below is what's left.",
  );
  L.push("");

  const section = (title: string, note: string, m: Map<string, Map<string, number>>) => {
    L.push(`## ${title}`);
    L.push("");
    L.push(note);
    L.push("");
    const codes = [...m.keys()].sort((a, b) => codeTotal(m, b) - codeTotal(m, a));
    L.push("| code | hours | projects |");
    L.push("|---|---:|---:|");
    for (const c of codes) L.push(`| \`${c}\` | ${fmt(codeTotal(m, c))} | ${m.get(c)!.size} |`);
    L.push("");
    for (const c of codes) {
      const byJob = [...m.get(c)!.entries()].sort((a, b) => b[1] - a[1]);
      L.push(`### \`${c}\` — ${fmt(codeTotal(m, c))}h across ${byJob.length} project${byJob.length === 1 ? "" : "s"}`);
      L.push("");
      L.push("| Job Id | hours | status | project |");
      L.push("|---|---:|---|---|");
      for (const [jobId, h] of byJob) {
        const job = jobByJobId.get(jobId);
        const status = job ? (job.type ? (job.status ?? "—") : "no Type — hidden app-wide") : "**not in the app**";
        const name = job?.jobName ?? "—";
        L.push(`| ${jobId} | ${fmt(h)} | ${status} | ${name} |`);
      }
      L.push("");
    }
  };

  section(
    "A. Lost entirely",
    "These reach no figure anywhere in the app — not the Projects grid, not the Monthly ETC grid, not the Standard Fees pools. " +
      "Chiefly the `Service` phase (80-*) and 90-*, which the app has no phase for at all, plus `10-400` and the codes Power BI itself marks Invalid.",
    lost,
  );

  section(
    "B. Counted in a Standard Fees pool, but not against the job",
    "These are not lost — they are in the four company-wide pools (PM, Manufacturing, Warranty Engineering, Warranty Shop), which is by design: " +
      "that work is planned in one pot rather than job by job, which is exactly why the ETC grid has no column for it. " +
      "Listed because the hours still never appear on a project row.",
    pool,
  );

  L.push("## C. Booked to Job Id `NOT DEFINED`");
  L.push("");
  L.push(
    "No project can be named for these — the punch itself carries no job. This is a Paylocity coding problem rather than an app modelling one, " +
      "and it is the bucket worth chasing upstream: `JobMonthlyActualHours.overridden` exists to correct individual months by hand once the real job is known.",
  );
  L.push("");
  const ndCodes = [...notDefined.keys()].sort((a, b) => codeTotal(notDefined, b) - codeTotal(notDefined, a));
  L.push("| code | hours | reaches a job column if fixed? |");
  L.push("|---|---:|---|");
  for (const c of ndCodes) {
    const kind = classify(c);
    L.push(`| \`${c}\` | ${fmt(codeTotal(notDefined, c))} | ${kind === "counted" ? "**yes**" : kind === "pool" ? "pool only" : "no"} |`);
  }
  L.push("");
  for (const c of ndCodes) {
    const byMonth = [...notDefined.get(c)!.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    L.push(`### \`${c}\` — ${fmt(codeTotal(notDefined, c))}h`);
    L.push("");
    L.push("| month | hours |");
    L.push("|---|---:|");
    for (const [month, h] of byMonth) L.push(`| ${month} | ${fmt(h)} |`);
    L.push("");
  }

  L.push("---");
  L.push("");
  L.push(`Regenerate with \`npx tsx scripts/report-unmapped-hours.ts\`.`);
  L.push("");

  await fs.writeFile(OUT, L.join("\n"), "utf8");
  console.log(`wrote ${OUT}`);
  console.log(`  A lost entirely:      ${fmt(lostTotal)}h on ${lost.size} codes`);
  console.log(`  B pool-only:          ${fmt(poolTotal)}h on ${pool.size} codes`);
  console.log(`  C NOT DEFINED:        ${fmt(notDefinedTotal)}h on ${notDefined.size} codes`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
