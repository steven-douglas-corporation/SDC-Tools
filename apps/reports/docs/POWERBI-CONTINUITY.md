# Power BI / Fabric continuity — runbook

Written **2026-07-30**, corrected the same day. Companion to
[GRAPH-APP-ONLY-SETUP.md](GRAPH-APP-ONLY-SETUP.md), which covers the SharePoint
hours sync, and to [SEMANTIC-MODEL-MAP.md](SEMANTIC-MODEL-MAP.md), which inventories
what the app actually reads from the model.

> **Correction.** The first version of this document was built around a Power BI
> trial expiring in 2 days, read off the portal banner. **The trial is not
> expiring** — confirmed by the user. Every "2 days" deadline here was wrong, and
> the buy/migrate/accept decision below is not time-boxed. What remains real is
> the client secret, which nobody has checked.

## The one clock

| | window | consequence when it fires |
|---|---|---|
| **`PBI_CLIENT_SECRET` expiring** | **unknown — nobody has checked** | `runDax`, the Fabric warehouse path, and the pending SharePoint fix all stop. |

### Why the secret matters more than it looks

One secret authenticates **three** things:

1. `runDax` → the Power BI semantic model (`powerbi-client.ts`)
2. The Fabric Data Warehouse direct-SQL path (`fabric-warehouse.ts`)
3. The app-only Graph fix for the hours sync, once consented — it uses the same
   registration (`GRAPH_CLIENT_SECRET` = `PBI_CLIENT_SECRET`)

When it lapses, all three stop **on the same day**. TotalETO and the app's own
MySQL keep working, so the app will not look broken — it will look *stale*. That
is exactly the failure mode that went unnoticed from 2026-07-24 to 07-29.

**Action, five minutes, no approvals needed:** Entra admin centre →
**App registrations** → **SDC Sheet** → **Certificates & secrets** → read the
secret's **Expires** date. Put it in a calendar reminder 30 days early. Do this
before anything else in this document.

While there, consider swapping the secret for a **client certificate**: longer
lived, and not a copyable string sitting in `.env`. It's a small change to the
`ConfidentialClientApplication` config in both `powerbi-client.ts` and
`sharepoint-hours.ts` (`clientCertificate` instead of `clientSecret`).

---

## What actually depends on Power BI

Only three modules call `runDax`. This is the complete blast radius:

| caller | what it reads | if the model goes away |
|---|---|---|
| `sync-actuals.ts` | `[Cost Quoted]` → `Job.costQuoted`; category pools (`[Hours being pulled this month]`, `[Previous Month Pulled Hours]`, `[Hours Available]`, `[Rate]`, `[Standard Fee]`) | **Job cost budget + the Standard Fees pool panel stop updating.** Stored values persist. |
| `sync-etc-history.ts` | `[ETC Historical Hours/Costs]`, `…Prior Month`, `…Left`, `[ETC Name]`, `[ETC Begin Date]` | **Backfill only.** The 10 months already backfilled are in MySQL. Nothing live breaks. |
| `parts-budget-projection.ts` | `[Part Cost Estimated To Complete]` | **Nothing.** As of 2026-07-30 this is reconciliation-only — the projection was moved onto the app's own Parts New ETC. |

> **Second correction (2026-07-30).** An earlier version of this table listed
> `job-bom.ts` as a fourth caller reading the model's `Assembly` table, and said
> the BOM cost report would stop. **Wrong on both counts.** `job-bom.ts` imports
> `mssql` and queries TotalETO directly (`tblSpec`, `tblEngTop`,
> `tblPurchaseOrderDetails`, `tblReceiverLog`); it contains no `runDax` call. The
> model's `Assembly` table (37,341 rows) is a parallel copy the app never reads.
> The BOM report is unaffected by anything in this document.

What does **not** depend on Power BI at all: hours (SharePoint), parts cost
(TotalETO), the BOM cost report (TotalETO), the whole ETC month lifecycle,
employees, the Scheduler links.

So losing the model would degrade the app, not stop it: quoted hours, quoted
cost, the Standard Fees pools, and the history backfill. The daily ETC workflow
survives. See [SEMANTIC-MODEL-MAP.md](SEMANTIC-MODEL-MAP.md) for the
table-by-table detail behind this.

---

## If the model ever does become unavailable

Not a live deadline — the trial isn't expiring. Kept because the secret still
can, and because Option B is worth doing on its own merits.

### Option A — restore/keep the licence or capacity

Nothing in the code changes. What's actually needed: the workspace needs
**capacity**, and the service principal needs its workspace role (SDC Sheet is
already an Admin on `SDC Reports`) plus the tenant's *"service principals can use
Fabric APIs"* switch, which is already on. A per-user Pro licence is **not**
necessarily the same thing as a workspace's capacity — confirm with whoever owns
the tenant which SKU restores the `executeQueries` path.

### Option B — move to the Fabric warehouse (`fabric-warehouse.ts`)

`fabric-warehouse.ts` already exists, reads the **same warehouse the semantic
model imports from**, uses the same service principal with a
`database.windows.net`-scoped token, and was verified against the live warehouse
on 2026-07-19. **Nothing imports it** — it is finished, unwired code.

It removes the dataset's scheduled refresh and the gateway from the chain, which
is strictly fewer moving parts for the same data. What it has today:

- `getEtcPeriods()` → `dbo.EstimateToClosePeriod`
- `getEstimateToClose()` → the ETC/Standard-Fees history rows
- `queryWarehouse<T>(sql)` → arbitrary read-only T-SQL

**Important:** Option B is not an escape from *licensing* — the Fabric SQL
endpoint lives on the same capacity, so if capacity ever lapses this path lapses
with it. What B buys is resilience against **refresh and gateway** failure. Don't
confuse the two; that mistake is easy to make here.

### Option C — accept the degradation

Keep the stored values and lose the live quoted-cost sync and pool refresh.
Defensible, but it should be a decision rather than a default.

**Recommendation:** B, on your own schedule. It removes the refresh/gateway
fragility regardless of licensing, and the module is already written and tested —
it just has no callers.

---

## Verification — run these first, and after any change

Both scripts check each stage separately and name the one that failed, rather
than surfacing an opaque 401:

```bash
npx tsx scripts/check-powerbi-auth.ts
```

Checks: env vars → token → workspace visible → dataset visible →
`executeQueries` returns rows.

```bash
npx tsx scripts/check-graph-auth.ts
```

Checks: env vars → token → `roles` claim → site lookup → file download. Use this
to confirm the SharePoint consent landed *before* restarting anything.

**Run `check-powerbi-auth.ts` while things work**, so there's a known-good
baseline. Without one you can't tell a licensing failure from a secret expiry —
they present almost identically.

---

## Order of operations

Ordered by what's actually urgent — the live outage first, since nothing else
here is on a deadline.

1. **Get admin consent** for `Sites.Selected` (Step 1 of
   [GRAPH-APP-ONLY-SETUP.md](GRAPH-APP-ONLY-SETUP.md)), then Step 2's per-site
   grant, then the `GRAPH_*` env vars and a restart. **This fixes the live
   outage.** Needs an Entra admin plus someone with site admin /
   `Sites.FullControl.All`.
2. **Stopgap until 1 lands:** `pm2 kill`, then start PM2 from an interactive
   `akamuju` logon. Restores the hours sync until that session ends. Not a fix —
   log off and it breaks again. The other stopgap is the `Hours Actual` fallback
   in [SEMANTIC-MODEL-MAP.md](SEMANTIC-MODEL-MAP.md), which needs code but no
   approvals.
3. **Read the secret's expiry date** and set a reminder 30 days early. Five
   minutes, no approvals, removes the largest unquantified risk here.
4. **Run both check scripts** and keep the output as a baseline.
5. **Consider Option B** (the Fabric warehouse) whenever it suits — no deadline.
