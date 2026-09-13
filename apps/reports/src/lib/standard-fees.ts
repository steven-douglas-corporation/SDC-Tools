import type { ExecutionEtc } from "@/lib/execution-etc";

export type JobRate = { engrRate: number; shopRate: number; partsMarkup: number };
export type CategoryPoolTotals = { engineeringPM: number; engineeringWarranty: number; shopManufacturing: number; shopWarranty: number };

// Mirrors Standard Fees.xlsx column L: =(H*D)+(I*E)+(J*F) — Execution ETC
// hours/dollars times their Execution Rate, summed to one dollar figure.
export function calcTotalEtcDollars(etc: ExecutionEtc, rate: JobRate): number {
  return etc.engineering * rate.engrRate + etc.shop * rate.shopRate + etc.parts * rate.partsMarkup;
}

// Mirrors column M: =L/$L$66 — this job's share of the grand total across
// every listed job. 0 (not NaN/Infinity) when nothing has been entered yet,
// matching the sheet's IFERROR(...,0).
export function calcPercentOfTotal(totalEtcDollars: number, grandTotalEtcDollars: number): number {
  if (grandTotalEtcDollars === 0) return 0;
  return totalEtcDollars / grandTotalEtcDollars;
}

// Mirrors columns O/P: each job's % share of the grand total, applied to the
// company-wide category pool's Standard Fee dollars (Engineering PM + Warranty,
// Shop Manufacturing + Warranty) — i.e. this job's proportional allocation of
// the department-wide fee.
export function calcStandardFeeEngineering(percentOfTotal: number, pools: CategoryPoolTotals): number {
  return percentOfTotal * (pools.engineeringPM + pools.engineeringWarranty);
}

export function calcStandardFeeShop(percentOfTotal: number, pools: CategoryPoolTotals): number {
  return percentOfTotal * (pools.shopManufacturing + pools.shopWarranty);
}

// Mirrors column T: =(L+O+P)+(R*$R$8) — Total ETC $ + both Standard Fee
// allocations + this job's manual Contingency amount times the single
// global contingency rate (sheet cell R8).
export function calcTotalStandardFees(
  totalEtcDollars: number,
  standardFeeEngineering: number,
  standardFeeShop: number,
  contingencyAmount: number,
  contingencyRate: number
): number {
  return totalEtcDollars + standardFeeEngineering + standardFeeShop + contingencyAmount * contingencyRate;
}
