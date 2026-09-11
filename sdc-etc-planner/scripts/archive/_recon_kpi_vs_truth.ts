// One-off: compares the two numbers behind the Engineering/Shop KPI cards —
// EtcEntry.hoursWorked (the card) and JobHoursDetail (the drill) — against a
// FRESH pull straight from the SharePoint source (the same ground truth
// _recon_july_2026.ts just proved matches Power BI's [Hours Actual] exactly).
//
// Run: npx tsx scripts/_recon_kpi_vs_truth.ts
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { ETC_SECTIONS } from "@/lib/sections";
import { round2 } from "@/lib/etc";
import { fetchJobHoursRows, hoursByJobSection } from "@/lib/job-hours-source";

const MONTH = "2026-07";
const Y = 2026, MO = 7;
const GROUP = new Map(ETC_SECTIONS.map((s) => [s.code, s.billingGroup]));

async function main() {
  const jobs = await prisma.job.findMany({ select: { id: true, jobId: true } });
  // Kept for the next person to reach for; underscore is this repo's allowed idiom.
  const _jobIdByPk = new Map(jobs.map((j) => [j.id, j.jobId]));
  const jobPks = jobs.map((j) => j.id);

  // Ground truth: fresh fetch, right now.
  const truth = hoursByJobSection(await fetchJobHoursRows(), Y, MO);
  let truthEng = 0, truthShop = 0;
  for (const [key, hours] of truth) {
    const section = key.split("::")[1];
    const group = GROUP.get(section);
    if (group === "Engineering") truthEng += hours;
    else if (group === "Shop") truthShop += hours;
  }

  // Card: EtcEntry.hoursWorked, as stored right now.
  const entries = await prisma.etcEntry.findMany({ where: { month: MONTH }, select: { section: true, hoursWorked: true } });
  let cardEng = 0, cardShop = 0;
  for (const e of entries) {
    const group = GROUP.get(e.section);
    if (group === "Engineering") cardEng += Number(e.hoursWorked);
    else if (group === "Shop") cardShop += Number(e.hoursWorked);
  }

  // Drill: JobHoursDetail, as stored right now.
  const punches = await prisma.jobHoursDetail.findMany({ where: { month: MONTH, jobId: { in: jobPks } }, select: { section: true, hours: true } });
  let drillEng = 0, drillShop = 0;
  for (const p of punches) {
    const group = GROUP.get(p.section);
    if (group === "Engineering") drillEng += Number(p.hours);
    else if (group === "Shop") drillShop += Number(p.hours);
  }

  console.log(`\n=== Engineering, ${MONTH} ===`);
  console.log(`  ground truth (fresh SharePoint pull, right now): ${round2(truthEng)}`);
  console.log(`  card  (EtcEntry.hoursWorked, as stored):         ${round2(cardEng)}  (Δ ${round2(cardEng - truthEng)})`);
  console.log(`  drill (JobHoursDetail, as stored):                ${round2(drillEng)}  (Δ ${round2(drillEng - truthEng)})`);

  console.log(`\n=== Shop, ${MONTH} ===`);
  console.log(`  ground truth (fresh SharePoint pull, right now): ${round2(truthShop)}`);
  console.log(`  card  (EtcEntry.hoursWorked, as stored):         ${round2(cardShop)}  (Δ ${round2(cardShop - truthShop)})`);
  console.log(`  drill (JobHoursDetail, as stored):                ${round2(drillShop)}  (Δ ${round2(drillShop - truthShop)})`);
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
