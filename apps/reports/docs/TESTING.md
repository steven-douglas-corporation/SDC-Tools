# Testing

## Test structure

- **57 files** in `tests/`, flat — no subfolder nesting, one file per module under test
  (`etc.test.ts` covers `lib/etc.ts`, `drill-filters.test.ts` covers `lib/drill-filters.ts`,
  and so on). Filenames are a reliable index of what's covered.
- **Runner**: Node's built-in test runner via `tsx`: `tsx --test tests/*.test.ts`
  (`package.json`'s `test` script) — not Jest, not Vitest. Assertions use `node:assert/strict`.
- No dedicated `typecheck` script exists; `npx tsc --noEmit` is run directly (and covers
  `tests/` and `scripts/` too, since the root `tsconfig.json`'s `include` glob isn't scoped to
  `src/` alone).

## Unit / integration / E2E

**All 57 files are unit tests against pure logic** — none import `PrismaClient`,
`mysql2.createConnection`, or `mssql.connect`. A test either:

- imports pure functions directly from `src/lib/*.ts` and asserts on their output for given
  inputs (e.g. `calcHoursLeft`, `suggestNewEtc` in `etc.test.ts`), or
- exercises an in-process module's own state directly (e.g. `realtime-hub.test.ts` resets the
  hub's module-scope state between tests and asserts on presence/change behavior with no real
  network connection), or
- sets `process.env` inline for a specific check (e.g. `scheduler-sso.test.ts` tests HMAC
  token mint/verify with no live Scheduler connection).

**There are no integration tests against a real database, and no E2E/browser tests** — no
Playwright, Cypress, or Puppeteer dependency exists in `package.json`. Confidence that a feature
works end-to-end currently comes from manual verification (often via a browser preview) at the
time it's built, documented per-change in `DEVLOG.md`, not from an automated E2E suite.

## Critical regression coverage

The heaviest-tested areas, by test file, map directly to the app's most fragile logic:

| Area | Test file(s) |
|---|---|
| ETC math (Prior/Hours Left/New ETC/Diff/rollup) | `etc.test.ts` |
| Monthly submission gate | `monthly-report-submit.test.ts` |
| Undefined Hours / off-grid exclusions | `undefined-hours-rules.test.ts` |
| Drill-through filters and layout | `drill-filters.test.ts`, `drill-design.test.ts` |
| Standard Sheet reveal/hide | `standards-reveal.test.ts` |
| Realtime presence lifecycle | `realtime-hub.test.ts` |
| Upstream call timeout budget | `with-timeout.test.ts` |
| Stale-bundle error detection | `stale-bundle.test.ts` |
| Parts Spent invoiced-only filter | `parts-spent-drill-invoiced.test.ts` |
| Cross-app SSO tokens | `scheduler-sso.test.ts` |

If you change any formula in [ETC-BUSINESS-LOGIC.md](ETC-BUSINESS-LOGIC.md), the corresponding
test file above is where the expected behavior is pinned down — update the test deliberately,
not just to make it pass.

## Commands

```bash
npm test                                    # full suite (57 files)
npx tsx --test tests/etc.test.ts             # one file
npx tsx --test tests/etc.test.ts --test-name-pattern="carry-forward"   # one test by name
npx tsc --noEmit                             # typecheck
npx eslint .                                 # lint
```

## What must pass before deployment

There's no separate CI gate — this is enforced by convention, stated at the end of essentially
every entry in `DEVLOG.md`: **all tests pass, `tsc --noEmit` is clean, and `eslint` is clean**,
checked by hand before considering a change done. In practice:

```bash
npm test && npx tsc --noEmit && npx eslint . && npm run build
```

All four should succeed with no new failures before merging or deploying. A production build
(the fourth step) matters on its own — it catches type/import errors a dev server's incremental
compiler can mask, and it's the only way to verify the app still builds cleanly after a
dependency or config change.
