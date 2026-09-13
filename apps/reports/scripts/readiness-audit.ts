import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { writeFileSync } from "node:fs";

// ── Readiness audit — reconciliation table for every active project ─────────
// Permanent, re-runnable tool (same convention as parts-cost-projection-
// audit.ts): `npx tsx -r ./scripts/shim-server-only.cjs scripts/readiness-audit.ts`
//
// Reads the PERSISTED requiredQtyTotal/coveredQtyTotal/overallReadinessPct
// columns directly (job-bom-rules.ts's quantityReadiness, computed once at
// sync time in build-readiness-sync.ts's classifyJobBom) rather than
// re-deriving them from detailJson's per-assembly array — summing
// AssemblyDetail.requiredQty across `assemblies[]` would double-count a
// sub-assembly reused at more than one BOM position, reintroducing the exact
// bug this audit exists to catch.
//
// LIMITED_SCOPE_THRESHOLD is kept in sync with ReadinessPill.tsx's own
// constant of the same name by hand (no shared runtime import — this script
// has no "use client" boundary to cross, but duplicating the literal here
// would silently drift, so if you change one, change both).
const LIMITED_SCOPE_THRESHOLD = 10;

type AssemblyDetail = { missingParts: number; buildableQty: number | null };

async function main() {
  const jobs = await prisma.job.findMany({
    select: { jobId: true, jobName: true, status: true, completeDate: true, startDate: true },
  });
  const jobById = new Map(jobs.map((j) => [j.jobId, j]));

  const snaps = await prisma.$queryRaw<
    { jobId: string; status: string; overallReadinessPct: number; requiredQtyTotal: number; coveredQtyTotal: number; assembliesTotal: number; detailJson: string }[]
  >`
    SELECT jobId, status, overallReadinessPct, requiredQtyTotal, coveredQtyTotal, assembliesTotal, detailJson
    FROM BuildReadinessJobSnapshot ORDER BY jobId
  `;

  const lines: string[] = [];
  lines.push("Job\tStatus\tReleased Assemblies\tRequired Parts\tCovered Parts\tMissing Parts\tBuildable Qty\tReadiness %\tValidation Flag");

  let flaggedCount = 0;
  for (const s of snaps) {
    const job = jobById.get(s.jobId);

    let missingParts = 0;
    let buildableQty = 0;
    if (s.status === "ok") {
      try {
        const assemblies = (JSON.parse(s.detailJson).assemblies as AssemblyDetail[]) ?? [];
        missingParts = assemblies.reduce((sum, a) => sum + (a.missingParts || 0), 0);
        buildableQty = assemblies.reduce((sum, a) => sum + (a.buildableQty ?? 0), 0);
      } catch {
        // leave at 0 — a corrupt/unparseable detailJson is its own separate concern
      }
    }

    const looksComplete = (job?.completeDate && job.completeDate.getTime() < Date.now()) || /complete|closed|shipped/i.test(job?.status ?? "");
    const looksNew = job?.startDate ? Date.now() - job.startDate.getTime() < 30 * 86_400_000 : false;

    const flags: string[] = [];
    if (looksComplete && s.overallReadinessPct < 100) flags.push("COMPLETE_PROJECT_BELOW_100");
    // Defensive only — quantityReadiness returns pct:0 whenever requiredQty
    // is 0, and classifyJobBom sets status "notReleased" in that case, so
    // this combination should be structurally impossible post-fix.
    if (s.requiredQtyTotal === 0 && s.overallReadinessPct === 100) flags.push("NOT_RELEASED_AT_100");
    if (looksNew && s.overallReadinessPct === 100) flags.push("NEW_PROJECT_AT_100");
    if (s.overallReadinessPct === 100 && s.requiredQtyTotal > 0 && s.requiredQtyTotal < LIMITED_SCOPE_THRESHOLD) flags.push("LIMITED_SCOPE_AT_100");

    if (flags.length) flaggedCount++;

    lines.push(
      [s.jobId, s.status, s.assembliesTotal, s.requiredQtyTotal, s.coveredQtyTotal, missingParts, buildableQty, s.overallReadinessPct, flags.join(";") || "-"].join("\t"),
    );
  }

  const out = lines.join("\n");
  writeFileSync("scripts/readiness-audit-output.tsv", out, "utf8");
  console.log(out);
  console.log(`\n${flaggedCount} of ${snaps.length} jobs raised at least one validation flag.`);
  console.log(
    `\nNote: "Released Assemblies" (assembliesTotal) counts only TotalETO release-status-tagged\n` +
      `buildable units and will legitimately be 0 alongside a real, nonzero Readiness % for a\n` +
      `flat-parts-list job — that combination is NOT flagged here; it's the normal case for most\n` +
      `of this fleet (see build-readiness-types.ts's own comment on JobSnapshotRow).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
