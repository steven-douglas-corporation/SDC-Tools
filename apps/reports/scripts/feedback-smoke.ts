// Exercises the feedback backend against the REAL database, and prints the
// queue exactly as the grid will render it.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/feedback-smoke.ts
//
// ── Why this script exists ──────────────────────────────────────────────────
//
// Two questions no unit test can answer, because both are properties of the
// live schema rather than of the pure modules:
//
//   * does the INSERT actually accept what the Flag button builds? The row has
//     twelve nullable context columns with real width limits, and a payload
//     that overflows one of them fails at runtime (P2000) rather than at build
//     time, exactly like the case scripts/change-log-smoke.ts exists for.
//   * does the queue LOOK right? "What will this be like to use" is a question
//     about a populated grid, and an empty table cannot answer it.
//
// ── Why it rolls back ───────────────────────────────────────────────────────
//
// Every insert happens inside an interactive transaction that throws at the
// end, so no demonstration rows are left behind in a real feedback queue —
// the same constraint change-log-smoke.ts works under, for the same reason.
// It also calls the STORE (feedback-store.ts) rather than the server actions,
// deliberately: the actions publish to the realtime hub, and running them here
// would put fabricated "somebody filed feedback" banners in front of whoever
// is signed in right now.
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { buildFeedbackContext, describeContext } from "../src/lib/feedback-context";
import { splitRoute } from "../src/lib/split-view";
import {
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_SEVERITY_LABELS,
  FEEDBACK_CATEGORY_LABELS,
  canTransition,
  isFeedbackStatus,
  type FeedbackCategory,
  type FeedbackSeverity,
} from "../src/lib/feedback-status";
import { ROLES, hasPermission } from "../src/lib/permissions";
import { permissionForPath, safeFallbackPath } from "../src/lib/route-permissions";

const labelFor = (p: string) => splitRoute(p)?.label ?? null;

// One case per shape the Flag button can produce, written as the button writes
// them: a pane location in, a finished record out.
const CASES: {
  label: string;
  location: { path: string; params: Record<string, string> };
  who: { email: string; name: string };
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  fieldLabel: string | null;
  observed: string | null;
  expected: string | null;
  body: string;
}[] = [
  {
    label: "Left to Invoice dispute, flagged from Projects",
    location: { path: "/quoted", params: { customers: "ACME", statuses: "Active", actuals: "1" } },
    who: { email: "dana.pm@stevendouglas.com", name: "Dana (PM)" },
    category: "data-accuracy",
    severity: "wrong",
    fieldLabel: "Left to Invoice",
    observed: "$41,200",
    expected: "$0",
    body: "This job was fully invoiced in August but still shows a balance. I think the stock-pulled parts are being counted twice.",
  },
  {
    label: "ETC hours complaint, flagged from a workspace tab",
    location: { path: "/etc", params: { month: "2026-08", dept: "ENG" } },
    who: { email: "sam.mgr@stevendouglas.com", name: "Sam (Manager)" },
    category: "data-accuracy",
    severity: "blocking",
    fieldLabel: "New ETC",
    observed: "320",
    expected: "180",
    body: "Engineering ETC for August is nearly double what the team submitted. Can't close the month against this.",
  },
  {
    label: "Job Details, single job deep link",
    location: { path: "/job-hours", params: { job: "1131" } },
    who: { email: "dana.pm@stevendouglas.com", name: "Dana (PM)" },
    category: "data-accuracy",
    severity: "wrong",
    fieldLabel: "Hours Pulled",
    observed: "1,204",
    expected: "1,190",
    body: "Fourteen hours on here belong to 1105 — looks like a mis-punched job code last Friday.",
  },
  {
    label: "A suggestion, so the non-accuracy path is exercised too",
    location: { path: "/cash-flow", params: { as: "2026-09" } },
    who: { email: "sam.mgr@stevendouglas.com", name: "Sam (Manager)" },
    category: "enhancement",
    severity: "cosmetic",
    fieldLabel: null,
    observed: null,
    expected: null,
    body: "Could this default to the current month instead of the last one I looked at?",
  },
  {
    label: "Width check — a pasted value longer than the column allows",
    location: { path: "/job-cost-explorer", params: { asOf: "2026-08-31" } },
    who: { email: "sam.mgr@stevendouglas.com", name: "Sam (Manager)" },
    category: "bug",
    severity: "cosmetic",
    fieldLabel: "A".repeat(80), // VARCHAR(64)
    observed: "B".repeat(250), // VARCHAR(191)
    expected: null,
    body: "Deliberately oversized values — the clamps in feedback-actions.ts must cut these before MySQL refuses the row.",
  },
];

const clamp = (v: string | null, max: number): string | null => {
  if (!v) return null;
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
};

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

async function main() {
  console.log("\n══ 1. Permissions, as the matrix will answer them ══════════════════\n");
  const keys = ["feedback:submit", "feedback:view", "feedback:triage"] as const;
  console.log(`${pad("role", 10)}${keys.map((k) => pad(k.replace("feedback:", ""), 10)).join("")}`);
  for (const role of ROLES) {
    console.log(`${pad(role, 10)}${keys.map((k) => pad(hasPermission(role, k) ? "yes" : "—", 10)).join("")}`);
  }
  console.log(`\n/feedback is gated on: ${permissionForPath("/feedback")}`);
  // The trap tests/permissions.test.ts pins — printed so it is visible here too.
  console.log("Permission-denied fallbacks (none may be /feedback):");
  for (const role of ROLES) console.log(`  ${pad(role, 10)} -> ${safeFallbackPath(role)}`);

  console.log("\n══ 2. Context capture, per case ════════════════════════════════════\n");
  for (const c of CASES) {
    const ctx = buildFeedbackContext(c.location, labelFor);
    console.log(`${c.label}`);
    console.log(`  url in    ${ctx.routePath}?${new URLSearchParams(c.location.params).toString()}`);
    console.log(`  view      ${ctx.viewLabel ?? "(unregistered)"}`);
    console.log(`  filters   ${describeContext(ctx.params) || "(none)"}`);
    console.log(`  job/month ${ctx.jobId ?? "—"} / ${ctx.periodMonth ?? "—"}`);
    console.log(`  back link ${ctx.contextUrl}\n`);
  }

  console.log("══ 3. Writing to the real table (inside a transaction that rolls back) ══\n");

  let printed = false;
  try {
    await prisma.$transaction(async (tx) => {
      const ids: number[] = [];
      for (const c of CASES) {
        const ctx = buildFeedbackContext(c.location, labelFor);
        const row = await tx.feedback.create({
          data: {
            submittedById: null,
            submitterEmail: c.who.email,
            submitterName: c.who.name,
            sourceApp: "reports",
            submittedVia: "ui",
            routePath: ctx.routePath,
            viewLabel: ctx.viewLabel,
            params: ctx.params,
            contextUrl: ctx.contextUrl,
            subjectType: ctx.jobId ? "job" : null,
            subjectKey: ctx.jobId,
            jobId: ctx.jobId,
            periodMonth: ctx.periodMonth,
            employeeKey: ctx.employeeKey,
            // The same clamps feedback-actions.ts applies. If these are wrong,
            // the oversized case above fails here with P2000.
            fieldLabel: clamp(c.fieldLabel, 64),
            observedValue: clamp(c.observed, 191),
            expectedValue: clamp(c.expected, 191),
            body: c.body,
            category: c.category,
            severity: c.severity,
            status: "open",
          },
        });
        ids.push(row.id);
      }
      console.log(`  inserted ${ids.length} rows — every context column accepted.\n`);

      // ── Triage, end to end ──────────────────────────────────────────────
      const target = ids[0];
      const refusal = canTransition("open", "fixed", "");
      console.log(`  closing with no note   -> ${refusal.ok ? "ALLOWED (BUG)" : `refused: ${refusal.error}`}`);
      const allowed = canTransition("open", "fixed", "Stock-pulled parts were double counted.");
      console.log(`  closing with a note    -> ${allowed.ok ? "allowed" : `refused: ${allowed.error}`}`);

      await tx.feedback.update({ where: { id: target }, data: { status: "ack", acknowledgedAt: new Date() } });
      await tx.feedback.update({
        where: { id: target },
        data: {
          status: "fixed",
          resolutionNote: "Confirmed — stock-pulled parts were counted twice. Fixed in the 2026-09-17 release.",
          resolvedAt: new Date(),
          resolvedByEmail: "mvest@sdcautomation.com",
          assignedToEmail: "mvest@sdcautomation.com",
        },
      });

      // ── The queue, as the grid will render it ───────────────────────────
      const rows = await tx.feedback.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      console.log("\n══ 4. The queue, as the grid renders it ════════════════════════════\n");
      console.log(
        `${pad("Status", 14)}${pad("Urgency", 13)}${pad("View", 16)}${pad("Job", 7)}${pad("Period", 9)}${pad("Field", 18)}${pad("Shows", 12)}${pad("Should be", 12)}${pad("From", 18)}`,
      );
      console.log("─".repeat(119));
      for (const r of rows) {
        const status = isFeedbackStatus(r.status) ? FEEDBACK_STATUS_LABELS[r.status] : r.status;
        console.log(
          pad(status, 14) +
            pad(FEEDBACK_SEVERITY_LABELS[r.severity as FeedbackSeverity] ?? r.severity, 13) +
            pad(r.viewLabel ?? r.routePath ?? "—", 16) +
            pad(r.jobId ?? "—", 7) +
            pad(r.periodMonth ?? "—", 9) +
            pad(r.fieldLabel ?? "—", 18) +
            pad(r.observedValue ?? "—", 12) +
            pad(r.expectedValue ?? "—", 12) +
            pad(r.submitterName ?? r.submitterEmail, 18),
        );
      }

      console.log("\n══ 5. One row in full, as the detail drawer shows it ════════════════\n");
      const detail = rows.find((r) => r.id === target)!;
      console.log(`  Feedback #${detail.id}   ${FEEDBACK_STATUS_LABELS[detail.status as never] ?? detail.status}`);
      console.log(`  From          ${detail.submitterName} <${detail.submitterEmail}>`);
      console.log(`  Kind          ${FEEDBACK_CATEGORY_LABELS[detail.category as FeedbackCategory] ?? detail.category}`);
      console.log(`  Where they were  ${detail.viewLabel}`);
      console.log(`  Filters       ${describeContext((detail.params as Record<string, string>) ?? {}) || "(none)"}`);
      console.log(`  Back link     ${detail.contextUrl}`);
      console.log(`  Field         ${detail.fieldLabel}`);
      console.log(`  Shows         ${detail.observedValue}`);
      console.log(`  Should be     ${detail.expectedValue}`);
      console.log(`  What they said\n                ${detail.body}`);
      console.log(`  Response\n                ${detail.resolutionNote}`);
      console.log(`  Assigned to   ${detail.assignedToEmail}`);

      console.log("\n══ 6. Width clamps ═════════════════════════════════════════════════\n");
      const wide = rows.find((r) => (r.fieldLabel ?? "").startsWith("AAA"))!;
      console.log(`  fieldLabel    ${wide.fieldLabel!.length} chars (column allows 64)`);
      console.log(`  observedValue ${wide.observedValue!.length} chars (column allows 191)`);

      printed = true;
      // Roll back. Nothing above survives this line.
      throw new Error("__rollback__");
    });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "__rollback__") throw err;
  }

  if (!printed) throw new Error("the transaction body did not complete");

  const left = await prisma.feedback.count();
  console.log(`\n══ 7. Rolled back ══════════════════════════════════════════════════\n`);
  console.log(`  rows remaining in the feedback table: ${left}\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
