import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedBarMax, scaleToPct, flooredSegmentPx } from "../src/lib/parts-cost-financials-shared";

const BAR_H = 540;
const MIN = 10;

// The dotted line sits at the top of the Purchased band (projected bar) and must meet the top of the
// Total bar (Invoiced + Not yet invoiced). Both jobs below were reported with the line inside Not yet invoiced.
for (const j of [
  { name: "job 1", budget: 152_450, invoiced: 217_920, open: 3_246, stp: 597 },
  { name: "job 2", budget: 1_046_250, invoiced: 765_705, open: 2_445, stp: 141 },
]) {
  test(`${j.name}: purchased boundary meets the top of the Total bar`, () => {
    const purchased = j.invoiced + j.open;
    const max = sharedBarMax(j.budget, purchased + j.stp);
    const px = (v: number) => (BAR_H * scaleToPct(v, max)) / 100;
    const proj = flooredSegmentPx(
      [{ key: "purchased", px: px(purchased), hasValue: true }, { key: "stp", px: px(j.stp), hasValue: true }],
      MIN,
    );
    const total = flooredSegmentPx(
      [{ key: "invoiced", px: px(j.invoiced), hasValue: true }, { key: "open", px: px(j.open), hasValue: true }],
      MIN,
    );
    const boundary = proj[0];
    const totalTop = total[0] + total[1];
    assert.ok(Math.abs(boundary - totalTop) < 0.01, `boundary ${boundary} vs total top ${totalTop}`);
    assert.ok(Math.abs(boundary - px(purchased)) < 0.01);
  });
}
