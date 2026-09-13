# Troubleshooting

Common failure modes, what actually causes them in this app, and where to look. Several of
these are drawn from real, documented incidents in `DEVLOG.md` rather than hypothetical
scenarios — that section number is given so you can read the full incident writeup.

## Paylocity refresh not updating hours

Check, in order:
1. **Is the refresh actually running?** The dashboard's "Refresh Schedule" card shows the last
   run time per source. If `hours_actual` hasn't run recently, check whether the hourly timer
   is alive (a server restart resets it — see [REFRESH-PIPELINE.md](REFRESH-PIPELINE.md)) or
   click "Refresh Data" manually.
2. **Is the workbook file actually updated?** Import is content-hash-based
   (`src/lib/paylocity-workbook.ts`) — if the file on disk hasn't changed, re-running the
   import is correctly a no-op, not a bug.
3. **Is the file a OneDrive placeholder, not the real content?** A file that hasn't hydrated
   from OneDrive yet reads as empty/corrupt and aborts the import (logged to `PaylocityImport`
   with a failure reason) rather than silently importing zero rows.
4. **Check `HoursImportIssue`/`UndefinedHoursRow`** — a row that failed to map (bad date, unknown
   job, unmapped section) is logged there, not applied. This is often "why is job X missing an
   hour" rather than a sync failure.

## Total ETO mismatch

- First confirm which formula the number you're checking against actually is — see
  [ETC-BUSINESS-LOGIC.md §7](ETC-BUSINESS-LOGIC.md#7-parts-cost). The monthly "Money Spent"
  figure and the Projects grid's lifetime "Parts Cost Actual" column are **deliberately
  different measures** (AP-document-date monthly booking vs. an unwindowed snapshot) — a
  mismatch between them is not automatically a bug.
- If the monthly figure disagrees with Total ETO's own report for the same month, check whether
  a credit memo/negative line is involved — the app's formula nets credits rather than excluding
  them, so a difference here often means the comparison report handled the credit differently.
- If a page shows "Parts Cost is unavailable" — that's the timeout budget in
  [INTEGRATIONS.md](INTEGRATIONS.md#total-eto) firing because Total ETO responded too slowly
  (not necessarily down). It self-resolves once Total ETO recovers; no app-side action needed.

## Realtime disconnected

- Confirm only **one** PM2 instance of this app is running — the realtime hub's presence/change
  state is in-process memory and does not work across multiple instances (see
  [REALTIME-SYNC.md](REALTIME-SYNC.md)). This is the first thing to check if realtime seems to
  work for some users and not others.
- A single tab losing its connection (network blip, laptop sleep) should recover on its own —
  `RealtimeProvider.tsx` reconnects with exponential backoff and requests a full refresh on
  reconnect. If it doesn't recover after a minute or two, a hard reload is the correct move —
  missed events during a disconnect are never replayed by design.
- If it's *everyone*, check the server process itself, not the client — this isn't a
  browser-side caching issue.

## Stale KPI/drill-through data

- The KPI strip and its drill-throughs run **separate queries**, not one shared computation
  (see [DATA-FLOW.md §KPI / drill-through data](DATA-FLOW.md#kpi--drill-through-data)) — if
  they briefly disagree after an edit, confirm both have had a chance to re-render before
  assuming a bug.
- If a number looks stale after a refresh, distinguish "the refresh hasn't run yet" from "the
  page hasn't re-rendered" — check the dashboard's last-refreshed timestamp before suspecting
  the calculation itself.

## Failed auto-save

- Grid saves use optimistic concurrency (see
  [REALTIME-SYNC.md §Conflict handling](REALTIME-SYNC.md#conflict-handling)) — a save can be
  **deliberately refused**, not failed, if the cell was changed by someone else since this tab
  last saw it. This surfaces as a conflict message with the believed/actual/wanted values, not
  a generic error; reload the cell's current value and retype rather than retrying blindly.
- If saves are failing outright (not just conflicting), check the browser console for the
  Server Action's error — and check whether the month is **locked**: `etc-actions.ts` explicitly
  refuses to write to a locked month's `EtcEntry` rows, which is correct behavior, not a bug.

## Incorrect totals

Before assuming a formula is wrong, check which of these it actually is — they look similar but
have different causes historically:

- **Wrong scope** — summing "every entry in the month" instead of the eligible subset (see
  [ETC-BUSINESS-LOGIC.md §9](ETC-BUSINESS-LOGIC.md#9-submission-readiness) and
  §10's off-grid distinction). A total that includes rows for a job no longer on the grid will
  disagree with what's visibly summed on screen.
- **Wrong formula version** — `sync-totaleto.ts` still contains two superseded parts-cost
  functions alongside the current one (see
  [ETC-BUSINESS-LOGIC.md §7](ETC-BUSINESS-LOGIC.md#7-parts-cost)); confirm which one actually
  fed the number you're checking.
- **A genuinely undecided cell** — the Total New ETC rollup is all-or-nothing
  ([ETC-BUSINESS-LOGIC.md §5](ETC-BUSINESS-LOGIC.md#5-total-new-etc-rollup)); a blank total
  usually means one required cell in that group hasn't been answered yet, not a calculation
  error.

## Slow filters / navigation

- If a specific page feels slow, check whether it's making a **live** upstream call — the Job
  Hour Details / Procurement page is the one page that queries Total ETO live per request (see
  [INTEGRATIONS.md](INTEGRATIONS.md#total-eto)); everything else reads this app's own database.
- Grid filters (department/job-name visibility, drill-through filters) are client-side and
  should be instant — if one feels slow, that's a UI regression worth reporting, not an
  expected upstream dependency.

## Submission blocked

Read the readiness message on screen first — it names the specific blocker in priority order
(department sign-off → missing New ETC → invalid hours → Standard Sheet pools; see
[ETC-BUSINESS-LOGIC.md §9](ETC-BUSINESS-LOGIC.md#9-submission-readiness)). Common
mis-diagnoses:

- **"A job I don't even see is blocking submission"** — should not happen since the §68 fix
  scoped the gate to grid-eligible jobs only; if it does, that's a regression worth reporting
  with the specific job number.
- **A cell shows blank but you didn't touch it** — an undecided rollup cell reads as blank by
  design (all-or-nothing rollup, §5 above), not as "already answered as zero."

## Deploy-related ("the site looks fine but my change isn't there")

This is almost always the PM2-doesn't-release-the-port issue — see
[DEPLOYMENT.md](DEPLOYMENT.md#the-one-thing-that-will-bite-you-pm2-does-not-reliably-kill-this-process-on-windows).
`/api/health` returning `200` does **not** rule this out.

## "Failed to load chunk" / stale-tab errors

A tab left open across a deploy or rebuild is running a build manifest the server no longer
serves. Both app-wide error boundaries detect this specific case (`src/lib/stale-bundle.ts`)
and offer a **Reload the page** button rather than the generic "Try again" — if you see this,
reload; it is not a rejected submission or a data error, whatever the surrounding text might
otherwise suggest on an older build.
