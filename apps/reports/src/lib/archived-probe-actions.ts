"use server";

import { assertActionPermission } from "@/lib/require-permission";
import { getJobPartsCostNonArchived, type PartsCostLine } from "@/lib/sync-totaleto";

// Temporary, read-only. Backs the "PO lines without archived" card on Admin >
// Data Management. Writes nothing. See getJobPartsCostNonArchived for why it exists.
export type ArchivedProbeResult =
  | {
      ok: true;
      jobId: string;
      purchased: number;
      paid: number;
      leftToPay: number;
      lines: PartsCostLine[];
      archived: { count: number; purchased: number; paid: number };
    }
  | { ok: false; reason: string };

export async function archivedProbeAction(jobId: string): Promise<ArchivedProbeResult> {
  await assertActionPermission("employees:edit");
  const id = jobId.trim();
  if (!/^\d{1,6}$/.test(id)) return { ok: false, reason: "Enter a numeric job number." };
  try {
    const r = await getJobPartsCostNonArchived(id);
    return { ok: true, jobId: id, purchased: r.purchased, paid: r.paid, leftToPay: r.leftToPay, lines: r.lines, archived: r.archived };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Total ETO query failed." };
  }
}
