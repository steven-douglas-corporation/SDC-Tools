import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paylocityFolder } from "../src/lib/paylocity-sources";
import { workbookPath } from "../src/lib/paylocity-workbook";
import { hiringWorkbookPath, HiringWorkbookError } from "../src/lib/hiring-workbook";

// ── No silent default path to one person's OneDrive (2026-09-14) ────────────
//
// Four readers fell back to a hardcoded C:/Users/akamuju/... path when their env
// var was unset. A deployment with a missing .env key therefore did not fail — it
// read whatever stale copy that profile held and called it current. Unset now
// means "not configured", and says so.

const KEYS = ["JOB_HOURS_LOCAL_PATH", "PAYLOCITY_HOURS_DIR", "HIRING_POSITIONS_LOCAL_PATH"] as const;

function withEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>, run: () => void): void {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of KEYS) {
      const v = values[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    run();
  } finally {
    for (const k of KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("Paylocity: unset means a clear configuration error naming both variables, never a default folder", () => {
  withEnv({}, () => {
    assert.throws(() => paylocityFolder(), /JOB_HOURS_LOCAL_PATH[\s\S]*PAYLOCITY_HOURS_DIR[\s\S]*There is no default path/);
    assert.throws(() => workbookPath(), /JOB_HOURS_LOCAL_PATH[\s\S]*There is no default path/);
  });
  // Whitespace is not a configuration.
  withEnv({ JOB_HOURS_LOCAL_PATH: "   " }, () => assert.throws(() => workbookPath(), /not configured/));
});

test("Paylocity: the configured values are honoured, JOB_HOURS_LOCAL_PATH first", () => {
  withEnv({ JOB_HOURS_LOCAL_PATH: "D:/hours/Current_Job_Hours.xlsx", PAYLOCITY_HOURS_DIR: "D:/other" }, () => {
    assert.equal(workbookPath(), "D:/hours/Current_Job_Hours.xlsx");
    assert.equal(paylocityFolder().replace(/\\/g, "/"), "D:/hours", "the file's own folder wins over PAYLOCITY_HOURS_DIR");
  });
  withEnv({ PAYLOCITY_HOURS_DIR: "D:/other" }, () => assert.equal(paylocityFolder(), "D:/other"));
});

test("Hiring: unset is a HiringWorkbookError the /employees page already degrades on", () => {
  withEnv({}, () => {
    assert.throws(
      () => hiringWorkbookPath(),
      (e: unknown) => e instanceof HiringWorkbookError && e.stage === "file_missing" && /HIRING_POSITIONS_LOCAL_PATH/.test(e.message),
    );
  });
  withEnv({ HIRING_POSITIONS_LOCAL_PATH: "D:/hr/Job.xlsx" }, () => assert.equal(hiringWorkbookPath(), "D:/hr/Job.xlsx"));
});

test("no reader carries a hardcoded path under a personal profile any more", () => {
  const lib = join(process.cwd(), "src", "lib");
  for (const f of ["paylocity-sources.ts", "paylocity-workbook.ts", "hiring-workbook.ts", "job-cost-inventory-sync.ts"]) {
    // Comments stripped: the history of the default is allowed to be written down.
    const code = readFileSync(join(lib, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /Users[\\/\\]+akamuju/i, `${f} still defaults to a path under one person's profile`);
  }
  // The inventory sync models "not configured" as its existing skip state.
  const inv = readFileSync(join(lib, "job-cost-inventory-sync.ts"), "utf8");
  assert.match(inv, /JOB_COST_INVENTORY_FOLDER is not set in \.env/);
});
