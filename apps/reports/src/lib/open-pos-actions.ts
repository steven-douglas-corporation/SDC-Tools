"use server";

import { assertActionPermission } from "@/lib/require-permission";
import { getPoBomContext, type PoBomContext } from "@/lib/open-po-bom";

/** Open POs' PO panel: where this PO's parts sit in the BOM. Asked on click, one PO at a time. */
export async function loadPoBomContext(poNumber: string, jobIds: string[]): Promise<PoBomContext> {
  await assertActionPermission("open-pos:view");
  const po = String(poNumber ?? "").trim().slice(0, 32);
  const jobs = (Array.isArray(jobIds) ? jobIds : []).map((j) => String(j).trim()).filter(Boolean).slice(0, 50);
  return getPoBomContext(po, jobs);
}
