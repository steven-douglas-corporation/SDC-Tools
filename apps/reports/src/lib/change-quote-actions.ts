"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { hasPermission, type AppRole } from "@/lib/permissions";
import { recordChanges, classifyChange, type CellChange } from "@/lib/change-log";
import { SECTIONS, restrictedSectionPermission } from "@/lib/sections";
import { sectionName } from "@/lib/off-grid-hours";
import { assertProjectsEditable } from "@/lib/projects-edit-mode";
import {
  cleanDraft,
  planApply,
  planReverse,
  planColumnAmount,
  type CqInput,
  type CqStatus,
  type PlanResult,
} from "@/lib/change-quotes";

// ── Change quotes on the Projects tab ───────────────────────────────────────
//
// See lib/change-quotes.ts for the model. In short: the grid's totals
// (EstimatedHours.quotedHours, Job.costQuoted) stay the totals; a change quote
// records what it contributed, and applying one adds it to the totals in ONE
// transaction. Every write here goes through assertProjectsEditable (Edit Mode +
// projects:edit) FIRST, exactly like saveQuotedHours — the panel being read-only
// in the browser is a convenience, this is the control.

export type ChangeQuoteView = {
  id: number;
  label: string;
  note: string | null;
  quoteDate: string | null;
  /** Cents. null when never entered, or when the viewer lacks projects:pricing. */
  amountCents: number | null;
  partsCents: number;
  status: CqStatus;
  addedToTotals: boolean;
  appliedAt: string | null;
  appliedByEmail: string | null;
  hours: Record<string, number>;
};

export type ChangeQuotePanelData = {
  job: { pk: number; jobId: string; jobName: string; status: string };
  /** Whether this viewer may see/enter dollar amounts (projects:pricing). */
  canSeePricing: boolean;
  /** The sections this viewer may see — restricted pools are left out entirely. */
  sections: { code: string; name: string; phase: string }[];
  /** The grid's current totals, by section. */
  totals: Record<string, number>;
  /** The grid's Parts Cost Quoted, in cents; null if never entered. */
  partsTotalCents: number | null;
  /** The grid's hand-typed Change Quote column, cents — only for viewers with projects:pricing. */
  gridChangeQuoteCents: number | null;
  quotes: ChangeQuoteView[];
};

export type ChangeQuoteResult =
  | { ok: true; data: ChangeQuotePanelData; message?: string }
  | { ok: false; error: string };

export type JobOption = { pk: number; jobId: string; jobName: string; status: string; changeQuoteCount: number };

// ── helpers ─────────────────────────────────────────────────────────────────

async function sessionRole(): Promise<AppRole | undefined> {
  const session = await auth();
  if (!session?.user) throw new Error("You need to be signed in to use change quotes.");
  return session.user.role as AppRole;
}

function allowedSections(role: AppRole | undefined) {
  return SECTIONS.filter((s) => {
    const permission = restrictedSectionPermission(s.code);
    return permission === null || hasPermission(role, permission);
  });
}

const toCents = (d: Prisma.Decimal | number | null | undefined): number | null => (d === null || d === undefined ? null : Math.round(Number(d) * 100));
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
// Hours are stored to 2dp; round after arithmetic so 40.33 + 70 can't land as 110.33000000000001.
const round2 = (n: number) => Math.round(n * 100) / 100;

async function buildPanel(jobPk: number, role: AppRole | undefined): Promise<ChangeQuotePanelData> {
  const canSeePricing = hasPermission(role, "projects:pricing");
  const sections = allowedSections(role);
  const allowed = new Set(sections.map((s) => s.code));
  const job = await prisma.job.findUnique({
    where: { id: jobPk },
    select: {
      id: true,
      jobId: true,
      jobName: true,
      status: true,
      costQuoted: true,
      changeQuote: true,
      estimatedHours: { select: { section: true, quotedHours: true } },
      changeQuotes: { include: { hours: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });
  if (!job) throw new Error("That job no longer exists.");
  const totals: Record<string, number> = {};
  for (const e of job.estimatedHours) if (allowed.has(e.section)) totals[e.section] = Number(e.quotedHours);
  return {
    job: { pk: job.id, jobId: job.jobId, jobName: job.jobName, status: job.status },
    canSeePricing,
    sections: sections.map((s) => ({ code: s.code, name: s.name, phase: s.phase })),
    totals,
    partsTotalCents: toCents(job.costQuoted),
    gridChangeQuoteCents: canSeePricing ? toCents(job.changeQuote) : null,
    quotes: job.changeQuotes.map((q) => ({
      id: q.id,
      label: q.label,
      note: q.note,
      quoteDate: iso(q.quoteDate),
      amountCents: canSeePricing ? toCents(q.amount) : null,
      partsCents: toCents(q.partsCost) ?? 0,
      status: q.status === "Applied" ? "Applied" : "Draft",
      addedToTotals: q.addedToTotals,
      appliedAt: q.appliedAt ? q.appliedAt.toISOString() : null,
      appliedByEmail: q.appliedByEmail,
      hours: Object.fromEntries(q.hours.filter((h) => allowed.has(h.section)).map((h) => [h.section, h.hours])),
    })),
  };
}

// Returns the panel data on success so the client never has to guess the new state.
// Errors are RETURNED (these messages are written for a manager to read) — the same
// reason saveQuotedHours returns them: a throw would replace the page with an error
// boundary and lose whatever else was on screen.
async function run(jobPk: number, role: AppRole | undefined, work: () => Promise<string | undefined>): Promise<ChangeQuoteResult> {
  try {
    const message = await work();
    return { ok: true, data: await buildPanel(jobPk, role), message };
  } catch (err) {
    if (!(err instanceof ExpectedError)) console.error("[change-quote-actions] failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : "That didn't save." };
  }
}

// Thrown for conditions a manager can fix; anything else is logged as unexpected.
class ExpectedError extends Error {}
const fail = (msg: string): never => {
  throw new ExpectedError(msg);
};

function toCqInput(q: { status: string; addedToTotals: boolean; partsCost: Prisma.Decimal; hours: { section: string; hours: number }[] }): CqInput {
  return {
    hours: Object.fromEntries(q.hours.map((h) => [h.section, h.hours])),
    partsCents: toCents(q.partsCost) ?? 0,
    status: q.status === "Applied" ? "Applied" : "Draft",
    addedToTotals: q.addedToTotals,
  };
}

// ── reads ───────────────────────────────────────────────────────────────────

/** Jobs for the panel's picker. Same visibility as the grid itself (projects:view). */
export async function listChangeQuoteJobs(): Promise<JobOption[]> {
  const role = await sessionRole();
  if (!hasPermission(role, "projects:view")) return [];
  const jobs = await prisma.job.findMany({
    select: { id: true, jobId: true, jobName: true, status: true, _count: { select: { changeQuotes: true } } },
  });
  return jobs
    .map((j) => ({ pk: j.id, jobId: j.jobId, jobName: j.jobName, status: j.status, changeQuoteCount: j._count.changeQuotes }))
    .sort((a, b) => a.jobId.localeCompare(b.jobId, undefined, { numeric: true }));
}

export async function loadChangeQuotes(jobPk: number): Promise<ChangeQuoteResult> {
  try {
    const role = await sessionRole();
    if (!hasPermission(role, "projects:view")) return { ok: false, error: "You don't have permission to view Projects." };
    return { ok: true, data: await buildPanel(jobPk, role) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't load change quotes." };
  }
}

// ── create / edit a Draft ───────────────────────────────────────────────────

export type SaveChangeQuoteInput = {
  jobPk: number;
  /** Omit to create. Only a Draft can be edited — reverse an Applied one first. */
  id?: number;
  label: string;
  note: string;
  amount: string;
  partsCost: string;
  quoteDate: string;
  hours: Record<string, string>;
};

export async function saveChangeQuote(input: SaveChangeQuoteInput): Promise<ChangeQuoteResult> {
  let role: AppRole | undefined;
  try {
    await assertProjectsEditable();
    role = await sessionRole();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not allowed." };
  }
  return run(input.jobPk, role, async () => {
    const canSeePricing = hasPermission(role, "projects:pricing");
    const allowed = new Set(allowedSections(role).map((s) => s.code));
    const cleaned = cleanDraft(input, allowed);
    if (!cleaned.ok) return fail(cleaned.error);
    const v = cleaned.value;
    const email = (await auth())?.user?.email ?? null;
    const hourRows = Object.entries(v.hours).map(([section, hours]) => ({ section, hours }));

    try {
      if (input.id === undefined) {
        const created = await prisma.jobChangeQuote.create({
          data: {
            jobId: input.jobPk,
            label: v.label,
            note: v.note,
            quoteDate: v.quoteDate ? new Date(`${v.quoteDate}T00:00:00Z`) : null,
            // Without projects:pricing the amount field isn't shown, so nothing arrives; ignore it regardless.
            amount: canSeePricing && v.amountCents !== null ? v.amountCents / 100 : null,
            partsCost: v.partsCents / 100,
            createdByEmail: email,
            hours: { create: hourRows },
          },
        });
        await logAudit({ action: "changeQuote.create", entityType: "JobChangeQuote", entityId: created.id, summary: `Created change quote ${v.label} on job ${input.jobPk}` });
        return `${v.label} saved as a draft.`;
      }

      const existing = await prisma.jobChangeQuote.findFirst({ where: { id: input.id, jobId: input.jobPk } });
      if (!existing) return fail("That change quote no longer exists.");
      if (existing.status !== "Draft") return fail("This change quote is applied. Reverse it first to edit it.");
      await prisma.$transaction(async (tx) => {
        // Claim by status inside the transaction so an apply that lands between the
        // read above and this write can't be edited underneath.
        const claimed = await tx.jobChangeQuote.updateMany({
          where: { id: input.id, status: "Draft" },
          data: {
            label: v.label,
            note: v.note,
            quoteDate: v.quoteDate ? new Date(`${v.quoteDate}T00:00:00Z`) : null,
            // Keep the stored amount when the viewer can't see it, rather than blanking it.
            ...(canSeePricing ? { amount: v.amountCents !== null ? v.amountCents / 100 : null } : {}),
            partsCost: v.partsCents / 100,
          },
        });
        if (claimed.count !== 1) return fail("This change quote was applied by someone else while you were editing. Reload to see it.");
        await tx.jobChangeQuoteHours.deleteMany({ where: { changeQuoteId: input.id } });
        if (hourRows.length > 0) await tx.jobChangeQuoteHours.createMany({ data: hourRows.map((h) => ({ ...h, changeQuoteId: input.id! })) });
      });
      await logAudit({ action: "changeQuote.update", entityType: "JobChangeQuote", entityId: input.id, summary: `Updated change quote ${v.label} on job ${input.jobPk}` });
      return `${v.label} saved.`;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return fail(`This job already has a change quote labelled "${v.label}".`);
      throw err;
    }
  });
}

// ── apply / reverse ─────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

async function readTotals(tx: Tx, jobPk: number, allowed: ReadonlySet<string>) {
  const job = await tx.job.findUnique({ where: { id: jobPk }, select: { jobId: true, costQuoted: true, changeQuote: true, estimatedHours: { select: { section: true, quotedHours: true } } } });
  if (!job) return fail("That job no longer exists.");
  const hours: Record<string, number> = {};
  for (const e of job!.estimatedHours) hours[e.section] = Number(e.quotedHours);
  return { jobNumber: job!.jobId, totals: { hours, partsCents: toCents(job!.costQuoted) }, columnCents: toCents(job!.changeQuote), allowed };
}

// Writes a plan's totals and returns the cell changes to announce. Sections are
// upserted with quotedHoursManuallyEdited so the Power BI sync can't overwrite them —
// the same protection a hand-typed grid cell gets.
async function writePlan(tx: Tx, jobPk: number, jobNumber: string, before: { hours: Record<string, number>; partsCents: number | null }, plan: Extract<PlanResult, { ok: true }>): Promise<CellChange[]> {
  const changes: CellChange[] = [];
  for (const section of plan.changedSections) {
    const prev = before.hours[section] ?? 0;
    const next = round2(plan.hours[section] ?? 0);
    await tx.estimatedHours.upsert({
      where: { jobId_section: { jobId: jobPk, section } },
      update: { quotedHours: next, quotedHoursManuallyEdited: true },
      create: { jobId: jobPk, section, quotedHours: next, actualHistoricalHours: 0, estimateToCompleteHours: 0, quotedHoursManuallyEdited: true },
    });
    const previous = String(Math.round(prev));
    const now = String(Math.round(next));
    changes.push({
      tab: "Projects",
      rowRef: `Job ${jobNumber}`,
      columnName: `${sectionName(section) ?? section} Quoted Hours`,
      previousValue: previous,
      newValue: now,
      changeType: classifyChange(previous, now, { emptyIsBlank: true }),
      entityType: "EstimatedHours",
      entityId: `${jobPk}::${section}`,
      cellKey: `quoted__${jobPk}__${section}`,
    });
  }
  if (plan.partsChanged && plan.partsCents !== null) {
    await tx.job.update({ where: { id: jobPk }, data: { costQuoted: plan.partsCents / 100, costQuotedManuallyEdited: true } });
    const previous = before.partsCents === null ? null : String(before.partsCents / 100);
    const now = String(plan.partsCents / 100);
    changes.push({
      tab: "Projects",
      rowRef: `Job ${jobNumber}`,
      columnName: "Parts Cost Quoted",
      previousValue: previous,
      newValue: now,
      changeType: classifyChange(previous, now),
      entityType: "Job",
      entityId: jobPk,
      cellKey: `jobField__${jobPk}__costQuoted`,
    });
  }
  return changes;
}

// The Change Quote $ column (see planColumnAmount). Pricing data, so a viewer without
// projects:pricing can't move it — refused rather than silently skipped, because skipping
// would leave Profitability short by this change quote's amount with no sign why.
async function writeColumn(tx: Tx, role: AppRole | undefined, jobPk: number, jobNumber: string, columnBefore: number | null, amount: Prisma.Decimal | null, op: "apply" | "reverse", addedToTotals: boolean): Promise<CellChange[]> {
  const plan = planColumnAmount(columnBefore, toCents(amount), op, addedToTotals);
  if (!plan.ok) return fail(plan.error);
  if (!plan.changed) return [];
  if (!hasPermission(role, "projects:pricing")) return fail("This change quote has a dollar amount, and updating the Change Quote column needs the Projects pricing permission.");
  await tx.job.update({ where: { id: jobPk }, data: { changeQuote: plan.nextCents === null ? null : plan.nextCents / 100 } });
  const previous = columnBefore === null ? null : String(columnBefore / 100);
  const now = plan.nextCents === null ? null : String(plan.nextCents / 100);
  return [{
    tab: "Projects",
    rowRef: `Job ${jobNumber}`,
    columnName: "Change Quote",
    previousValue: previous,
    newValue: now,
    changeType: classifyChange(previous, now),
    entityType: "Job",
    entityId: jobPk,
    cellKey: `jobField__${jobPk}__changeQuote`,
  }];
}

export async function applyChangeQuote(input: { jobPk: number; id: number }): Promise<ChangeQuoteResult> {
  let role: AppRole | undefined;
  try {
    await assertProjectsEditable();
    role = await sessionRole();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not allowed." };
  }
  const email = (await auth())?.user?.email ?? null;
  let changes: CellChange[] = [];
  let label = "";

  const result = await run(input.jobPk, role, async () => {
    const allowed = new Set(allowedSections(role).map((s) => s.code));
    changes = await prisma.$transaction(async (tx) => {
      const cq = await tx.jobChangeQuote.findFirst({ where: { id: input.id, jobId: input.jobPk }, include: { hours: true } });
      if (!cq) return fail("That change quote no longer exists.");
      label = cq!.label;
      for (const h of cq!.hours) if (!allowed.has(h.section)) return fail(`This change quote includes ${sectionName(h.section) ?? h.section}, which you don't have access to.`);
      const { jobNumber, totals, columnCents } = await readTotals(tx, input.jobPk, allowed);
      const plan = planApply(totals, toCqInput(cq!));
      if (!plan.ok) return fail(plan.error);
      // Claim the Draft → Applied transition first: of two concurrent applies exactly one
      // gets count === 1, so the totals can never be added twice.
      const claimed = await tx.jobChangeQuote.updateMany({
        where: { id: input.id, status: "Draft" },
        data: { status: "Applied", addedToTotals: plan.addedToTotals, appliedAt: new Date(), appliedByEmail: email },
      });
      if (claimed.count !== 1) return fail("This change quote was already applied by someone else.");
      const cells = await writePlan(tx, input.jobPk, jobNumber, totals, plan);
      return [...cells, ...(await writeColumn(tx, role, input.jobPk, jobNumber, columnCents, cq!.amount, "apply", plan.addedToTotals))];
    });
    return `${label} applied — added to the totals.`;
  });

  if (result.ok) {
    await logAudit({ action: "changeQuote.apply", entityType: "JobChangeQuote", entityId: input.id, summary: `Applied change quote ${label} on job ${input.jobPk} `, metadata: { cells: changes.length } });
    await recordChanges(changes, { action: "changeQuote.apply" });
    revalidatePath("/quoted");
  }
  return result;
}

export async function reverseChangeQuote(input: { jobPk: number; id: number }): Promise<ChangeQuoteResult> {
  let role: AppRole | undefined;
  try {
    await assertProjectsEditable();
    role = await sessionRole();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not allowed." };
  }
  let changes: CellChange[] = [];
  let label = "";

  const result = await run(input.jobPk, role, async () => {
    const allowed = new Set(allowedSections(role).map((s) => s.code));
    changes = await prisma.$transaction(async (tx) => {
      const cq = await tx.jobChangeQuote.findFirst({ where: { id: input.id, jobId: input.jobPk }, include: { hours: true } });
      if (!cq) return fail("That change quote no longer exists.");
      label = cq!.label;
      for (const h of cq!.hours) if (!allowed.has(h.section)) return fail(`This change quote includes ${sectionName(h.section) ?? h.section}, which you don't have access to.`);
      const { jobNumber, totals, columnCents } = await readTotals(tx, input.jobPk, allowed);
      const plan = planReverse(totals, toCqInput(cq!));
      if (!plan.ok) return fail(plan.error);
      const claimed = await tx.jobChangeQuote.updateMany({
        where: { id: input.id, status: "Applied" },
        data: { status: "Draft", addedToTotals: false, appliedAt: null, appliedByEmail: null },
      });
      if (claimed.count !== 1) return fail("This change quote was already reversed by someone else.");
      const cells = await writePlan(tx, input.jobPk, jobNumber, totals, plan);
      return [...cells, ...(await writeColumn(tx, role, input.jobPk, jobNumber, columnCents, cq!.amount, "reverse", cq!.addedToTotals))];
    });
    return `${label} reversed back to a draft.`;
  });

  if (result.ok) {
    await logAudit({ action: "changeQuote.reverse", entityType: "JobChangeQuote", entityId: input.id, summary: `Reversed change quote ${label} on job ${input.jobPk}` });
    await recordChanges(changes, { action: "changeQuote.reverse" });
    revalidatePath("/quoted");
  }
  return result;
}

// ── delete a Draft ──────────────────────────────────────────────────────────

export async function deleteChangeQuote(input: { jobPk: number; id: number }): Promise<ChangeQuoteResult> {
  let role: AppRole | undefined;
  try {
    await assertProjectsEditable();
    role = await sessionRole();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not allowed." };
  }
  let label = "";
  const result = await run(input.jobPk, role, async () => {
    const cq = await prisma.jobChangeQuote.findFirst({ where: { id: input.id, jobId: input.jobPk } });
    if (!cq) return fail("That change quote no longer exists.");
    label = cq!.label;
    // Draft only: deleting an Applied one would leave its hours in the totals with no record of where they came from.
    const removed = await prisma.jobChangeQuote.deleteMany({ where: { id: input.id, status: "Draft" } });
    if (removed.count !== 1) return fail("Only a draft can be deleted. Reverse this change quote first.");
    return `${label} deleted.`;
  });
  if (result.ok) await logAudit({ action: "changeQuote.delete", entityType: "JobChangeQuote", entityId: input.id, summary: `Deleted draft change quote ${label} on job ${input.jobPk}` });
  return result;
}
