import { test } from "node:test";
import assert from "node:assert/strict";
import { stepBudgetFor, withStepBudget, memoizeAsync, STEP_TIMEOUT_MS } from "../src/lib/auto-sync";

// ── Per-step budgets, an abort that means it, and one workbook parse (2026-09-14)
//
// Three defects in auto-sync.ts's step runner, all pure logic and all pinned here:
//   * one 45s budget for every step, though parts_cost's own statements are allowed
//     180s each — a slow-but-working Total ETO was recorded as failed;
//   * "abandoned" meant "no longer awaited", so the orphaned step ran on and wrote
//     EtcEntry after the RefreshLock was released;
//   * `cached ??= await begin()` was not single-flight, so a step timing out
//     mid-parse let the next step start a second full Paylocity parse.

const REFRESH_BUTTON_CEILING_MS = 300_000; // RefreshDataButton.tsx's REFRESH_TIMEOUT_MS
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the default budget stays 45s; the two 180s-statement Total ETO steps get more, and nothing exceeds the button", () => {
  assert.equal(stepBudgetFor("hours_actual"), STEP_TIMEOUT_MS);
  assert.equal(stepBudgetFor("totaleto_jobs"), STEP_TIMEOUT_MS);
  assert.equal(STEP_TIMEOUT_MS, 45_000);
  assert.ok(stepBudgetFor("parts_cost") > STEP_TIMEOUT_MS, "two sequential 180s statements cannot be judged in 45s");
  assert.ok(stepBudgetFor("parts_cost_actual") > STEP_TIMEOUT_MS);
  assert.ok(stepBudgetFor("parts_cost") >= stepBudgetFor("parts_cost_actual"), "parts_cost runs two statements, parts_cost_actual one");
  for (const s of ["parts_cost", "parts_cost_actual", "hours_actual"]) {
    assert.ok(stepBudgetFor(s) < REFRESH_BUTTON_CEILING_MS, `${s}'s budget must fit inside the button's own ceiling`);
  }
});

test("withStepBudget passes a fast result through, with the signal un-aborted", async () => {
  let seen: AbortSignal | null = null;
  const v = await withStepBudget("fast", 1000, async (signal) => {
    seen = signal;
    return "rows";
  });
  assert.equal(v, "rows");
  assert.equal(seen!.aborted, false);
});

test("withStepBudget rejects on expiry AND aborts the signal it handed out, carrying the reason", async () => {
  let seen: AbortSignal | null = null;
  await assert.rejects(
    () =>
      withStepBudget("Parts cost (TotalETO)", 20, async (signal) => {
        seen = signal;
        await sleep(200);
        return "too late";
      }),
    /Parts cost \(TotalETO\) did not respond within 0\.02s — stopped/,
  );
  assert.equal(seen!.aborted, true, "the step's Total ETO work must be told to stop, not merely un-awaited");
  assert.match(String((seen!.reason as Error).message), /did not respond/);
});

test("withStepBudget passes a real failure through unrelabelled and does not abort", async () => {
  let seen: AbortSignal | null = null;
  const boom = new Error("Login failed");
  await assert.rejects(
    () =>
      withStepBudget("x", 1000, async (signal) => {
        seen = signal;
        throw boom;
      }),
    (e: unknown) => e === boom,
  );
  assert.equal(seen!.aborted, false);
});

test("memoizeAsync is single-flight: concurrent callers share ONE in-flight call", async () => {
  let runs = 0;
  const parse = memoizeAsync(async () => {
    runs++;
    await sleep(20);
    return { rows: 19_800 };
  });
  // hours_actual and undefined_hours both asking while the first parse is still running.
  const [a, b, c] = await Promise.all([parse(), parse(), parse()]);
  assert.equal(runs, 1, "the workbook must be parsed once per pass, however many steps ask");
  assert.equal(a, b);
  assert.equal(b, c);
  // And after it settled, still the same value — no re-parse.
  assert.equal(await parse(), a);
  assert.equal(runs, 1);
});

test("memoizeAsync forgets a rejection so the next step retries with its own error (rule 2)", async () => {
  let runs = 0;
  const parse = memoizeAsync(async () => {
    runs++;
    if (runs === 1) throw new Error("OneDrive placeholder, not hydrated");
    return "ok";
  });
  await assert.rejects(parse, /placeholder/);
  assert.equal(await parse(), "ok", "a later step must get a fresh attempt, not a replayed failure");
  assert.equal(runs, 2);
});
