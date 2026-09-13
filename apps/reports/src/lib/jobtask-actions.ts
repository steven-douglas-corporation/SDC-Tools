"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { logAudit } from "@/lib/audit";
import { recordChanges, classifyChange } from "@/lib/change-log";
import { CELL_SPECS, parseCell } from "@/lib/cell-rules";

// Task assignments mirror the sheet's "ME Name" columns (slots 1-11).

export async function saveJobTask(jobId: number, slot: number | null, formData: FormData) {
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error(`Invalid job id "${jobId}".`);
  const taskName = String(formData.get("taskName") ?? "").trim();
  if (!taskName) throw new Error("Task name is required.");

  // §27.15 — the shared parser, so a pasted "1,200" works here exactly as it does in
  // every other hours cell. Blank still means 0, which is this column's documented rule.
  const parsedHours = parseCell(formData.get("hours"), CELL_SPECS["jobtask.hours"]);
  if (parsedHours.kind === "invalid") throw new Error(parsedHours.message);
  const hours = parsedHours.kind === "value" ? (parsedHours.value as number) : 0;

  // What was there before, so the change event can report the move rather than just
  // the destination (§33.9). Read only for an existing slot — a new task has no before.
  const before = slot === null ? null : await prisma.jobTask.findUnique({ where: { jobId_slot: { jobId, slot } }, select: { taskName: true, estimateToCompleteHours: true } });

  if (slot === null) {
    // New task: next free slot (the sheet had 11 columns; the app doesn't cap).
    // Use create (not upsert): if two "Add Task" clicks race and both compute
    // the same next slot, the second hits the jobId_slot unique constraint and
    // fails loudly instead of silently OVERWRITING the first task's row.
    const last = await prisma.jobTask.findFirst({ where: { jobId }, orderBy: { slot: "desc" }, select: { slot: true } });
    slot = (last?.slot ?? 0) + 1;
    await prisma.jobTask.create({ data: { jobId, slot, taskName, estimateToCompleteHours: hours } });
  } else {
    await prisma.jobTask.upsert({
      where: { jobId_slot: { jobId, slot } },
      update: { taskName, estimateToCompleteHours: hours },
      create: { jobId, slot, taskName, estimateToCompleteHours: hours },
    });
  }
  await logAudit({
    action: "jobtask.save",
    entityType: "JobTask",
    entityId: `${jobId}-${slot}`,
    summary: `Saved task "${taskName}" (${hours}h) on job ${jobId}, slot ${slot}`,
    metadata: { jobId, slot, taskName, hours },
  });
  // §33.1 — the task grid on a job page was silent too. Two cells per row (the name
  // and its hours), announced separately so a reader sees which one moved.
  const jobNumber = await jobNumberFor(jobId);
  await recordChanges(
    (
      [
        { label: `Task ${slot} Name`, previousValue: before?.taskName ?? null, newValue: taskName },
        {
          label: `Task ${slot} Hours`,
          previousValue: before ? String(Number(before.estimateToCompleteHours)) : null,
          newValue: String(hours),
        },
      ] as const
    )
      .filter((f) => f.previousValue !== f.newValue)
      .map((f) => ({
        tab: "Job Details",
        rowRef: `Job ${jobNumber}`,
        columnName: f.label,
        previousValue: f.previousValue,
        newValue: f.newValue,
        changeType: classifyChange(f.previousValue, f.newValue),
        entityType: "JobTask",
        entityId: `${jobId}-${slot}`,
      })),
    { action: "jobtask.save" },
  );
  revalidatePath(`/jobs/${jobId}`);
}

export async function deleteJobTask(id: number, _formData: FormData) {
  const task = await prisma.jobTask.delete({ where: { id } });
  await logAudit({
    action: "jobtask.delete",
    entityType: "JobTask",
    entityId: id,
    summary: `Deleted task "${task.taskName}" from job ${task.jobId}`,
  });
  // A deletion is a removal of BOTH cells in that row — reported as one event naming
  // the task, because "Task 3 Name removed" plus "Task 3 Hours removed" would describe
  // one action twice.
  await recordChanges(
    [
      {
        tab: "Job Details",
        rowRef: `Job ${await jobNumberFor(task.jobId)}`,
        columnName: `Task ${task.slot}`,
        previousValue: `${task.taskName} (${Number(task.estimateToCompleteHours)}h)`,
        newValue: null,
        changeType: "removed",
        entityType: "JobTask",
        entityId: id,
      },
    ],
    { action: "jobtask.delete" },
  );
  revalidatePath(`/jobs/${task.jobId}`);
}

// The human job number for the banner's rowRef. `jobId` in this file is the Job PK,
// which means nothing to a reader.
async function jobNumberFor(jobPk: number): Promise<string> {
  const job = await prisma.job.findUnique({ where: { id: jobPk }, select: { jobId: true } });
  return job?.jobId ?? String(jobPk);
}
