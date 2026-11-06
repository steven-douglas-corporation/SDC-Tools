"use server";

import { assertActionPermission } from "@/lib/require-permission";
import { getJobAnalysis, type JobAnalysis } from "@/lib/job-analysis";

// Read-only. Same permission as the Job Details page itself; the month is derived
// server-side from the clock, never taken from the caller.
export async function loadJobAnalysis(): Promise<JobAnalysis> {
  await assertActionPermission("job-hour-details:view");
  return getJobAnalysis();
}
