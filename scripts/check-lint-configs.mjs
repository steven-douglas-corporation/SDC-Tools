#!/usr/bin/env node
// Every JavaScript app carries a copy of packages/eslint-config/eslint.config.mjs.
// This checks the copies have not drifted from the canonical file, and `--fix`
// re-copies the canonical block into each app while preserving anything the app
// added below the override marker.
//
//   node scripts/check-lint-configs.mjs         # exit 1 on drift
//   node scripts/check-lint-configs.mjs --fix   # rewrite the canonical block in place
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL = join(ROOT, "packages", "eslint-config", "eslint.config.mjs");
export const MARKER = "// ── App-specific overrides below ─────────────────────────────────────────";
const APPS = ["apps/assemblies", "apps/build-readiness", "apps/calendar", "apps/shell", "apps/state-logic"];

const fix = process.argv.includes("--fix");
const canonical = readFileSync(CANONICAL, "utf8").replace(/\r\n/g, "\n");

let drift = 0;
for (const app of APPS) {
  const file = join(ROOT, app, "eslint.config.mjs");
  if (!existsSync(file)) {
    console.log(`MISSING  ${app}/eslint.config.mjs`);
    drift++;
    if (fix) writeFileSync(file, canonical);
    continue;
  }
  const current = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const markerAt = current.indexOf(MARKER);
  const head = markerAt >= 0 ? current.slice(0, markerAt) : current;
  const tail = markerAt >= 0 ? current.slice(markerAt) : "";
  // The canonical block may be followed by the marker and app additions; the
  // canonical file itself ends with the default export's closing `];\n`.
  if (head.trimEnd() === canonical.trimEnd()) {
    console.log(`ok       ${app}`);
    continue;
  }
  drift++;
  console.log(`DRIFT    ${app}/eslint.config.mjs differs from packages/eslint-config/eslint.config.mjs`);
  if (fix) {
    writeFileSync(file, canonical.trimEnd() + "\n" + (tail ? "\n" + tail : ""));
    console.log(`fixed    ${app}`);
  }
}

if (drift && !fix) {
  console.error(`\n${drift} lint config(s) drifted. Run: node scripts/check-lint-configs.mjs --fix`);
  process.exit(1);
}
