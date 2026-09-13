import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcTotalEtcDollars,
  calcPercentOfTotal,
  calcStandardFeeEngineering,
  calcStandardFeeShop,
  calcTotalStandardFees,
} from "../src/lib/standard-fees";

const RATE = { engrRate: 170, shopRate: 140, partsMarkup: 1.2 };
const POOLS = { engineeringPM: 416500, engineeringWarranty: 301393, shopManufacturing: 324800, shopWarranty: 105714 };

test("calcTotalEtcDollars: (H*D)+(I*E)+(J*F) from the sheet", () => {
  assert.equal(calcTotalEtcDollars({ engineering: 10, shop: 20, parts: 1000 }, RATE), 10 * 170 + 20 * 140 + 1000 * 1.2);
  assert.equal(calcTotalEtcDollars({ engineering: 0, shop: 0, parts: 0 }, RATE), 0);
});

test("calcPercentOfTotal: share of grand total, 0 instead of NaN on empty sheet", () => {
  assert.equal(calcPercentOfTotal(50, 200), 0.25);
  assert.equal(calcPercentOfTotal(0, 0), 0); // mirrors IFERROR(...,0)
});

test("standard fee allocations split by billing group pools", () => {
  assert.equal(calcStandardFeeEngineering(0.1, POOLS), 0.1 * (416500 + 301393));
  assert.equal(calcStandardFeeShop(0.1, POOLS), 0.1 * (324800 + 105714));
});

test("calcTotalStandardFees: (L+O+P)+(R*R8)", () => {
  assert.equal(calcTotalStandardFees(1000, 200, 100, 500, 0.1), 1000 + 200 + 100 + 50);
  assert.equal(calcTotalStandardFees(0, 0, 0, 0, 0.1), 0);
});
