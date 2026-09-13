"use server";

import { assertActionPermission } from "@/lib/require-permission";
import { VALID_JOB_TYPES } from "@/lib/job-filters";
import { fetchActiveJobDrill, type JobDrillFilter, type JobDrillResult } from "@/lib/dashboard-job-drill";

// The Dashboard's inline drill-through, fetched when a bar is clicked. See
// dashboard-job-drill.ts for why the row set cannot drift from the bar's count
// and why this is on-demand rather than shipped with the page.

export async function loadActiveJobDrill(filter: JobDrillFilter): Promise<JobDrillResult> {
  // A server action is a public endpoint, not a private function the page calls —
  // it gets the same gate the Dashboard page itself has, or the job book would be
  // readable by anyone who can POST to it.
  await assertActionPermission("dashboard:view");

  // `filter` arrives from the client and is therefore untrusted input, even
  // though our own UI only ever sends values it read off the chart. `kind` is
  // checked against the two literals and a type is checked against the declared
  // list, so neither can smuggle a different column into the query. `value` for a
  // customer is a free-text field by nature and is passed to Prisma as a bound
  // parameter (never interpolated), so it needs a length bound rather than a
  // whitelist.
  if (filter.kind !== "customer" && filter.kind !== "type") {
    throw new Error("Unknown drill kind.");
  }
  if (typeof filter.value !== "string" || filter.value.length === 0 || filter.value.length > 200) {
    throw new Error("Invalid drill value.");
  }
  if (filter.kind === "type" && !VALID_JOB_TYPES.includes(filter.value as (typeof VALID_JOB_TYPES)[number])) {
    throw new Error("Unknown project type.");
  }

  return fetchActiveJobDrill({ kind: filter.kind, value: filter.value });
}
