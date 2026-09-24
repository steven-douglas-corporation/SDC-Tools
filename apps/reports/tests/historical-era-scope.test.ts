import { test } from "node:test";
import assert from "node:assert/strict";
import { historicalEraScope } from "../src/lib/hours-filters";

// ── The Hours filters, restated for the migration/frozen-ETC sheets ─────────
//
// The Hours page's `sections` filter holds RAW Paylocity pairs, while
// EstimatedHours and EtcEntry are keyed by standardized column code — so the
// scope has to fold, or a "40-311" filter would silently find nothing.

test("no filters means no constraint on any dimension", () => {
  assert.deepEqual(historicalEraScope({}), { jobIds: undefined, sections: undefined, fromMonth: undefined, toMonth: undefined });
});

test("raw section pairs fold onto the columns the frozen tables are keyed by", () => {
  const scope = historicalEraScope({ sections: ["40-311", "40-211", "10-414", "10-311"] });
  assert.deepEqual(scope.sections?.sort(), ["10-312", "10-313", "10-413", "40-211"]);
});

test("an off-grid code passes through unchanged", () => {
  assert.deepEqual(historicalEraScope({ sections: ["90-211"] }).sections, ["90-211"]);
});

test("a date range becomes the whole months it touches", () => {
  const scope = historicalEraScope({ from: "2024-11-15", to: "2025-02-03" });
  assert.equal(scope.fromMonth, "2024-11");
  assert.equal(scope.toMonth, "2025-02");
});

test("a malformed date is ignored rather than turned into a bogus month", () => {
  const scope = historicalEraScope({ from: "2024-11", to: "garbage" });
  assert.equal(scope.fromMonth, undefined);
  assert.equal(scope.toMonth, undefined);
});

test("jobs pass straight through", () => {
  assert.deepEqual(historicalEraScope({ jobIds: ["1081"] }).jobIds, ["1081"]);
});
