"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { logAudit } from "@/lib/audit";
import { recordChanges, classifyChange } from "@/lib/change-log";
import { assertStandardSheetUnlocked } from "@/lib/standard-sheet-gate";
import { CELL_SPECS, parseCell } from "@/lib/cell-rules";

// Global execution rates for the Monthly ETC grid's inline Standard Sheet view.
// Entered once via the "ETC Rates" button and applied to every job on that page
// (the per-job rate columns there were removed). Stored on the singleton
// StandardSheetSetting row — distinct from the /standard-sheet tab's per-job
// ExecutionRate rows, which this does not touch.
export async function saveStandardRates(engrRate: number, shopRate: number, partsMarkup: number, contingencyRate: number) {
  await assertStandardSheetUnlocked();
  // §27.15 — one definition per cell, checked here as well as in the browser. This
  // replaces a loop that applied ONE rule to four fields that do not share one: a 0
  // Engineering Rate collapses every fee on the sheet to $0 and must be refused,
  // while a 0 Contingency Rate is ordinary. The registry says so per field.
  const checked = { engrRate, shopRate, partsMarkup, contingencyRate };
  for (const [name, spec] of [
    ["engrRate", CELL_SPECS["standard.engrRate"]],
    ["shopRate", CELL_SPECS["standard.shopRate"]],
    ["partsMarkup", CELL_SPECS["standard.partsMarkup"]],
    ["contingencyRate", CELL_SPECS["standard.contingencyRate"]],
  ] as const) {
    const out = parseCell(checked[name], spec);
    if (out.kind !== "value") throw new Error(out.kind === "invalid" ? out.message : `${spec.label} is required.`);
    checked[name] = out.value as number;
  }
  ({ engrRate, shopRate, partsMarkup, contingencyRate } = checked);

  // Read BEFORE the write, so the change events below can say what each rate was.
  // These four drive every fee on the sheet, so "who changed the Engineering rate
  // from 170 to 185" is the single most valuable line this app can record.
  const before = await prisma.standardSheetSetting.findUnique({ where: { id: 1 } });

  await prisma.standardSheetSetting.upsert({
    where: { id: 1 },
    update: { engrRate, shopRate, partsMarkup, contingencyRate },
    create: { id: 1, engrRate, shopRate, partsMarkup, contingencyRate },
  });

  await logAudit({
    action: "standardRates.save",
    entityType: "StandardSheetSetting",
    entityId: "1",
    summary: `Set global ETC rates: ENGR ${engrRate}, Shop ${shopRate}, Parts ${partsMarkup}, Contingency ${contingencyRate}`,
  });

  // ── Announce them (§33.1) ─────────────────────────────────────────────────
  //
  // These are GLOBAL: one change re-prices every job's Standard Fees on every open
  // ETC page. So they matter more to other users than an individual cell does, and
  // they were among the paths that announced nothing at all.
  //
  // No cellKey: the rates live in a dialog rather than in a grid cell, and their
  // effect is the whole Standard block rather than one input. An event with no
  // cellKey is exactly how a change says "refetch, I am not one cell" — see
  // RealtimeProvider's onmessage.
  const rateFields: { key: keyof typeof checked; label: string }[] = [
    { key: "engrRate", label: "Engineering Rate" },
    { key: "shopRate", label: "Shop Rate" },
    { key: "partsMarkup", label: "Parts Markup" },
    { key: "contingencyRate", label: "Contingency Rate" },
  ];
  await recordChanges(
    rateFields
      .map(({ key, label }) => {
        const previousValue = before ? String(Number(before[key])) : null;
        const newValue = String(checked[key]);
        return { label, previousValue, newValue };
      })
      // Only the rates that actually moved. All four post together whether or not
      // they were touched, so without this one edit would announce four changes.
      .filter((r) => r.previousValue !== r.newValue)
      .map((r) => ({
        tab: "Monthly ETC",
        rowRef: "ETC Rates (all jobs)",
        columnName: r.label,
        previousValue: r.previousValue,
        newValue: r.newValue,
        changeType: classifyChange(r.previousValue, r.newValue),
        entityType: "StandardSheetSetting",
        entityId: 1,
      })),
    { action: "standardRates.save" },
  );

  revalidatePath("/etc");
}
