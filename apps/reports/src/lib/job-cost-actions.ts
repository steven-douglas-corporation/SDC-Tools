"use server";

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { recordChanges } from "@/lib/change-log";
import { revalidatePath } from "next/cache";
import { DEFAULT_RATES, type CostRates, type HourAllocationEntry, type JobHourAllocation, type YearRateOverrides } from "@/lib/job-cost";
import { assertActionPermission } from "@/lib/require-permission";

// ── Shared Rate Matrix / Hour Allocation storage ────────────────────────────
//
// Replaces the standalone app's localStorage-only rates/allocations (per the
// integration decision) with the three tables added in migration
// 20260807140445_add_job_cost_explorer_tables
// (JobCostDefaultRate/JobCostYearRate/JobCostHourAllocation).
//
// ── Raw SQL, not prisma.jobCostDefaultRate etc. — and why ────────────────────
// Same reason MonthlyReportSubmission/RefreshRun/DepartmentEtcCompletion use raw
// SQL (see their comments in schema.prisma): `prisma generate` cannot run while
// a live server process holds node_modules/.prisma open, and this box runs this
// app's own production instance on port 4006 — so regenerating the typed client
// would mean an unplanned prod interruption just to add three tables. The
// migration SQL itself applies fine (`prisma migrate dev --skip-generate`, which
// only touches the database, not node_modules); these three tables are simply
// usable before the generated client catches up. Swap these for
// `prisma.jobCostDefaultRate`/etc. calls the next time a real deploy window
// restarts the server and `prisma generate` can run cleanly — nothing about the
// schema or the data changes, only which API reads it.
//
// Every write calls recordChanges() with no cellKey — the same "something
// changed, do a throttled refetch" broadcast the refresh pipeline uses (see
// docs/REFRESH-PIPELINE.md) — so another open tab picks up a rate change
// without a full reload, without this needing its own cell-addressable
// realtime patching.

// User-facing tab name shown in change notifications (ChangeNotifications.tsx)
// and the audit log — kept in sync with the Sidebar label and PageTitle even
// though the underlying route/component are still job-cost-explorer/JobCostExplorer.
const TAB = "Profitability";

async function actorId(): Promise<number | null> {
  const session = await auth();
  const user = session?.user as { id?: string } | undefined;
  return user?.id ? Number(user.id) : null;
}

function toNullableNumber(v: FormDataEntryValue | null): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

type DefaultRateRow = { engRate: string; shopRate: string; pmPct: string; mfgPct: string };
type YearRateRow = { year: string; engRate: string | null; shopRate: string | null; pmPct: string | null; mfgPct: string | null };
type HourAllocationRow = { jobId: string; type: string; year: string; hours: string };

export async function loadCostRates(): Promise<{ defaults: CostRates; overrides: YearRateOverrides }> {
  const [rows, years] = await Promise.all([
    prisma.$queryRaw<DefaultRateRow[]>`SELECT engRate, shopRate, pmPct, mfgPct FROM JobCostDefaultRate WHERE id = 1`,
    prisma.$queryRaw<YearRateRow[]>`SELECT year, engRate, shopRate, pmPct, mfgPct FROM JobCostYearRate`,
  ]);
  const defaults: CostRates = rows[0]
    ? { engRate: Number(rows[0].engRate), shopRate: Number(rows[0].shopRate), pmPct: Number(rows[0].pmPct), mfgPct: Number(rows[0].mfgPct) }
    : DEFAULT_RATES;
  const overrides: YearRateOverrides = {};
  for (const y of years) {
    overrides[y.year] = {
      engRate: y.engRate != null ? Number(y.engRate) : undefined,
      shopRate: y.shopRate != null ? Number(y.shopRate) : undefined,
      pmPct: y.pmPct != null ? Number(y.pmPct) : undefined,
      mfgPct: y.mfgPct != null ? Number(y.mfgPct) : undefined,
    };
  }
  return { defaults, overrides };
}

export async function saveDefaultRate(formData: FormData): Promise<void> {
  await assertActionPermission("profitability:view");
  const engRate = toNullableNumber(formData.get("engRate")) ?? DEFAULT_RATES.engRate;
  const shopRate = toNullableNumber(formData.get("shopRate")) ?? DEFAULT_RATES.shopRate;
  const pmPct = toNullableNumber(formData.get("pmPct")) ?? DEFAULT_RATES.pmPct;
  const mfgPct = toNullableNumber(formData.get("mfgPct")) ?? DEFAULT_RATES.mfgPct;
  const updatedById = await actorId();

  await prisma.$executeRaw`
    INSERT INTO JobCostDefaultRate (id, engRate, shopRate, pmPct, mfgPct, updatedAt, updatedById)
    VALUES (1, ${engRate}, ${shopRate}, ${pmPct}, ${mfgPct}, ${new Date()}, ${updatedById})
    ON DUPLICATE KEY UPDATE engRate=${engRate}, shopRate=${shopRate}, pmPct=${pmPct}, mfgPct=${mfgPct}, updatedAt=${new Date()}, updatedById=${updatedById}`;

  await recordChanges([
    { tab: TAB, rowRef: "Default rates", columnName: "Rate Matrix", previousValue: null, newValue: `Eng $${engRate}/hr, Shop $${shopRate}/hr, PM ${pmPct}%, Mfg ${mfgPct}%`, changeType: "edited" },
  ]);
  revalidatePath("/job-cost-explorer");
}

export async function saveYearRateOverride(formData: FormData): Promise<void> {
  await assertActionPermission("profitability:view");
  const year = String(formData.get("year") ?? "").trim();
  if (!/^\d{4}$/.test(year)) return;
  const engRate = toNullableNumber(formData.get("engRate"));
  const shopRate = toNullableNumber(formData.get("shopRate"));
  const pmPct = toNullableNumber(formData.get("pmPct"));
  const mfgPct = toNullableNumber(formData.get("mfgPct"));
  const updatedById = await actorId();

  // A year with every field blank has no override left — delete it rather
  // than storing an all-null row, matching the original's "blank matrix cell
  // means no entry" behavior exactly.
  if (engRate == null && shopRate == null && pmPct == null && mfgPct == null) {
    await prisma.$executeRaw`DELETE FROM JobCostYearRate WHERE year = ${year}`;
  } else {
    await prisma.$executeRaw`
      INSERT INTO JobCostYearRate (year, engRate, shopRate, pmPct, mfgPct, updatedAt, updatedById)
      VALUES (${year}, ${engRate}, ${shopRate}, ${pmPct}, ${mfgPct}, ${new Date()}, ${updatedById})
      ON DUPLICATE KEY UPDATE engRate=${engRate}, shopRate=${shopRate}, pmPct=${pmPct}, mfgPct=${mfgPct}, updatedAt=${new Date()}, updatedById=${updatedById}`;
  }

  await recordChanges([
    { tab: TAB, rowRef: `Year ${year}`, columnName: "Rate Matrix", previousValue: null, newValue: `Eng ${engRate ?? "default"}, Shop ${shopRate ?? "default"}, PM ${pmPct ?? "default"}%, Mfg ${mfgPct ?? "default"}%`, changeType: "edited" },
  ]);
  revalidatePath("/job-cost-explorer");
}

export async function clearAllYearRateOverrides(): Promise<void> {
  await assertActionPermission("profitability:view");
  await prisma.$executeRaw`DELETE FROM JobCostYearRate`;
  await recordChanges([
    { tab: TAB, rowRef: "All years", columnName: "Rate Matrix", previousValue: null, newValue: "cleared", changeType: "removed" },
  ]);
  revalidatePath("/job-cost-explorer");
}

export async function loadHourAllocations(): Promise<Map<string, JobHourAllocation>> {
  const rows = await prisma.$queryRaw<HourAllocationRow[]>`SELECT jobId, type, year, hours FROM JobCostHourAllocation ORDER BY year DESC`;
  const map = new Map<string, JobHourAllocation>();
  for (const r of rows) {
    let alloc = map.get(r.jobId);
    if (!alloc) map.set(r.jobId, (alloc = { eng: [], shop: [] }));
    const entry: HourAllocationEntry = { hours: Number(r.hours), year: r.year };
    if (r.type === "eng") alloc.eng.push(entry);
    else if (r.type === "shop") alloc.shop.push(entry);
  }
  return map;
}

/** Replaces a job's whole allocation (both eng and shop) in one transaction. */
export async function saveJobHourAllocation(jobId: string, eng: HourAllocationEntry[], shop: HourAllocationEntry[]): Promise<void> {
  await assertActionPermission("profitability:view");
  const updatedById = await actorId();
  const rows = [
    ...eng.filter((r) => r.hours > 0 && r.year).map((r) => ({ ...r, type: "eng" as const })),
    ...shop.filter((r) => r.hours > 0 && r.year).map((r) => ({ ...r, type: "shop" as const })),
  ];

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM JobCostHourAllocation WHERE jobId = ${jobId}`;
    for (const r of rows) {
      await tx.$executeRaw`
        INSERT INTO JobCostHourAllocation (jobId, type, year, hours, updatedAt, updatedById)
        VALUES (${jobId}, ${r.type}, ${r.year}, ${r.hours}, ${new Date()}, ${updatedById})`;
    }
  });

  await recordChanges([
    { tab: TAB, rowRef: `Job ${jobId}`, columnName: "Hour Allocation", previousValue: null, newValue: rows.length ? `${rows.length} row(s)` : "cleared", changeType: rows.length ? "edited" : "removed" },
  ]);
  revalidatePath("/job-cost-explorer");
}

export async function clearJobHourAllocation(jobId: string): Promise<void> {
  await assertActionPermission("profitability:view");
  await prisma.$executeRaw`DELETE FROM JobCostHourAllocation WHERE jobId = ${jobId}`;
  await recordChanges([
    { tab: TAB, rowRef: `Job ${jobId}`, columnName: "Hour Allocation", previousValue: null, newValue: "cleared", changeType: "removed" },
  ]);
  revalidatePath("/job-cost-explorer");
}
