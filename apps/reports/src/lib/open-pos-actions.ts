"use server";

import { assertActionPermission } from "@/lib/require-permission";
import { getPoBomContext, getRequiredDates, type PoBomContext, type RequiredDates } from "@/lib/open-po-bom";

/**
 * Open POs' timeline: when the BOM needs each outstanding PO line's part. Asked once, when
 * the Timeline is opened, for the lines the page already has (`pod:<id>` ids only).
 */
export async function loadOpenPoRequiredDates(lineIds: string[]): Promise<RequiredDates> {
  await assertActionPermission("open-pos:view");
  const ids = (Array.isArray(lineIds) ? lineIds : [])
    .map((id) => /^pod:(\d{1,10})$/.exec(String(id))?.[1])
    .filter((id): id is string => !!id)
    .slice(0, 20_000);
  return getRequiredDates(ids.map(Number));
}

/** Open POs' PO panel: where this PO's parts sit in the BOM. Asked on click, one PO at a time. */
export async function loadPoBomContext(poNumber: string, jobIds: string[]): Promise<PoBomContext> {
  await assertActionPermission("open-pos:view");
  const po = String(poNumber ?? "").trim().slice(0, 32);
  const jobs = (Array.isArray(jobIds) ? jobIds : []).map((j) => String(j).trim()).filter(Boolean).slice(0, 50);
  return getPoBomContext(po, jobs);
}
