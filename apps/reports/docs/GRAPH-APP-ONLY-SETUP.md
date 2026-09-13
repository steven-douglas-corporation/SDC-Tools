# App-only Graph auth for the hours sync — setup runbook

> **STATUS 2026-07-31 — NO LONGER URGENT. The sync is back up by another route.**
> `fetchJobHoursRows()` now reads the OneDrive-synced copy of the export from
> local disk (`JOB_HOURS_LOCAL_PATH`) and only falls back to Graph. Reading a
> file needs no token, so the sync works from session 0 **without** the consent
> below. Verified zero-delta against the Graph download (2026-07 Engineering
> 2368.85 / Shop 2526.38). See §12 of `DEVLOG.md`.
>
> **Do this anyway when an admin is available.** The OneDrive route trades an
> auth failure for silent staleness: it depends on the sync client running in
> `akamuju`'s interactive session, so a logoff quietly ages the file — the same
> failure class it fixed. It also depends on the folder staying pinned "Always
> keep on this device"; unpinned it is a placeholder a service cannot hydrate.
> App-only auth has neither dependency, which is why it remains the real fix.
>
> **The blocker is unchanged and is one click: admin consent, Step 1.**
> `Sites.Selected` is already added to the registration and still shows
> "Not granted for Steven Douglas Corp".
>
> <details><summary>Prior status (2026-07-30), kept for the failure signature</summary>
>
> Last successful sync: **2026-07-29 19:56:28**. Failing every 10 minutes since;
> 258 `Cannot decrypt … Error code: 3` entries across the PM2 error logs. A
> user-triggered Refresh on Monthly ETC now surfaces it as "Submission rejected"
> (digest `100648713`, `etc-actions.ts:447` → `sync-actuals.ts:18` →
> `sharepoint-hours.ts:113`) instead of silently ageing the numbers.
> </details>
>
> For the Power BI / Fabric side (secret expiry, fallback plan, warehouse option),
> see [POWERBI-CONTINUITY.md](POWERBI-CONTINUITY.md).

**Why:** the SharePoint hours sync currently borrows a *user's* cached login
(`akamuju`, via `sdc-powerbi-mcp.exe login`). That cache is DPAPI-encrypted under
`DataProtectionScope.CurrentUser`, so it can only be decrypted from that user's
own logged-on Windows session. Consequences, all of which have actually bitten:

- A process in Windows **session 0** (PM2 started as a service, a scheduled
  task, or a daemon respawned by anything in session 0) cannot read it. This
  silently killed every hours + parts sync from **2026-07-24 to 2026-07-29**,
  again on **2026-07-29 12:13**, and again from **2026-07-29 19:56 onward** —
  the outage that is live as of this writing. Three occurrences in a week is the
  argument: this is not an incident, it's the design.
- **Logging off** ends the session and unloads the DPAPI keys — sync stops.
- The delegated **refresh token expires** eventually (inactivity / CA policy), so
  someone must re-run `sdc-powerbi-mcp.exe login` by hand.
- Making PM2 survive a reboot normally means a service or startup task — which
  runs in session 0, i.e. the first bullet. So today it's **reboot-survival or a
  working sync, not both.**

App-only (client credentials) auth removes all four: no user, no session, no
cache file. The token is fetched per process and held in memory, so it works as a
service, in session 0, and after a reboot, indefinitely.

**The code is already written and dormant** — `getGraphToken()` in
`src/lib/sharepoint-hours.ts` tries app-only when the `GRAPH_*` env vars are
present and otherwise falls back to today's delegated cache. Nothing changes
until step 4 below.

---

## What the admin needs to do

### Facts to hand them

| | |
|---|---|
| Registration | **SDC Sheet** (already exists, already has 1 client secret) |
| Tenant ID | `e3a8e745-b074-48df-9208-928c7de6dcc6` |
| Application (client) ID | `6ec09511-0e91-4354-b7cc-2eb735a02ba6` |
| Permission requested | Microsoft Graph → **Application** → `Sites.Selected` |
| Scoped to | `https://stevendouglascorp.sharepoint.com/sites/SDC-PowerBIIntegration` ("SDC- Power BI Integration") |
| Access level | **read** |
| What it reads | one file: `Project Planner V2/Job Hours Report/Job Hours From Paylocity/Current_Job_Hours.xlsx` |

This app registration **already exists** — it's the service principal the app uses
for the Power BI REST API (`PBI_CLIENT_ID` in `.env`). No new registration is
needed. It currently holds **no** Graph application permissions: it acquires a
Graph token fine, but the token's `roles` claim is empty, so
`GET /v1.0/sites/{...}` returns `401 spException` (verified 2026-07-29).

### Step 1 — add the permission and consent

**Status 2026-07-29: `Sites.Selected` (Application) is already ADDED to SDC Sheet
but shows "Not granted for Steven Douglas Corp" — the consent click is the
blocker, and the button is greyed out for a non-admin.**

Entra admin centre → **App registrations** → the app above →
**API permissions** → *Add a permission* → **Microsoft Graph** →
**Application permissions** → search `Sites.Selected` → *Add permissions* →
then **Grant admin consent for Steven Douglas Corp**.

While there, two entries on SDC Sheet can be **removed** — both are Application
permissions, both far broader than this needs, and neither is used by any code
path here:

- **SharePoint → `Sites.Read.All`** — that's the legacy SharePoint API, not
  Graph. This app only ever calls Graph, so it grants nothing useful while
  reading every site collection in the tenant.
- **Power BI Service → `Tenant.Read.All`** — Power BI does not gate DAX queries
  on app permissions (see the Power BI section at the bottom: workspace role +
  tenant setting is what matters, and both are already in place). This only
  serves admin-reporting endpoints the app never calls.

Leaving them on the request makes it look like a tenant-wide read ask, which is a
much harder approval than "read one file on one site".

`Sites.Read.All` also works but reads **every** site in the tenant.
`Sites.Selected` grants nothing on its own — which is exactly why it's the safe
choice, and why step 2 is mandatory.

### Step 2 — grant this app `read` on that one site

`Sites.Selected` is a *capability*; the actual access is granted per site, and
**not through the portal**. Either method works, run by someone with site
admin / `Sites.FullControl.All`:

**Graph Explorer** (https://developer.microsoft.com/graph/graph-explorer),
signed in as an admin who has consented `Sites.FullControl.All` there:

```
POST https://graph.microsoft.com/v1.0/sites/stevendouglascorp.sharepoint.com,17e2ef50-dee9-4e46-b723-eaeda5b9f529,9e63b969-5ec9-4183-ab6a-447223f9dc15/permissions
Content-Type: application/json

{
  "roles": ["read"],
  "grantedToIdentities": [
    { "application": { "id": "6ec09511-0e91-4354-b7cc-2eb735a02ba6", "displayName": "SDC Power BI integration" } }
  ]
}
```

**or PnP PowerShell:**

```powershell
Connect-PnPOnline -Url https://stevendouglascorp.sharepoint.com/sites/SDC-PowerBIIntegration -Interactive
Grant-PnPAzureADAppSitePermission -AppId 6ec09511-0e91-4354-b7cc-2eb735a02ba6 `
  -DisplayName "SDC Power BI integration" -Site https://stevendouglascorp.sharepoint.com/sites/SDC-PowerBIIntegration `
  -Permissions Read
```

### Step 3 — credentials

SDC Sheet already has **1 secret, 0 certificates**, and its value is the
`PBI_CLIENT_SECRET` already in `.env` — so nothing new is strictly required. Two things worth raising while the admin is in there:

- **Check the secret's expiry.** When it lapses, both this sync *and* the Power
  BI refresh helpers stop. `scripts/check-graph-auth.ts` reports it as a
  token-acquisition failure.
- **A client certificate is preferable to a secret** — longer-lived and not a
  copyable string in `.env`. Swapping to one is a small change to the
  `ConfidentialClientApplication` config (`clientCertificate` instead of
  `clientSecret`).

---

## Step 4 — our side, once the grant lands

Add to `.env` (same values as the existing `PBI_*` vars):

```
GRAPH_TENANT_ID=e3a8e745-b074-48df-9208-928c7de6dcc6
GRAPH_CLIENT_ID=6ec09511-0e91-4354-b7cc-2eb735a02ba6
GRAPH_CLIENT_SECRET=<same as PBI_CLIENT_SECRET>
```

They're deliberately separate vars rather than reusing `PBI_*` directly: those
are already populated, so reusing them would have switched app-only on before the
grant existed, breaking a sync that worked.

Verify **before** restarting anything:

```bash
npx tsx scripts/check-graph-auth.ts
```

It checks each stage separately and names the missing one — env vars, token,
`roles` claim, site lookup, file download. All five OK means app-only is live.

Then:

```bash
pm2 restart sdc-reports
```

Confirm the next auto-sync tick logs `[auto-sync] Actual hours (SharePoint): …`
with no warning. If app-only fails for any reason it logs
`app-only Graph auth failed, falling back to the delegated token cache` and keeps
working the old way — a half-finished rollout can't take the sync down.

---

## The Power BI side — already done, no admin needed

`runDax` in `src/lib/powerbi-client.ts` (Sync History, pool backfills, the BOM
cost report) now uses the **same app-only pattern** and it is **live**, because
both Power BI prerequisites already happen to be satisfied:

- **SDC Sheet is an Admin on the `SDC Reports` workspace** (visible in the
  workspace's *Manage access* pane).
- The tenant's **"service principals can use Fabric APIs"** switch is already on
  — inferred from the fact that the calls succeed; nothing in code can check it.

Verified 2026-07-29 with `scripts/check-powerbi-auth.ts` — workspace visible,
dataset (`Job Hours Report - Management Level`) visible, `executeQueries`
returning real rows. Then proven again by calling `runDax` with the DPAPI cache
path deliberately made unreadable: it still returned 30,924 rows from
`'Hours Actual'`, so that path genuinely no longer needs an interactive session.

```bash
npx tsx scripts/check-powerbi-auth.ts
```

Two things to keep in mind:

- **Service-principal queries bypass row-level security.** Delegated queries ran
  as the signed-in user, so RLS applied. An app identity sees the whole model.
  Fine for the ETC rollups this app reads; relevant if anything user-scoped is
  added later.
- **Licensing is separate from auth.** A portal banner about a Power BI trial is
  about capacity, not credentials — app-only auth doesn't change it either way.
  (An earlier version of this note treated a "trial ends in 2 days" banner as
  urgent. It isn't expiring; that was a misread. See
  [POWERBI-CONTINUITY.md](POWERBI-CONTINUITY.md).)

So after Step 4, `sharepoint-hours.ts` is the **last** consumer of the DPAPI
cache. Once `Sites.Selected` is consented, nothing in this app depends on an
interactive Windows session.

## Stopgap if the request stalls

Keep PM2 under an interactive logon (`pm2 kill && pm2 resurrect` from that
session), or run PM2 via `nssm` **as the `akamuju` account** — a service running
as a named user loads that user's profile, so `CurrentUser` DPAPI generally
works and it survives reboot and logoff. Caveats: the account password lives in
the service config, and the delegated token still expires. Better than "never log
off", not a real fix. Test it before relying on it.
