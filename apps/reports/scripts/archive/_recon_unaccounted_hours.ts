// Full census of every punch hour in the export, and where it ends up.
//
// The old warning lumped ~6,800h together as "NOT counted in any figure". Some
// of that is now counted — the four Standard Fees pools pick up PM and both
// warranty phases. This separates the three fates so what is genuinely
// unaccounted can be seen and decided on, rather than estimated from a log line.
//
// Run: npx tsx scripts/_recon_unaccounted_hours.ts
import "dotenv/config";
import * as XLSX from "xlsx";
import fs from "fs/promises";
import { ETC_TRACKED_CODES, HOURS_IMPORT_CODES, poolCategoryForPunch } from "@/lib/sections";

// Same aliases sharepoint-hours.ts applies, kept in step by hand — this script
// deliberately re-reads the raw workbook rather than calling the app helper,
// so it can see punches the helper filters out before returning.
const SECTION_ALIASES: Record<string, string> = {
  "10-414": "10-413",
  "40-311": "40-211", "40-312": "40-211", "40-313": "40-211",
  "50-311": "50-211", "50-312": "50-211", "50-313": "50-211",
  "40-412": "40-411", "50-412": "50-411",
};

async function main() {
  const localPath = process.env.JOB_HOURS_LOCAL_PATH;
  if (!localPath) throw new Error("JOB_HOURS_LOCAL_PATH is not set");
  const wb = XLSX.read(await fs.readFile(localPath), { type: "buffer" });
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: null });

  const fates = { grid: 0, pool: 0, nowhere: 0, nonJob: 0, fn417: 0, noDate: 0 };
  const nowhereByCode = new Map<string, number>();
  const nonJobByLabel = new Map<string, number>();

  for (const r of raw) {
    const hours = Number(r["Total Hours Worked"]) || 0;
    if (!Number.isFinite(Number(r["Work Date"]))) { fates.noDate += hours; continue; }
    const fn = String(r["Function"] ?? "").trim();
    if (fn === "417") { fates.fn417 += hours; continue; }
    const machineSec = String(r["MachineSec"] ?? "").trim();
    const rawJob = r["Jobs"];
    if (rawJob == null || String(rawJob).trim() === "") continue;

    const jobText = String(rawJob).trim();
    if (!Number.isFinite(Number(jobText))) {
      fates.nonJob += hours;
      nonJobByLabel.set(jobText, (nonJobByLabel.get(jobText) ?? 0) + hours);
      continue;
    }

    const rawSection = `${machineSec}-${fn}`;
    const section = SECTION_ALIASES[rawSection] ?? rawSection;

    // The pool tally runs off the RAW phase/function, before aliasing.
    if (poolCategoryForPunch(machineSec, fn)) { fates.pool += hours; continue; }
    // 10-311 splits into two tracked codes.
    if (section === "10-311" || HOURS_IMPORT_CODES.has(section) || ETC_TRACKED_CODES.has(section)) {
      fates.grid += hours;
      continue;
    }
    fates.nowhere += hours;
    nowhereByCode.set(rawSection, (nowhereByCode.get(rawSection) ?? 0) + hours);
  }

  const total = Object.values(fates).reduce((a, b) => a + b, 0);
  console.log("\n=== Where every punch hour ends up ===");
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  console.log(`  ETC grid columns / job rollups : ${fates.grid.toFixed(2).padStart(10)}  ${pct(fates.grid)}`);
  console.log(`  Standard Fees pools            : ${fates.pool.toFixed(2).padStart(10)}  ${pct(fates.pool)}`);
  console.log(`  Function 417 (PBI drops it too): ${fates.fn417.toFixed(2).padStart(10)}  ${pct(fates.fn417)}`);
  console.log(`  Booked to a non-job label      : ${fates.nonJob.toFixed(2).padStart(10)}  ${pct(fates.nonJob)}`);
  console.log(`  No usable work date            : ${fates.noDate.toFixed(2).padStart(10)}  ${pct(fates.noDate)}`);
  console.log(`  REACHES NOTHING                : ${fates.nowhere.toFixed(2).padStart(10)}  ${pct(fates.nowhere)}`);
  console.log(`  ${"".padEnd(31)}  ${"-".repeat(10)}`);
  console.log(`  total                          : ${total.toFixed(2).padStart(10)}`);

  console.log(`\n=== The "reaches nothing" bucket, by raw code (${nowhereByCode.size} codes) ===`);
  for (const [code, h] of [...nowhereByCode.entries()].sort((a, b) => b[1] - a[1])) {
    const [ms, fn] = code.split("-");
    const note =
      ms === "80" || ms === "90" ? "phase the app does not model"
      : fn === "400" ? "shop function with no ETC column"
      : !/^\d+$/.test(ms) || Number(ms) < 10 ? "odd MachineSec"
      : "";
    console.log(`  ${code.padEnd(10)} ${h.toFixed(2).padStart(10)}   ${note}`);
  }

  console.log(`\n=== Non-job labels (${nonJobByLabel.size}) ===`);
  for (const [label, h] of [...nonJobByLabel.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${label.padEnd(24)} ${h.toFixed(2).padStart(10)}`);
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exitCode = 1; });
