'use strict';

// Read-only client for the SDC Projects Reports app's (apps/reports)
// server-to-server integration API.
//
// ── Why this app calls out instead of computing locally ─────────────────────
// The Delivery Slip / No Purchase Order / Upcoming Deliveries cards on the
// Readiness tab used to be derived in the browser from this app's own PO action
// list (bomTree.js buildPoActionList + findNoPoParts). They disagreed with the
// Reports app's Job Hours Details page — which is the accepted source of truth
// for these three insights — for every job, because this app's procurement
// model predates three rules the Reports app applies and this one does not:
//
//   1. BOM release status (tblEngProductStructure.BOMAssemblyReleaseID). An
//      "Assembly Only" parent is ONE purchase; its contents are not
//      requirements at all. This app explodes to leaves unconditionally, which
//      both double-counts the requirement and invents missing sub-parts nobody
//      will ever raise a PO for.
//   2. Inventory pulls (tblInventoryPullDetails) and in-house process
//      schedules (tblProcessScheduleHeader) are real coverage. This app's
//      `POQty === 0` test calls both a procurement gap.
//   3. "In hand" includes fulfilled inventory pulls, not just PO receipts.
//
// Fixing that here would mean porting several hundred lines of the Reports
// app's BOM rules into this codebase and keeping the two in step forever. The
// repo already has a precedent for the alternative — SDC_Scheduler/lib/
// plannerClient.js reads hours from the same integration API rather than
// re-deriving them — so this app follows it: the rules stay in one place and
// this app renders what it is told.
//
// Optional-integration contract, mirroring the Scheduler's client: CONFIGURED
// is false unless BOTH env vars are set, and callers get a clear
// "not configured" error rather than a silent empty result, so the feature
// stays dormant and visible-as-dormant until it is provisioned.
//
// Env:
//   ETC_PLANNER_URL        base URL of the Reports app, e.g. http://localhost:4006
//   SCHEDULER_SHARED_TOKEN bearer token; MUST match the Reports app's own value

const BASE = (process.env.ETC_PLANNER_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.SCHEDULER_SHARED_TOKEN || '';
const CONFIGURED = Boolean(BASE && TOKEN);

// Longer than the Scheduler client's 8s: this endpoint runs a full Total ETO
// BOM explosion plus the parts-cost query for the job, and the Reports app's
// own page budgets ~100s for the same two calls on a large job. A timeout here
// is a blank card, so it is worth waiting for.
const TIMEOUT_MS = 60000;

function assertConfigured() {
  if (!CONFIGURED) {
    throw new Error('Reports app integration not configured (set ETC_PLANNER_URL and SCHEDULER_SHARED_TOKEN)');
  }
}

async function call(path) {
  assertConfigured();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    if (res.status === 404) return { _status: 404 };
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Reports app ${res.status}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// The three risk cards for one job, exactly as the Reports app's Job Hours
// Details page computes them. `null` when the job has no BOM there (404),
// which is a real answer and not an error — the caller renders "no data"
// rather than falling back to a second set of numbers.
async function getProcurementRisk(jobId) {
  const data = await call(`/api/integration/jobs/${encodeURIComponent(jobId)}/procurement`);
  if (data && data._status === 404) return null;
  return data;
}

module.exports = { CONFIGURED, getProcurementRisk };
