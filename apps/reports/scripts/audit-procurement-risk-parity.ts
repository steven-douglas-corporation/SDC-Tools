// Parity audit: do the Delivery Slip / No Purchase Order / Upcoming Deliveries
// cards on THIS app's Job Hours Details page agree, job for job, with what
// /api/integration/jobs/:id/procurement serves to the Build Readiness app?
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-procurement-risk-parity.ts 1130 1083 1122
//
// Env: PLANNER_URL (default http://localhost:4006), SCHEDULER_SHARED_TOKEN.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Build Readiness used to compute its own version of these three cards and got
// a different answer from this app for every job. The fix was to delete that
// second implementation and have it read this app instead
// (src/lib/procurement-risk.ts, and apps/build-readiness/server/services/
// plannerClient.js for the reasoning). This script is what demonstrates the two
// now agree rather than asserting it.
//
// LEFT side  — rebuilt exactly the way `job-hours/page.tsx` builds it for a
//              single-job selection: getJobBom(job) + getJobPartsCost(job).lines
//              → flattenBomParts → computeRiskCards. That is the page's whole
//              data path; JobProcurement.tsx only lays the result out.
// RIGHT side — the live HTTP endpoint, i.e. the bytes Build Readiness receives.
//
// The two share `computeRiskCards`, so a mismatch here can only be a difference
// in what is fed to it or in how the wire format projects the result — which is
// precisely the class of bug that a shared rule does not by itself prevent, and
// so the thing worth checking.
import { getJobBom } from "@/lib/job-bom";
import { getJobPartsCost } from "@/lib/sync-totaleto";
import { flattenBomParts } from "@/lib/po-detail";
import { computeRiskCards } from "@/lib/procurement-risk";

const BASE = (process.env.PLANNER_URL || "http://localhost:4006").replace(/\/+$/, "");
const TOKEN = process.env.SCHEDULER_SHARED_TOKEN || "";

const day = (s: string | null) => (s ? s.slice(0, 10) : null);

type Row = { label: string; page: string; api: string; ok: boolean };

async function auditJob(jobId: string): Promise<{ rows: Row[]; failures: number }> {
  // ── LEFT: the page's own path ──
  const [bom, partsCost] = await Promise.all([getJobBom(jobId), getJobPartsCost(jobId)]);
  const parts = flattenBomParts(bom, partsCost.lines);
  const risk = computeRiskCards(parts, Date.now());

  // ── RIGHT: the wire ──
  const res = await fetch(`${BASE}/api/integration/jobs/${jobId}/procurement`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const wire = await res.json();

  const rows: Row[] = [];
  const cmp = (label: string, page: unknown, api: unknown) => {
    const p = String(page);
    const a = String(api);
    rows.push({ label, page: p, api: a, ok: p === a });
  };

  cmp("requirements", parts.length, wire.requirementCount);

  cmp("slip.parts", risk.delivery.length, wire.deliverySlip.partCount);
  cmp("slip.avgLate", risk.deliveryAvgLate, wire.deliverySlip.avgLateDays);
  cmp("slip.oldestReq", day(risk.deliveryOldest), wire.deliverySlip.oldestRequired);
  cmp("slip.poRows", risk.deliveryPos.length, wire.deliverySlip.pos.length);
  // Order matters as much as membership: these tables are read top-down as a
  // work queue, so "same parts, different sequence" is still a mismatch.
  cmp("slip.partIds", risk.delivery.map((p) => p.id).join(","), wire.deliverySlip.parts.map((p: { id: number }) => p.id).join(","));

  cmp("nopo.parts", risk.noPo.length, wire.noPo.partCount);
  cmp("nopo.thisWeek", risk.noPoThisWeek, wire.noPo.thisWeek);
  cmp("nopo.oldestReq", day(risk.noPoOldest), wire.noPo.oldestRequired);
  cmp("nopo.poRows", risk.noPoPos.length, wire.noPo.pos.length);
  cmp("nopo.partIds", risk.noPoSorted.map((p) => p.id).join(","), wire.noPo.parts.map((p: { id: number }) => p.id).join(","));

  cmp("upcoming.parts", risk.upcoming.length, wire.upcoming.partCount);
  cmp("upcoming.weekCounts", risk.weekData.map((w) => w.count).join(","), wire.upcoming.weeks.map((w: { count: number }) => w.count).join(","));
  cmp(
    "upcoming.partIds",
    risk.upcoming.map((p) => p.id).join(","),
    wire.upcoming.parts.map((p: { id: number }) => p.id).join(","),
  );

  return { rows, failures: rows.filter((r) => !r.ok).length };
}

async function main() {
  const jobs = process.argv.slice(2);
  if (jobs.length === 0) {
    console.error("usage: audit-procurement-risk-parity.ts <jobId> [jobId ...]");
    process.exit(2);
  }
  if (!TOKEN) {
    console.error("SCHEDULER_SHARED_TOKEN is not set — the endpoint will answer 401.");
    process.exit(2);
  }

  let totalFailures = 0;
  for (const jobId of jobs) {
    console.log(`\n── job ${jobId} ${"─".repeat(Math.max(0, 60 - jobId.length))}`);
    try {
      const { rows, failures } = await auditJob(jobId);
      for (const r of rows) {
        const mark = r.ok ? "  ok  " : " FAIL ";
        const shown = r.page.length > 70 ? `${r.page.slice(0, 67)}...` : r.page;
        console.log(`${mark} ${r.label.padEnd(20)} ${shown}${r.ok ? "" : `   != api: ${r.api.slice(0, 70)}`}`);
      }
      totalFailures += failures;
    } catch (e) {
      console.log(` ERROR ${(e as Error).message}`);
      totalFailures++;
    }
  }

  console.log(totalFailures === 0 ? "\nAll jobs match.\n" : `\n${totalFailures} mismatch(es).\n`);
  process.exit(totalFailures === 0 ? 0 : 1);
}

void main();
