// Faux BOM / Build Readiness dataset for LOCAL DEVELOPMENT.
//   npx tsx prisma/dev-data/build-readiness.ts [--seed 1] [--jobs 6]
//
// Fills BuildReadinessJobSnapshot (what the Build Readiness dashboard reads) with
// a mix of ready / partial / blocked jobs, vendors and POs, past-due and uncovered
// parts, upcoming deliveries, plus the "failed", "empty" and "notReleased" states.
// Job ids 9101+ and a DEV marker in every name; idempotent (upsert by jobId).
// Rules: docs/DEV-TEST-DATA.md. Refuses non-local databases.
import { PrismaClient } from "@prisma/client";
import type { AssemblyDetail, BlockerEntry, JobDetail, SnapshotVendor, UpcomingDeliveryEntry } from "../../src/lib/build-readiness-types";

let host = "";
try {
  host = new URL(process.env.DATABASE_URL ?? "").hostname;
} catch {
  /* reported below */
}
if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
  console.error(`Refusing to run: DATABASE_URL host is "${host || "(unset)"}", not localhost.`);
  process.exit(1);
}

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
};
const SEED = arg("seed", 1);
const JOBS = arg("jobs", 6);

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED * 104729);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 864e5).toISOString().slice(0, 10);

const SUPPLIERS = ["Acme DEV Fasteners", "Globex DEV Motion", "Initech DEV Electric", "Umbrella DEV Pneumatics", "Hooli DEV Sensors"];
const CUSTOMERS = ["Acme DEV Co", "Globex DEV", "Initech DEV"];
const ASSEMBLY_NAMES = ["Frame Weldment", "Conveyor Module", "Pick & Place Head", "Vision Station", "Pneumatic Manifold", "Control Cabinet", "Guarding Package", "Operator HMI"];
// "Healthy" jobs are mostly green; the spread gives every readiness band.
const PROFILES = [0.97, 0.78, 0.45, 0.2, 0.92, 0.65, 0.55];

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRaw`INSERT IGNORE INTO BuildReadinessRefreshMeta (id, status) VALUES (1, 'ok')`;
  let n = 0;

  for (let j = 0; j < JOBS; j++) {
    const jobId = String(9101 + j);
    const jobName = `DEV Build ${jobId}`;
    const customer = CUSTOMERS[j % CUSTOMERS.length];
    const base = { jobId, jobName, customer };

    // Non-"ok" states worth seeing on the dashboard.
    const special = j === JOBS - 1 ? "failed" : j === JOBS - 2 ? "empty" : j === JOBS - 3 ? "notReleased" : null;
    if (special) {
      const detail: JobDetail = { assemblies: [], vendors: [], blockers: [], upcoming: [] };
      await upsert({ ...base, status: special, pct: 0, req: special === "notReleased" ? 0 : 0, cov: 0, asm: [0, 0, 0, 0], parts: [0, 0, 0, 0], value: 0, risk: 0, next: null, detail });
      n++;
      continue;
    }

    const readiness = PROFILES[j % PROFILES.length];
    const assemblies: AssemblyDetail[] = [];
    const blockers: BlockerEntry[] = [];
    const upcoming: UpcomingDeliveryEntry[] = [];
    const vendorMap = new Map<string, { poId: string; itemCount: number; received: number }[]>();
    let reqTotal = 0, covTotal = 0, valueTotal = 0, risk = 0, uncovered = 0, onOrder = 0, pastDue = 0, dueSoon = 0;
    let ready = 0, partial = 0, blocked = 0;

    ASSEMBLY_NAMES.slice(0, int(4, 8)).forEach((label, a) => {
      const required = int(8, 60);
      const covered = Math.min(required, Math.round(required * Math.max(0, Math.min(1, readiness + (rand() - 0.5) * 0.4))));
      const missing = required - covered;
      const value = Math.round(required * (40 + rand() * 600));
      const pn = `DEV-${jobId}-A${a + 1}`;
      const supplier = pick(SUPPLIERS);
      const poId = `DEVPO-${jobId}-${a + 1}`;
      const late = missing > 0 && rand() < 0.5;
      const expected = missing > 0 ? iso(late ? -int(1, 20) : int(2, 30)) : null;

      reqTotal += required; covTotal += covered; valueTotal += value;
      if (covered === required) ready++; else if (covered === 0) blocked++; else partial++;
      if (missing > 0) {
        if (rand() < 0.3) { uncovered += missing; risk += value * (missing / required); }
        else if (late) { pastDue += missing; risk += value * (missing / required); }
        else { onOrder += missing; if (expected! <= iso(7)) dueSoon += missing; }
      }
      const vs = vendorMap.get(supplier) ?? [];
      vs.push({ poId, itemCount: required, received: covered });
      vendorMap.set(supplier, vs);

      assemblies.push({
        key: pn, pn, label, release: pick(["contentsOnly", "assemblyOnly", "bothAssemblyAndContents"] as const),
        requiredQty: required, coveredQty: covered, readinessPct: Math.round((covered / required) * 100),
        buildableQty: covered === required ? 1 : 0, buildablePct: Math.round((covered / required) * 100),
        limitingParts: missing > 0 ? [{ pn: `${pn}-P1`, available: covered, required }] : [],
        missingParts: missing, onOrderParts: late ? 0 : missing, pastDueParts: late ? missing : 0,
        materialValue: value, nextExpectedDelivery: expected, estimatedBuildableDate: expected,
      });
      if (missing > 0) {
        blockers.push({
          reason: late ? "past_due" : rand() < 0.5 ? "no_po" : "supplier_delay", jobId, jobName, assemblyKey: pn, assemblyLabel: label,
          partPn: `${pn}-P1`, partDesc: "DEV missing part", supplier, poNumber: poId, materialValue: Math.round(value * (missing / required)),
          daysLate: late ? int(1, 20) : null, expectedDate: expected,
        });
        upcoming.push({
          jobId, jobName, poNumber: poId, supplier, expectedDate: expected!, assemblyKey: pn, assemblyLabel: label,
          incomingParts: [{ pn: `${pn}-P1`, qty: missing }], buildableBefore: 0, buildableAfter: 1, onOrder: !late,
        });
      }
    });

    const vendors: SnapshotVendor[] = [...vendorMap].map(([name, pos]) => ({
      name, pos: pos.map((p) => ({ poId: p.poId, itemCount: p.itemCount, received: p.received, pct: Math.round((p.received / p.itemCount) * 100) })),
    }));
    const next = upcoming.map((u) => u.expectedDate).sort()[0] ?? null;
    await upsert({
      ...base, status: "ok", pct: Math.round((covTotal / reqTotal) * 100), req: reqTotal, cov: covTotal,
      asm: [assemblies.length, ready, partial, blocked], parts: [uncovered, onOrder, pastDue, dueSoon], value: valueTotal, risk: Math.round(risk), next,
      detail: { assemblies, vendors, blockers, upcoming },
    });
    n++;
  }

  await prisma.$executeRaw`UPDATE BuildReadinessRefreshMeta SET status = 'ok', completedAt = ${new Date()}, jobsTotal = ${JOBS}, jobsDone = ${JOBS}, jobsFailed = 1, updatedAt = ${new Date()} WHERE id = 1`;
  console.log(`Wrote ${n} Build Readiness snapshots (job ids 9101-${9100 + JOBS}), seed ${SEED}.`);
}

async function upsert(r: {
  jobId: string; jobName: string; customer: string; status: string; pct: number; req: number; cov: number;
  asm: number[]; parts: number[]; value: number; risk: number; next: string | null; detail: JobDetail;
}) {
  const data = {
    jobName: r.jobName, customer: r.customer, status: r.status, overallReadinessPct: r.pct, requiredQtyTotal: r.req, coveredQtyTotal: r.cov,
    assembliesTotal: r.asm[0], assembliesReady: r.asm[1], assembliesPartial: r.asm[2], assembliesBlocked: r.asm[3],
    partsUncovered: r.parts[0], partsOnOrder: r.parts[1], partsPastDue: r.parts[2], partsDueSoon7d: r.parts[3],
    materialValueTotal: r.value, materialValueAtRisk: r.risk, nextUnlockDate: r.next ? new Date(r.next) : null,
    detailJson: JSON.stringify(r.detail), computedAt: new Date(),
  };
  await prisma.buildReadinessJobSnapshot.upsert({ where: { jobId: r.jobId }, update: data, create: { jobId: r.jobId, ...data } });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
