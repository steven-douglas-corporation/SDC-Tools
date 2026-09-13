"use server";

import { getUnattributedDetail, type UnattributedDetail } from "@/lib/unattributed-hours";
import { isValidMonth } from "@/lib/etc";

// Loaded on demand from the KPI card's Detail link rather than shipped with every
// ETC page render: it re-parses the hours export (~900ms), which nobody should
// pay for unless they actually open the drill.
//
// Read-only, and the month is validated rather than trusted — this is reachable
// by anyone with a session, so it must not accept an arbitrary string straight
// into a query.
export async function loadUnattributedDetail(month: string): Promise<UnattributedDetail> {
  if (!isValidMonth(month)) throw new Error(`"${month}" is not a valid month (expected YYYY-MM).`);
  return getUnattributedDetail(month);
}
