import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CashFlowLine, FlowType, CashFlowCategory } from "@/lib/cash-flow-normalize";

// Raw-SQL accessed (`$queryRaw`/`$executeRaw`), same reason as
// RolePermission/HiringPositionAssignment: `prisma generate` is blocked on
// this box while a server process holds node_modules/.prisma open, so none
// of CashFlowSnapshot/CashFlowSnapshotLine/CashFlowEtcAllocation/
// CashFlowForecastOverride have a generated Client model to call.

export type SnapshotSummary = {
  id: number;
  snapshotTimestamp: Date;
  snapshotDate: Date;
  sourceRefreshTimestamp: Date;
  createdBy: string | null;
  contentHash: string;
  lineCount: number;
};

export async function getLatestSnapshot(): Promise<SnapshotSummary | null> {
  const rows = await prisma.$queryRaw<SnapshotSummary[]>`
    SELECT id, snapshotTimestamp, snapshotDate, sourceRefreshTimestamp, createdBy, contentHash, lineCount
      FROM CashFlowSnapshot ORDER BY id DESC LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listSnapshots(limit = 200): Promise<SnapshotSummary[]> {
  return prisma.$queryRaw<SnapshotSummary[]>`
    SELECT id, snapshotTimestamp, snapshotDate, sourceRefreshTimestamp, createdBy, contentHash, lineCount
      FROM CashFlowSnapshot ORDER BY snapshotTimestamp DESC LIMIT ${limit}
  `;
}

export async function getSnapshotById(id: number): Promise<SnapshotSummary | null> {
  const rows = await prisma.$queryRaw<SnapshotSummary[]>`
    SELECT id, snapshotTimestamp, snapshotDate, sourceRefreshTimestamp, createdBy, contentHash, lineCount
      FROM CashFlowSnapshot WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ?? null;
}

/** The most recent snapshot AT OR BEFORE a given calendar date — "prior month-end" and "As Of: <date>" both resolve through this one lookup. */
export async function getSnapshotAtOrBefore(date: Date): Promise<SnapshotSummary | null> {
  const rows = await prisma.$queryRaw<SnapshotSummary[]>`
    SELECT id, snapshotTimestamp, snapshotDate, sourceRefreshTimestamp, createdBy, contentHash, lineCount
      FROM CashFlowSnapshot WHERE snapshotDate <= ${date} ORDER BY snapshotDate DESC, id DESC LIMIT 1
  `;
  return rows[0] ?? null;
}

type RawLine = { projectId: string; customer: string | null; forecastMonth: string; flowType: string; category: string; amount: Prisma.Decimal | number | string };

function toLine(r: RawLine): CashFlowLine {
  return {
    projectId: r.projectId,
    customer: r.customer,
    forecastMonth: r.forecastMonth,
    flowType: r.flowType as FlowType,
    category: r.category as CashFlowCategory,
    amount: Number(r.amount),
  };
}

export async function getSnapshotLines(snapshotId: number): Promise<CashFlowLine[]> {
  const rows = await prisma.$queryRaw<RawLine[]>`
    SELECT projectId, customer, forecastMonth, flowType, category, amount
      FROM CashFlowSnapshotLine WHERE snapshotId = ${snapshotId}
  `;
  return rows.map(toLine);
}

const INSERT_CHUNK_SIZE = 500;

/**
 * Writes one immutable snapshot + all its lines inside one transaction — a
 * failure partway through can never leave a `CashFlowSnapshot` header row
 * with only some of its lines. Returns the new snapshot's id.
 */
export async function insertSnapshot(params: {
  snapshotDate: Date;
  sourceRefreshTimestamp: Date;
  createdBy: string | null;
  contentHash: string;
  lines: readonly CashFlowLine[];
}): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        INSERT INTO CashFlowSnapshot (snapshotDate, sourceRefreshTimestamp, createdBy, contentHash, lineCount)
        VALUES (${params.snapshotDate}, ${params.sourceRefreshTimestamp}, ${params.createdBy}, ${params.contentHash}, ${params.lines.length})
      `;
      const idRows = await tx.$queryRaw<{ id: bigint | number }[]>`SELECT LAST_INSERT_ID() AS id`;
      const snapshotId = Number(idRows[0].id);

      for (let i = 0; i < params.lines.length; i += INSERT_CHUNK_SIZE) {
        const chunk = params.lines.slice(i, i + INSERT_CHUNK_SIZE);
        const values = Prisma.join(
          chunk.map((l) => Prisma.sql`(${snapshotId}, ${l.projectId}, ${l.customer}, ${l.forecastMonth}, ${l.flowType}, ${l.category}, ${l.amount})`),
        );
        await tx.$executeRaw`
          INSERT INTO CashFlowSnapshotLine (snapshotId, projectId, customer, forecastMonth, flowType, category, amount)
          VALUES ${values}
        `;
      }
      return snapshotId;
    },
    { timeout: 120_000 },
  );
}

// ── PM ETC monthly allocation ────────────────────────────────────────────────

export type EtcAllocationRow = { projectId: string; forecastMonth: string; amount: number; note: string | null; updatedByEmail: string | null; updatedAt: Date };

export async function getEtcAllocations(): Promise<EtcAllocationRow[]> {
  const rows = await prisma.$queryRaw<(Omit<EtcAllocationRow, "amount"> & { amount: Prisma.Decimal | number })[]>`
    SELECT projectId, forecastMonth, amount, note, updatedByEmail, updatedAt FROM CashFlowEtcAllocation
  `;
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

export async function getEtcAllocationsForProject(projectId: string): Promise<EtcAllocationRow[]> {
  const rows = await prisma.$queryRaw<(Omit<EtcAllocationRow, "amount"> & { amount: Prisma.Decimal | number })[]>`
    SELECT projectId, forecastMonth, amount, note, updatedByEmail, updatedAt FROM CashFlowEtcAllocation WHERE projectId = ${projectId}
  `;
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

export async function setEtcAllocation(projectId: string, forecastMonth: string, amount: number, note: string | null, actorEmail: string | null): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO CashFlowEtcAllocation (projectId, forecastMonth, amount, note, updatedByEmail, updatedAt, createdAt)
    VALUES (${projectId}, ${forecastMonth}, ${amount}, ${note}, ${actorEmail}, ${new Date()}, ${new Date()})
    ON DUPLICATE KEY UPDATE amount = ${amount}, note = ${note}, updatedByEmail = ${actorEmail}, updatedAt = ${new Date()}
  `;
}

// ── PM AR forecast override ─────────────────────────────────────────────────

export type ForecastOverrideRow = { projectId: string; category: string; forecastMonth: string; amount: number; note: string | null; updatedByEmail: string | null; updatedAt: Date };

export async function getForecastOverrides(): Promise<ForecastOverrideRow[]> {
  const rows = await prisma.$queryRaw<(Omit<ForecastOverrideRow, "amount"> & { amount: Prisma.Decimal | number })[]>`
    SELECT projectId, category, forecastMonth, amount, note, updatedByEmail, updatedAt FROM CashFlowForecastOverride
  `;
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

export async function getForecastOverride(projectId: string, category: string, forecastMonth: string): Promise<ForecastOverrideRow | null> {
  const rows = await prisma.$queryRaw<(Omit<ForecastOverrideRow, "amount"> & { amount: Prisma.Decimal | number })[]>`
    SELECT projectId, category, forecastMonth, amount, note, updatedByEmail, updatedAt
      FROM CashFlowForecastOverride WHERE projectId = ${projectId} AND category = ${category} AND forecastMonth = ${forecastMonth} LIMIT 1
  `;
  return rows[0] ? { ...rows[0], amount: Number(rows[0].amount) } : null;
}

export async function setForecastOverride(
  projectId: string,
  category: string,
  forecastMonth: string,
  amount: number,
  note: string | null,
  actorEmail: string | null,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO CashFlowForecastOverride (projectId, category, forecastMonth, amount, note, updatedByEmail, updatedAt, createdAt)
    VALUES (${projectId}, ${category}, ${forecastMonth}, ${amount}, ${note}, ${actorEmail}, ${new Date()}, ${new Date()})
    ON DUPLICATE KEY UPDATE amount = ${amount}, note = ${note}, updatedByEmail = ${actorEmail}, updatedAt = ${new Date()}
  `;
}
