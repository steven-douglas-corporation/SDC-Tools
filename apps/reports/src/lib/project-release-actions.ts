"use server";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertProjectsEditable } from "@/lib/projects-edit-mode";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logAudit } from "@/lib/audit";
import { parseProjectRelease, type ParsedProjectRelease } from "@/lib/project-release";

// Shared: read + parse the uploaded Project Release (.pdf or .docx).
async function parseUpload(formData: FormData): Promise<ParsedProjectRelease> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) throw new Error("No file selected.");
  const name = file.name.toLowerCase();
  if (!name.endsWith(".pdf") && !name.endsWith(".docx")) {
    throw new Error("Please upload a Project Release .pdf or .docx.");
  }
  const buf = Buffer.from(await file.arrayBuffer());
  return parseProjectRelease(buf, file.name);
}

// Map the parsed release into the ProjectRelease row shape. deliveryDate column
// holds the delivery text (e.g. "10-12 Weeks"); the extra PDF fields live in
// `details`.
function releaseRow(parsed: ParsedProjectRelease) {
  return {
    fileName: parsed.fileName,
    uploadedAt: new Date(parsed.uploadedAt),
    receiptOfPo: parsed.receiptOfPo ? new Date(parsed.receiptOfPo) : null,
    deliveryWeeks: parsed.deliveryWeeks,
    deliveryDate: parsed.deliveryText,
    penalty: parsed.penalty,
    penaltyWeeks: parsed.penaltyWeeks,
    milestones: parsed.milestones as unknown as Prisma.InputJsonValue,
    budgetImage: parsed.budgetImage,
    details: {
      jobNumber: parsed.jobNumber,
      jobTitle: parsed.jobTitle,
      buyer: parsed.buyer,
      quote: parsed.quote,
      poNumber: parsed.poNumber,
      customerContact: parsed.customerContact,
      warrantyMonths: parsed.warrantyMonths,
      commercialCost: parsed.commercialCost,
      budget: parsed.budget,
    } as unknown as Prisma.InputJsonValue,
  };
}

// Attach/replace the Project Release on an EXISTING job (from the job page).
// Fills Job.poStartDate from the order date only if it's currently empty, so a
// manager's dates are never overwritten. Nothing here is touched by the
// TotalETO/Power BI syncs, so no manual-edit guard is needed.
export async function uploadProjectRelease(jobId: number, formData: FormData) {
  const parsed = await parseUpload(formData);
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, jobId: true, poStartDate: true },
  });
  if (!job) throw new Error("Job not found.");

  const row = releaseRow(parsed);
  await prisma.projectRelease.upsert({ where: { jobId }, create: { jobId, ...row }, update: row });

  if (parsed.receiptOfPo && !job.poStartDate) {
    await prisma.job.update({ where: { id: jobId }, data: { poStartDate: new Date(parsed.receiptOfPo) } });
  }

  await logAudit({
    action: "projectRelease.upload",
    entityType: "Job",
    entityId: jobId,
    summary: `Uploaded Project Release for job ${job.jobId} (${parsed.fileName})`,
    metadata: { receiptOfPo: parsed.receiptOfPo, deliveryText: parsed.deliveryText, milestones: parsed.milestones.length },
  });

  revalidatePath(`/jobs/${jobId}`);
}

export async function deleteProjectRelease(jobId: number) {
  const existing = await prisma.projectRelease.findUnique({ where: { jobId }, select: { fileName: true } });
  await prisma.projectRelease.deleteMany({ where: { jobId } });
  await logAudit({
    action: "projectRelease.delete",
    entityType: "Job",
    entityId: jobId,
    summary: `Removed Project Release for job ${jobId}${existing ? ` (${existing.fileName})` : ""}`,
  });
  revalidatePath(`/jobs/${jobId}`);
}

// CREATE a new job straight from a Project Release (the Projects-tab feature).
// The doc carries the identity (SDC Project Number / Title / Buyer), so we can
// create the Job and attach the release in one step. Type defaults to "Custom"
// (the doc doesn't specify one; it's editable on the grid afterward). If a job
// with that number already exists, we attach the release to it instead of
// creating a duplicate. Redirects to the job on success.
export async function createJobFromRelease(formData: FormData) {
  // Reached from the Projects toolbar's "+ Add Project → From Release",
  // which only renders in Edit Mode — but the action is exposed regardless,
  // so it enforces the same gate itself rather than trusting that.
  await assertProjectsEditable();
  const parsed = await parseUpload(formData);
  if (!parsed.jobNumber) {
    throw new Error("Couldn't find an SDC Project Number in that release — open the job and upload it there instead.");
  }
  const jobIdStr = parsed.jobNumber.trim();
  const row = releaseRow(parsed);

  const existing = await prisma.job.findUnique({ where: { jobId: jobIdStr }, select: { id: true, poStartDate: true } });

  let targetId: number;
  let created = false;
  if (existing) {
    targetId = existing.id;
    await prisma.projectRelease.upsert({ where: { jobId: targetId }, create: { jobId: targetId, ...row }, update: row });
    if (parsed.receiptOfPo && !existing.poStartDate) {
      await prisma.job.update({ where: { id: targetId }, data: { poStartDate: new Date(parsed.receiptOfPo) } });
    }
  } else {
    const job = await prisma.job.create({
      data: {
        jobId: jobIdStr,
        jobName: parsed.jobTitle || `Job ${jobIdStr}`,
        customer: parsed.buyer || null,
        type: "Custom", // the release doesn't state a type; editable on the grid
        status: "Active",
        source: "manual",
        poStartDate: parsed.receiptOfPo ? new Date(parsed.receiptOfPo) : null,
        projectRelease: { create: row },
      },
      select: { id: true },
    });
    targetId = job.id;
    created = true;
  }

  await logAudit({
    action: created ? "job.createFromRelease" : "projectRelease.upload",
    entityType: "Job",
    entityId: targetId,
    summary: `${created ? "Created" : "Attached release to"} job ${jobIdStr}${parsed.jobTitle ? ` — ${parsed.jobTitle}` : ""} from Project Release`,
    metadata: { jobNumber: parsed.jobNumber, buyer: parsed.buyer, receiptOfPo: parsed.receiptOfPo, created },
  });

  revalidatePath("/quoted");
  revalidatePath(`/jobs/${targetId}`);
  redirect(`/jobs/${targetId}`);
}
