/**
 * The Paylocity punches booked to a job number this app has no Job row for.
 *
 * Run:  npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-unmatched-job-labels.ts
 *       (add --csv to also write a per-row CSV beside it)
 *
 * These are the ONLY Paylocity hours that cannot appear in any per-job report:
 * they carry a job number, so they are not "Not Defined" time, but the number
 * matches no job in this app — so there is nothing to attribute them to. Whether
 * that is a typo, a legacy job never imported, or a formatting mismatch is a
 * question about the data, and this report exists to make it answerable.
 *
 * The one thing it tries to decide itself: whether the label WOULD match a real
 * job under a looser comparison (leading zeros, a -02 suffix, plain numeric
 * equality). A label that matches that way is a normalisation bug in this app,
 * not a mistake by whoever typed it — a completely different fix, so the two are
 * separated in the output rather than left in one pile.
 *
 * Read-only.
 */
import { prisma } from "../src/lib/prisma";
import { writeFileSync } from "node:fs";

const f = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Loose forms of a label, for spotting a job that exists under a near-miss spelling. */
function candidates(label: string): string[] {
  const t = label.trim();
  const out = new Set<string>([t]);
  out.add(t.replace(/^0+/, ""));           // "0925" -> "925"
  out.add(t.split("-")[0]);                 // "1037-02" -> "1037"
  out.add(t.split("-")[0].replace(/^0+/, ""));
  if (/^\d+$/.test(t)) out.add(String(Number(t)));
  return [...out].filter((s) => s.length > 0);
}

async function main() {
  const writeCsv = process.argv.includes("--csv");

  const rows = await prisma.undefinedHoursRow.findMany({
    where: { reason: "JOB_NOT_FOUND" },
    select: {
      label: true, workDate: true, employeeId: true, hours: true, section: true,
      month: true, sourceFile: true, sourceRow: true, countsTowardKpi: true,
    },
    orderBy: [{ label: "asc" }, { workDate: "asc" }],
  });

  // "Not Defined" is a different problem — no job number was entered at all — so
  // it is counted and set aside rather than mixed in with numbers that ARE typed.
  const noNumber = rows.filter((r) => !/\d/.test(r.label));
  const numbered = rows.filter((r) => /\d/.test(r.label));

  const [jobs, employees] = await Promise.all([
    prisma.job.findMany({ select: { jobId: true, jobName: true, status: true } }),
    prisma.employee.findMany({ where: { paylocityId: { not: null } }, select: { paylocityId: true, name: true } }),
  ]);
  const jobByAnyForm = new Map<string, (typeof jobs)[number]>();
  for (const j of jobs) {
    for (const form of candidates(j.jobId)) if (!jobByAnyForm.has(form)) jobByAnyForm.set(form, j);
  }
  const nameFor = new Map(employees.map((e) => [e.paylocityId!, e.name]));

  type Group = {
    label: string; hours: number; rows: number;
    first: string; last: string;
    employees: Map<string, number>;
    sections: Map<string, number>;
    match: (typeof jobs)[number] | null;
    matchedVia: string | null;
  };
  const groups = new Map<string, Group>();
  for (const r of numbered) {
    let g = groups.get(r.label);
    if (!g) {
      let match: (typeof jobs)[number] | null = null;
      let via: string | null = null;
      for (const form of candidates(r.label)) {
        const hit = jobByAnyForm.get(form);
        if (hit) { match = hit; via = form === r.label.trim() ? "exact" : `as "${form}"`; break; }
      }
      groups.set(r.label, (g = { label: r.label, hours: 0, rows: 0, first: "9999", last: "0000", employees: new Map(), sections: new Map(), match, matchedVia: via }));
    }
    const hrs = Number(r.hours);
    g.hours += hrs; g.rows += 1;
    const d = r.workDate ? r.workDate.toISOString().slice(0, 10) : "(no date)";
    if (d < g.first) g.first = d;
    if (d > g.last) g.last = d;
    g.employees.set(r.employeeId, (g.employees.get(r.employeeId) ?? 0) + hrs);
    g.sections.set(r.section, (g.sections.get(r.section) ?? 0) + hrs);
  }

  const all = [...groups.values()].sort((a, b) => b.hours - a.hours);
  const fixable = all.filter((g) => g.match);
  const unknown = all.filter((g) => !g.match);
  const sum = (xs: Group[]) => xs.reduce((s, g) => s + g.hours, 0);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`PAYLOCITY HOURS BOOKED TO A JOB NUMBER THIS APP DOES NOT HAVE`);
  console.log("=".repeat(78));
  console.log(`\nTotals`);
  console.log(`  hours on a TYPED job number that matches nothing : ${f(sum(all))} h  (${numbered.length} punches, ${all.length} distinct numbers)`);
  console.log(`  hours with NO job number typed at all           : ${f(noNumber.reduce((s, r) => s + Number(r.hours), 0))} h  (${noNumber.length} punches)`);
  console.log(`\n  of the typed-but-unmatched hours:`);
  console.log(`    would match a real job under a looser spelling : ${f(sum(fixable))} h  (${fixable.length} numbers)  <- an app problem`);
  console.log(`    match no job in any form                       : ${f(sum(unknown))} h  (${unknown.length} numbers)  <- a data problem`);

  const show = (title: string, list: Group[]) => {
    if (list.length === 0) return;
    console.log(`\n${title}`);
    console.log("-".repeat(78));
    for (const g of list) {
      const emps = [...g.employees.entries()].sort((a, b) => b[1] - a[1]).map(([id, h]) => `${nameFor.get(id) ?? `#${id}`} (${f(h)}h)`);
      const secs = [...g.sections.entries()].sort((a, b) => b[1] - a[1]).map(([s, h]) => `${s} ${f(h)}h`);
      console.log(`\n  Job number typed: "${g.label}"`);
      console.log(`    hours            : ${f(g.hours)} h across ${g.rows} punches`);
      console.log(`    worked           : ${g.first} to ${g.last}`);
      console.log(`    who              : ${emps.join(", ")}`);
      console.log(`    section-function : ${secs.join(", ")}`);
      if (g.match) console.log(`    LOOKS LIKE       : job ${g.match.jobId} — ${g.match.jobName} (${g.match.status})  [matched ${g.matchedVia}]`);
      else console.log(`    no job matches   : not as typed, not without leading zeros, not before a "-" suffix`);
    }
  };

  show("A. THESE LOOK LIKE REAL JOBS ALREADY IN THE APP (a spelling/format mismatch)", fixable);
  show("B. THESE MATCH NO JOB AT ALL (needs a human to say what they are)", unknown);

  if (writeCsv) {
    const lines = ["label,work_date,employee,employee_id,hours,section_function,month,source_file,source_row,counted_in_kpi"];
    for (const r of numbered) {
      lines.push([
        `"${r.label}"`, r.workDate ? r.workDate.toISOString().slice(0, 10) : "",
        `"${(nameFor.get(r.employeeId) ?? "").replace(/"/g, "'")}"`, r.employeeId,
        Number(r.hours).toFixed(2), r.section, r.month, `"${r.sourceFile}"`, r.sourceRow, r.countsTowardKpi ? "yes" : "no",
      ].join(","));
    }
    const out = "unmatched-job-hours.csv";
    writeFileSync(out, lines.join("\n"), "utf8");
    console.log(`\n  Per-punch detail written to ${out} (${numbered.length} rows).`);
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
