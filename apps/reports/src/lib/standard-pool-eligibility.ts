import "server-only";
import { prisma } from "@/lib/prisma";
import { isValidMonth } from "@/lib/etc";

// May the category pools for `month` be refreshed from Power BI?
//
// One definition, used by BOTH callers: the Standard Fees panel's Refresh button
// (via assertMonthNotSubmitted, which turns a block into an error message) and
// the 6-hour pass (which turns it into a skipped step). The rule is about the
// pool LEDGER, not about permissions, and getting it wrong corrupts a chain
// rather than one figure — so it must not exist in two places that can drift.
//
// Two blocks, both load-bearing:
//
// • "submitted" — a StandardSheetSnapshot for the month exists, so its figures
//   are frozen history. Refreshing the pools behind a frozen sheet would leave
//   the panel disagreeing with the snapshot it was submitted as.
//
// • "historical" — the month's pools came from Power BI's own archive
//   (source = "power_bi_history"). Each month's starting balance is the PRIOR
//   month's New ETC Hours, so rewriting an archived month's pools breaks the
//   balance chain into every month after it. This is the same class of damage
//   as the historical-ETC corruption in DEVLOG §10, which is why unattended
//   refreshes stop here rather than "just re-pulling".
export type PoolRefreshBlock = "submitted" | "historical" | null;

export async function poolRefreshBlockedBy(month: string): Promise<PoolRefreshBlock> {
  if (!isValidMonth(month)) throw new Error(`"${month}" is not a valid month (expected YYYY-MM).`);
  const submitted = await prisma.standardSheetSnapshot.findFirst({ where: { month }, select: { id: true } });
  if (submitted) return "submitted";
  const historical = await prisma.categoryPool.findFirst({
    where: { month, source: "power_bi_history" },
    select: { id: true },
  });
  if (historical) return "historical";
  return null;
}
