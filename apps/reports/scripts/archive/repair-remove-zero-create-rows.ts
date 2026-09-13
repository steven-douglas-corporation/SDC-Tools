// Removes the empty EtcEntry rows created by the 2026-08-03 Submit bug.
//
// When every section became editable, the not-yet-created cells rendered a
// literal "0" instead of an empty box (EtcSectionCells auto-filled the
// carry-forward, and their Prior ETC is 0). Submit therefore posted
// newEtcCreate__…=0 for every unquoted section and materialised them all — 311
// rows in 2026-06 and 386 in 2026-07 — in a transaction that then timed out. The
// creates commit separately from the submit, so they survived the failure.
//
// Deletes ONLY rows that are unmistakably from that path:
//   • unsubmitted (needsReview) — confirmed history is never touched
//   • every figure zero, including an explicit newEtcDraft of 0
//   • and the job has NO quoted hours for that section, i.e. seedMonth would
//     never have created it
//
// dry run:  npx tsx scripts/repair-remove-zero-create-rows.ts 2026-06 2026-07
// for real: ... --write
import "dotenv/config";
import { prisma } from "@/lib/prisma";

async function main() {
  const write = process.argv.includes("--write");
  const months = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}$/.test(a));
  if (!months.length) throw new Error("Pass one or more months, e.g. 2026-06 2026-07");
  console.log(write ? "MODE: WRITING\n" : "MODE: dry run (pass --write to commit)\n");

  for (const month of months) {
    const candidates = await prisma.etcEntry.findMany({
      where: {
        month,
        needsReview: true,
        priorEtc: 0,
        hoursWorked: 0,
        hoursLeftCalc: 0,
        newEtc: 0,
        newEtcDraft: 0,
        section: { not: "PARTS_COST" },
      },
      select: { id: true, jobId: true, section: true },
    });
    // Keep any section the job WAS quoted for — seedMonth owns those rows.
    const quoted = await prisma.estimatedHours.findMany({
      where: { jobId: { in: [...new Set(candidates.map((c) => c.jobId))] } },
      select: { jobId: true, section: true },
    });
    const quotedKeys = new Set(quoted.map((q) => `${q.jobId}::${q.section}`));
    const doomed = candidates.filter((c) => !quotedKeys.has(`${c.jobId}::${c.section}`));

    const total = await prisma.etcEntry.count({ where: { month } });
    console.log(`${month}: ${total} entries; ${candidates.length} all-zero, of which ${doomed.length} were never quoted -> delete`);
    console.log(`   keeping ${candidates.length - doomed.length} all-zero rows that ARE quoted sections`);
    if (!write || doomed.length === 0) continue;
    const r = await prisma.etcEntry.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
    console.log(`   deleted ${r.count}; ${await prisma.etcEntry.count({ where: { month } })} entries remain`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
