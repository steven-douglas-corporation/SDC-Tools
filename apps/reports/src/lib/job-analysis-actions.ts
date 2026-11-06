"use server";

import { assertActionPermission } from "@/lib/require-permission";
import { getJobAnalysis, type JobAnalysis } from "@/lib/job-analysis";
import { checkPartsParity, type ParityReport } from "@/lib/parts-parity";

// Read-only. Same permission as the Job Details page itself; the month is derived
// server-side from the clock, never taken from the caller.
export async function loadJobAnalysis(): Promise<JobAnalysis> {
  await assertActionPermission("job-hour-details:view");
  return getJobAnalysis();
}

// Rebuilds every job's Parts List figures and compares them with the Analysis figures
// (and Monthly ETC's stored Money Spent). Recomputes the analysis itself rather than
// trusting figures sent from the browser.
export async function verifyJobAnalysis(): Promise<ParityReport> {
  await assertActionPermission("job-hour-details:view");
  return checkPartsParity(await getJobAnalysis());
}
