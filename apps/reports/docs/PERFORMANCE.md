# Performance baseline — SDC Tools ecosystem

Measured 2026-08-25 on **SERVER-APP1**, against the **production** builds and the
live PM2 processes. Every figure below is measured, not estimated; the method is
given so each can be re-run and compared after a change.

This document exists because the ecosystem had no performance baseline, which
made "is it faster?" unanswerable. Re-run §1 and §2 after any optimization and
append the new column rather than overwriting the old one.

---

## 0. Headline conclusion

**The backend is not the bottleneck.** Across all seven services, at rest:

| Metric | Range across all services |
|---|---|
| HTTP latency p50 | 0–2 ms |
| HTTP latency p95 | 1–15 ms |
| Event-loop latency p50 | 0.32–0.50 ms |
| Event-loop latency p95 | 1.55–1.90 ms |
| CPU | 0–2.5 % (of 10 cores) |
| Total RSS, all 8 processes | ~570 MB |

Nothing is CPU-starved, nothing is memory-pressured, and no event loop is
blocking. Anything a user experiences as slow is therefore either (a) **payload
and client-side render**, or (b) one of the few genuinely heavy operations
(Refresh Data, live Total ETO queries), not general server slowness.

Effort should go to payload size and client work. See §3.

> ⚠️ Caveat on the PM2 figures: they were captured at **~1.5–1.9 req/min**, i.e.
> effectively idle. They establish that there is no *baseline* resource problem;
> they are not a load test. A concurrent-user load test is listed as remaining
> work in §5.

---

## 1. Route baseline — `apps/reports` (port 4006)

Method: from an authenticated browser session on the server, for each route,
`fetch(route, {headers:{RSC:"1"}, cache:"no-store"})`, measuring time to first
byte, time to fully read the body, and body size. Three passes; figures below are
the steady-state (pass 2–3) values, which varied by <10%.

| Route | TTFB | Total | Payload | Budget (§18) |
|---|---|---|---|---|
| `/jobs` | 11 ms | 40 ms | 274 KB | ✅ |
| `/employees` | 11 ms | 43 ms | 58 KB | ✅ |
| `/audit-log` | 8 ms | 63 ms | 232 KB | ✅ |
| `/hours` | 9 ms | 132 ms | 205 KB | ✅ |
| `/etc` | 9 ms | ~200 ms | 659 KB | ✅ |
| `/quoted` | 9 ms | ~240 ms | 1,018 KB | ✅ markup, not data — see F4 |
| `/build-readiness` | 8 ms | ~280 ms | **5,489 KB** → ~1,916 KB after F1 | ⚠️ payload |
| `/tm` | 8 ms | 398 ms | 36 KB | ✅ |
| `/job-hours` | 9 ms | 234 ms | 428 KB | ✅ |
| `/job-cost-explorer` | 9 ms | ~600 ms | 120 KB | ⚠️ time |
| `/cash-flow` | 9 ms | **~1,260 ms** | 199 KB | ❌ time |

TTFB is uniformly 8–11 ms — the server starts responding essentially instantly on
every route. The cost is entirely in generating and transferring the body.

Cold-start note: the very first request to a route after process start is
noticeably slower (`/` measured 284 ms cold vs 40 ms warm; `/cash-flow` 2,545 ms
cold vs 1,260 ms warm). Compare warm-to-warm only.

## 1b. Other services

| Service | Port | Root route TTFB | Notes |
|---|---|---|---|
| sdc-assemblies | 4001 | 1.5 ms | 401 unauthenticated |
| sdc-readiness | 4002 | 1.4 ms | 401 unauthenticated |
| sdc-scheduler | 4003 | 2.0 ms | 200, 62.8 KB |
| sdc-statelogic | 4004 | 1.3 ms | 401 unauthenticated |
| sdc-calendar | 4005 | 2.7 ms | 200, 1.4 KB |
| apps/reports | 4006 | 3.2 ms | 307 → /login |

Measure over `127.0.0.1`, never `localhost` — the latter adds a ~200 ms IPv6
resolution penalty on this box and will make every service look 100× slower than
it is.

## 1c. Refresh Data

From the dashboard's own reporting: the full pass covers **9 sources in 17.7 s**,
scheduled hourly, and "Refresh Data" runs the identical pass on demand. This is
the heaviest routine operation in the ecosystem and is already within a
reasonable envelope for what it does.

## 1d. PM2 process baseline

| Process | RSS | CPU | Heap used / total | Restarts | `max_memory_restart` |
|---|---|---|---|---|---|
| apps/reports | 236.9 MB | 2.5 % | 184.8 / 191.0 MiB | 0 | **none** → 600 M (F3) |
| sdc-scheduler | 50.3 MB | 1.1 % | 57.8 / 60.7 MiB | 2 | 400 M |
| sdc-readiness | 48.3 MB | 0.2 % | 31.4 / 34.1 MiB | 0 | 300 M |
| sdc-statelogic | 48.0 MB | 0.1 % | 15.2 / 19.8 MiB | 0 | 300 M |
| sdc-calendar | 47.9 MB | 0.7 % | 21.4 / 27.5 MiB | 0 | 300 M |
| sdc-assemblies | 47.9 MB | 0.0 % | 14.2 / 23.5 MiB | 0 | 300 M |
| sdc-updater-hub | 46.8 MB | 0.0 % | 12.4 / 16.8 MiB | 0 | 350 M |
| pm2-logrotate | 43.6 MB | 0.0 % | 11.4 / 14.1 MiB | 0 | 500 M |

High heap-*usage* percentages (92–97%) are not a leak signal on their own — V8
keeps the heap tight against its current total and grows on demand. The absolute
totals are all small. Treat a rising `Heap Size` *total* across days as the leak
signal, not the usage ratio.

Method: `pm2 jlist` from an **elevated** shell. PM2 runs as `NT AUTHORITY\SYSTEM`
here, so a normal `akamuju` session gets `EPERM` on `\\.\pipe\rpc.sock`. See
`docs/DEPLOYMENT.md` for the restart path that does not require elevation.

> **Do not paste raw `pm2 jlist` output into tickets or chats.** It dumps every
> process's full environment, which includes `ETO_PASSWORD` and other secrets in
> plaintext.

---

## 2. Ranked findings

### F1 — `/build-readiness` ships 5.48 MB to render 50 summary rows ❌

**Measured:** 5,611,698 chars. 50 job detail objects containing ~2,800
assemblies and **~15,000 part-level line items** (15,445 `qty` fields, 17,293
`expectedDate` fields, 2,760 `poNumber` fields).

**Status: FIXED** — `detailJson` 5,433 KB → 1,860 KB (−65.8%). See "Resolution"
at the end of this finding.

**Root cause:** `getBuildReadinessData()`
(`src/lib/build-readiness-actions.ts:113`) selects `detailJson` for *every* row
of `BuildReadinessJobSnapshot` with no `WHERE` clause, parses it into `detail`,
and `build-readiness/page.tsx` hands the entire result to the
`BuildReadinessDashboard` client component as `initialData` — so all of it is
serialized into the RSC payload on every page load.

Measured composition of `detailJson` over all 50 rows:

| Sub-array | Size | Entries | Share |
|---|---|---|---|
| `vendors` | **3,832 KB** | 1,313 | **70.5%** |
| `assemblies` | 649 KB | 1,638 | 11.9% |
| `blockers` | 616 KB | 1,806 | 11.3% |
| `upcoming` | 333 KB | 912 | 6.1% |

`vendors` at ~3 KB per entry was the whole problem, and all of it was
`Vendor.pos[].lines` — `PoLineDetail[]`, every individual PO line, 14,560 of them
across 3,909 PO groups. **Nothing reads it.** Every consumer of `vendors` uses
`v.name` plus a PO's `poId`/`itemCount`/`received`/`pct` and no more:
`computeSupplierRisk()` (`build-readiness-forecast.ts:161`), `SupplierDrillView`,
and the supplier filter's option list.

**Resolution (implemented):** `JobDetail.vendors` is now `SnapshotVendor[]`, whose
PO type is `Omit<PoLineGroup, "lines">`. The projection is applied on the write
path (`build-readiness-sync.ts`, so it is no longer stored) *and* on the read path
(`safeParseDetail` in `build-readiness-actions.ts`, so snapshots written before
this change are trimmed on read rather than staying large until the next full
refresh).

Doing it at the *type* level is the point: had any consumer needed `lines`, the
`Omit` would have failed to compile. It typechecks clean, which is the proof the
change is behaviour-identical. It also means a future consumer that needs
per-line detail gets a compile error rather than silently restoring a 3.8 MB
payload — and the right answer then is to fetch that job's lines on demand, which
`build-readiness-po-actions.ts` already does.

**Measured result**, computed by applying the projection to the live production
rows:

| | Before | After | Δ |
|---|---|---|---|
| `vendors` | 3,832 KB | 259 KB | **−93.2%** |
| `detailJson` total | 5,433 KB | 1,860 KB | **−65.8%** |

**Still outstanding:** the remaining ~1,860 KB is `assemblies` + `blockers` +
`upcoming` (~1,598 KB), and unlike `vendors.lines` these *are* genuinely read
across all jobs at first paint — `BuildReadinessInsights` renders unconditionally
(`BuildReadinessDashboard.tsx:282`) and aggregates them, `BuildReadinessFilters`
builds its option lists from them, and `BuildReadinessDrillViews.tsx:401`
flat-maps blockers cross-job. Cutting those requires moving the aggregations
server-side and lazy-loading per-job detail — real work, and it changes code that
produces displayed operational figures, so it needs its own pass with before/after
equality checks on every panel. A cheaper partial: `UpcomingDeliveryEntry` and
`BlockerEntry` each repeat `jobId`/`jobName` that their parent row already
carries, and `sync.ts:340` writes `incomingParts` as an always-single-element
array that could be flattened to scalar `pn`/`qty`.

**Note:** the default view does not need any of it. The main table
(`BuildReadinessDashboard.tsx:202-270`) and the KPI strip (`:155-166`) read only
scalar snapshot fields. The dependency is entirely the Insights panel and the
filter option lists.

### F2 — `/cash-flow` takes ~1.26 s — waterfall FIXED, rest inherent ⚠️

**Root cause:** two sequential awaits precede the parallel block —
`resolveAsOf(as)` then `getLatestSnapshotSummary()` — and only then does the
`Promise.all` start. But the dominant cost is `getCashFlowLines(asOf)` querying
Total ETO live, which is deliberate ("Current is always live against Total ETO").

**Fix:** `getProjectEstimates()` and `listSnapshots()` depend on neither `asOf`
nor `compareAsOf` and can be hoisted to start immediately, removing them from the
waterfall. This is a small, safe win; it does **not** address the ~1 s live
MSSQL query, which cannot be cached without showing a stale financial forecast
(§9: "do not improve speed by showing stale data").

**Priority:** low — one page, ELT-only audience, latency largely inherent.

### F3 — `apps/reports` has no `max_memory_restart` — FIXED ✅

**Root cause:** `ecosystem.config.js` sets `max_memory_restart` on all seven
other PM2 apps but omits it on `apps/reports` — which is by far the largest
process (236.9 MB, 5× any other). If it ever leaks, nothing restarts it.

**Fix:** add `max_memory_restart: '600M'` (~2.5× current RSS, leaving headroom
for the 17.7 s refresh pass). One-line, low risk.

### F4 — `/quoted` ships 1,018 KB — investigated, NOT a defect ✅

Root-caused and dismissed. It is not over-fetched data, it is grid *markup*: the
1,016 KB payload contains 5,362 `className` and 5,123 `children` occurrences and
10,167 Tailwind utility strings, against only 54 `customer` and 55 `startDate`
values. That is the serialized React tree for a genuinely large server-rendered
table (jobs × 17 sections, each cell carrying its own classes) — not a payload
carrying anything unused, which is what made F1 a bug.

Reducing it would mean virtualizing the grid, i.e. converting a server-rendered
table into a client one. That trades a 240 ms server-rendered first paint for a
JS-dependent one, which §10's "do not lazy-load critical UI if it makes the app
feel slower" warns against. At 1 MB delivered in ~240 ms it is inside the §18
navigation budget. **No action.**

### F5 — `newProjectsEnteringMonth` over-fetches and rescans — partly FIXED ✅

`src/lib/standard-pool-local.ts:105` loads **every** typed job with a
`startDate`, then discards all but one month's worth in JS
(`jobs.filter(...)`), then for each surviving job rescans the *entire*
`estimatedHours` array (`for (const job of entering) { for (const e of est) }`).

**Fix:** group `est` by `jobId` into a `Map` once — behaviour-identical. A DB-side
month filter would also help but risks a timezone-boundary shift in `monthOf()`,
so it needs care.

**Impact:** small at current data volumes; grows with job count.

### Non-findings — verified already optimized

Recorded so they are not re-investigated:

- **Client/Server boundaries are correct.** Zero `page.tsx` files are Client
  Components; every route entry is a Server Component, with 136 client *leaf*
  components. (`grep 'use client'` reports 144 files but only 136 have it as an
  actual directive — the rest match the phrase inside comments, including
  `(app)/layout.tsx`, which is an async Server Component.)
- **The two 1 MB dependencies are already code-split** behind `next/dynamic`:
  echarts (1,104 KB chunk) and ag-grid (1,061 KB), referenced as `import type`
  elsewhere. Total `.next/static` is 4.5 MB.
- **The Paylocity/Excel path is already tuned**, with figures in its own
  comments: ~12,600-row workbook ≈ 900 ms; an `onlyMonth` option cut a refresh
  5 s → 0.75 s; `prefetchedRows`/`prefetchedPoolHours` thread one shared parse
  through the whole pass instead of re-reading.
- **The per-row DB round-trips in `sync-actuals.ts` are deliberate**, not an N+1
  bug — see that file's comments at lines 284–306 and 377–380: the per-row
  `etcEntry` reads guard against the month being Submitted/Locked mid-sync and
  must not read a stale snapshot. Batching them naively breaks a documented
  concurrency guarantee.
- **`.next-verify*` are live dev tooling**, not stale build output, despite being
  ~138 MB — referenced in `.claude/launch.json`, `tsconfig.json`, `.gitignore`,
  and marked KEEP in `docs/CLEANUP_PHASE1_INVENTORY.md:346`.

---

## 3. Where effort should go

**Done in this pass:** F1 (−65.8% on the heaviest payload), F3, F5, and F2's
waterfall. F4 was investigated and dismissed as a non-defect.

**Next, in value order:**

1. **F1 remainder** — the surviving ~1,860 KB is `assemblies`/`blockers`/
   `upcoming`, genuinely read cross-job at first paint by the Insights panel.
   Cutting it means moving those aggregations server-side and lazy-loading
   per-job detail. This is the one remaining item worth a dedicated refactor,
   and it needs before/after equality checks on every panel because it touches
   code producing displayed operational figures.
2. **A concurrent-user load test** — see §5. Every figure here is single-session
   at ~1.5 req/min, so this is the largest blind spot, not a refinement.
3. **A client render/hydration trace** on `/build-readiness` and `/etc`. Given
   §0, remaining user-perceived slowness most likely lives here, and payload
   figures alone cannot see it.

Explicitly *not* worth doing: a general memoization sweep, a bundle-splitting
pass, or an N+1 hunt. §2's non-findings show those are done or deliberate.

---

## 4. How to re-measure

Route baseline (§1), from an authenticated browser session:

```js
(async () => {
  const routes = ["/", "/employees", "/quoted", "/etc", "/job-hours",
    "/job-cost-explorer", "/hours", "/tm", "/build-readiness", "/cash-flow",
    "/jobs", "/audit-log"];
  const out = [];
  for (let pass = 0; pass < 3; pass++) for (const r of routes) {
    const t0 = performance.now();
    const res = await fetch(r, { headers: { RSC: "1" }, cache: "no-store" });
    const ttfb = performance.now() - t0;
    const buf = await res.arrayBuffer();
    out.push({ pass, r, status: res.status, ttfb: Math.round(ttfb),
      total: Math.round(performance.now() - t0),
      kb: Math.round(buf.byteLength / 1024) });
  }
  console.table(out);
})();
```

Discard pass 0 (cold). Service TTFB (§1b): `curl` against `127.0.0.1`, not
`localhost`. Process baseline (§1d): `pm2 jlist` from an elevated shell.

---

## 5. Remaining work / known gaps

- **No concurrent-user load test.** All figures are single-session at ~1.5
  req/min. Behaviour under 10–20 simultaneous users is unmeasured, and it is the
  most likely place for an undiscovered problem.
- **No long-session memory trend.** A leak would show as `Heap Size` *total*
  climbing over days; one snapshot cannot show it. Sample `pm2 jlist` daily.
- **Client render/hydration not yet profiled.** Given §0, this is where remaining
  user-perceived slowness most likely lives — needs a Performance-panel trace on
  `/build-readiness` and `/etc`, not just payload figures.
- **The other six apps have route-level baselines only** (§1b), not per-page
  figures. `sdc-scheduler` in particular is unmeasured beyond its root route.
