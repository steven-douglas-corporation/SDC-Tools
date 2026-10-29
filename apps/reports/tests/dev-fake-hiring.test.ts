import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeWarehouseHiringRows } from "../src/lib/dev-fake-hiring";
import { toHiringPositions } from "../src/lib/hiring-warehouse-parse";

// The fake postings are dev-only and go through the real parser, so they have to
// look like the warehouse's rows and must never switch on without the flag.

test("the fake postings parse like warehouse rows, and the evergreen posting is dropped", () => {
  const parsed = toHiringPositions(fakeWarehouseHiringRows());
  assert.equal(parsed.length, fakeWarehouseHiringRows().length - 1);
  assert.ok(!parsed.some((p) => /general job posting/i.test(p.row.title)));
  assert.ok(parsed.every((p) => p.managerIds.length === 1), "every fake posting names one hiring manager by id");
  assert.ok(parsed.some((p) => p.row.subStatus === "Paused"), "covers a paused posting");
});

test("the fake is used only behind SDC_DEV_FAKE_HIRING=1", () => {
  const fake = readFileSync(join(__dirname, "..", "src", "lib", "dev-fake-hiring.ts"), "utf8");
  assert.match(fake, /process\.env\.SDC_DEV_FAKE_HIRING === "1"/);
  const reader = readFileSync(join(__dirname, "..", "src", "lib", "hiring-warehouse.ts"), "utf8");
  assert.match(reader, /if \(devFakeHiringEnabled\(\)\) return toHiringPositions\(fakeWarehouseHiringRows\(\)\);/);
});
