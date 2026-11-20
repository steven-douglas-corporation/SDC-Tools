// Runs the Project Tracker forecast as its own process, outside the web app.
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/tracker/run-forecast.ts [--trigger nightly] [--simulations 2000] [--as-of 2026-11-11]
//
// The simulation takes tens of seconds on a large plan and this app runs as a single process,
// so it must never run inside it (docs/MODULES.md). Schedule this nightly with --trigger nightly
// --simulations 2000. Needs TRACKER_ENGINE_DATABASE_URL in .env.
import "dotenv/config";
import { closeTrackerPools, trackerEngineDb } from "../../src/modules/tracker/db";
import { runForecast } from "../../src/modules/tracker/service/forecast";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const trigger = arg("trigger") ?? "manual";
  if (trigger !== "nightly" && trigger !== "manual" && trigger !== "change") {
    throw new Error(`--trigger must be nightly, manual or change (got "${trigger}")`);
  }
  const simulations = Number(arg("simulations") ?? 0);
  if (!Number.isInteger(simulations) || simulations < 0)
    throw new Error("--simulations must be a whole number, 0 or more");
  // Local calendar date, not UTC: late in the evening UTC is already tomorrow.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const asOf = arg("as-of") ?? today;

  const started = Date.now();
  const result = await runForecast(trackerEngineDb, { asOf, triggeredBy: trigger, simulations });
  console.log(
    `forecast run ${result.runId} as of ${asOf}: ${result.tasksScheduled} scheduled, ` +
      `${result.tasksUnscheduled} unscheduled, ${simulations} simulations, ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeTrackerPools());
