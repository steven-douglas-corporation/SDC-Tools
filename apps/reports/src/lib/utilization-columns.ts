import type { UtilizationMeasures } from "@/lib/department-utilization";

// ── Which breakdown columns the Utilization table draws ─────────────────────
//
// Pure, and split out of UtilizationPanel.tsx so the "is this column empty" rule
// can be asserted without rendering anything.

/**
 * True when a measure is zero or blank in the TOTAL row. The total is the sum of
 * the department rows, and every measure here is non-negative, so a zero total
 * means every department is zero — the column carries nothing for this month.
 */
export function isEmptyMeasure(total: UtilizationMeasures, key: keyof UtilizationMeasures): boolean {
  const v = total[key];
  return v === null || v === 0;
}
