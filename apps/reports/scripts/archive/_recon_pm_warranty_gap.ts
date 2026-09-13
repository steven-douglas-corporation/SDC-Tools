// Same technique that explained the Manufacturing gap, applied to the other
// two open questions:
//
//   PM — PBI's Standard Fees measure reports 0.00 for Department=PM in EVERY
//        month, yet the punch export carries 260h booked to 10-111. Either the
//        app is inventing hours, or that measure simply doesn't wire PM up.
//        PBI's plain [Hours Actual] on section 10-111 settles it.
//
//   Warranty — engineering warranty ran -28.50 / -1.50 / -2.25 against PBI.
//        Manufacturing's identical-looking gap turned out to be entirely
//        unattributed-job hours; check whether this is the same.
//
// Run: npx tsx scripts/_recon_pm_warranty_gap.ts
import "dotenv/config";
import { runDax } from "@/lib/powerbi-client";
import { prisma } from "@/lib/prisma";
import { fetchJobHoursRowsWithIssues } from "@/lib/job-hours-source";
import { type PoolCategory } from "@/lib/sections";
import { round2 } from "@/lib/etc";

const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];

// PBI section codes that roll into each pool, mirroring poolCategoryForPunch.
const PBI_SECTIONS: Record<PoolCategory, string[]> = {
  ENGINEERING_PM: ["10-111"],
  ENGINEERING_WARRANTY: ["70-211", "70-311", "70-312", "70-313"],
  SHOP_MANUFACTURING: ["10-413", "10-414"],
  SHOP_WARRANTY: ["70-411", "70-412"],
};

async function main() {
  // The app's OWN pool tally. Note it cannot come from fetchJobHoursRows():
  // those rows are already filtered by HOURS_IMPORT_CODES, which excludes PM and
  // both warranty phases — the very sections under test. poolHours is collected
  // before that filter, which is the whole reason it exists.
  const { poolHours } = await fetchJobHoursRowsWithIssues();
  const appJobs = await prisma.job.findMany({ select: { jobId: true } });
  const appJobIds = new Set(appJobs.map((j) => j.jobId));

  for (const category of ["ENGINEERING_PM", "ENGINEERING_WARRANTY"] as PoolCategory[]) {
    console.log(`\n\n=== ${category} ===`);
    const wanted = new Set(PBI_SECTIONS[category]);

    for (const month of MONTHS) {
      const [Y, MO] = month.split("-").map(Number);
      const dax = (await runDax(
        `EVALUATE SUMMARIZECOLUMNS('Job'[Job Id], 'Function Hierarchy'[Section-Function Code], ` +
          `FILTER(ALL('Date'), 'Date'[Year]=${Y} && 'Date'[Month]=${MO}), "H", [Hours Actual])`,
      )) as Record<string, unknown>[];

      let pbiAttributed = 0, pbiUnattributed = 0;
      for (const r of dax) {
        const s = String(r["Function Hierarchy[Section-Function Code]"] ?? "");
        if (!wanted.has(s)) continue;
        const j = r["Job[Job Id]"];
        const h = Number(r.H ?? 0);
        const key = j == null ? "" : String(Number(j));
        if (key && key !== "NaN" && appJobIds.has(key)) pbiAttributed += h;
        else pbiUnattributed += h;
      }

      const local = poolHours.get(`${month}::${category}`) ?? 0;

      const delta = round2(local - (pbiAttributed + pbiUnattributed));
      const deltaAttributedOnly = round2(local - pbiAttributed);
      console.log(
        `${month}  pbi(total)=${round2(pbiAttributed + pbiUnattributed).toFixed(2).padStart(8)} ` +
          `pbi(real jobs)=${round2(pbiAttributed).toFixed(2).padStart(8)} ` +
          `pbi(unattributed)=${round2(pbiUnattributed).toFixed(2).padStart(7)} ` +
          `local=${round2(local).toFixed(2).padStart(8)}  Δvs total=${delta.toFixed(2).padStart(8)}  Δvs real jobs=${deltaAttributedOnly.toFixed(2).padStart(7)}`,
      );
    }
  }
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
