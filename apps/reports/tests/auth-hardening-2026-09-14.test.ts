import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { permissionForPath, ROUTE_PERMISSIONS } from "../src/lib/route-permissions";
import { hasPermission, setOwnPermissions, ROLES, type AppRole, type Permission } from "../src/lib/permissions";

// The parts of the 2026-09-14 auth hardening that are not a pure function:
// each is pinned by reading the source it lives in, the same way
// tests/hours-source-boundary.test.ts and others in this directory guard a
// wiring decision that a refactor could silently undo.

const src = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");

// ── Finding 1: role changes reach an open session ───────────────────────────

test("auth.ts's jwt callback re-reads the role on the existing-session branch and fails closed", () => {
  const auth = src("lib/auth.ts");
  assert.match(auth, /import \{ currentUserRole \} from "@\/lib\/session-role"/);
  // The refresh must sit AFTER the version check and BEFORE `return token`.
  const branch = auth.slice(auth.indexOf("} else if (token.sub) {"), auth.indexOf("return token;"));
  assert.match(branch, /const role = await currentUserRole\(userId\);/);
  assert.match(branch, /if \(role === null\) return null;/);
  assert.match(branch, /token\.role = role;/);
});

test("setUserRole bumps tokenVersion in the same statement and clears both caches", () => {
  const s = src("lib/user-role-actions.ts");
  assert.match(s, /UPDATE User SET role = \$\{role\}, tokenVersion = tokenVersion \+ 1 WHERE id = \$\{userId\}/);
  assert.match(s, /invalidateTokenVersionCache\(userId\);/);
  assert.match(s, /invalidateUserRoleCache\(userId\);/);
  // And there is now an activate/deactivate control for the pending-activation flow.
  assert.match(s, /export async function setUserActive\(userId: number, active: boolean\)/);
  assert.match(s, /UPDATE User SET active = 0, tokenVersion = tokenVersion \+ 1/);
});

// ── Finding 2: /jobs is gated like /quoted ───────────────────────────────────

test("/jobs and /jobs/[id] resolve to projects:view", () => {
  assert.equal(permissionForPath("/jobs"), "projects:view");
  assert.equal(permissionForPath("/jobs/123"), "projects:view");
  assert.equal(permissionForPath("/jobs?status=Active"), "projects:view");
  assert.ok(ROUTE_PERMISSIONS.some((r) => r.path === "/jobs" && r.permission === "projects:view"));
});

test("every role that can see the Dashboard (which links to /jobs) can also open /jobs — no dead links", () => {
  // Under the shipped defaults. A live matrix can differ, but the default is
  // what a fresh deploy and the DB-unreachable fallback both run on.
  const defaults: Record<AppRole, readonly Permission[]> = {
    ALL: ["job-hour-details:view", "job-hour-details:schedule", "build-readiness:view", "monthly-etc:view", "monthly-etc:edit", "monthly-etc:submit"],
    MANAGER: ["job-hour-details:view", "dashboard:view", "projects:view"],
    PM: ["job-hour-details:view", "dashboard:view", "projects:view"],
    SALES: ["job-hour-details:view", "dashboard:view", "projects:view", "projects:edit"],
    ELT: [],
  };
  setOwnPermissions(defaults);
  for (const role of ROLES) {
    if (hasPermission(role, "dashboard:view")) assert.equal(hasPermission(role, "projects:view"), true, role);
  }
  // …and the base tier, which has neither, is now kept out of /jobs by proxy.ts.
  assert.equal(hasPermission("ALL", permissionForPath("/jobs")!), false);
});

test("both /jobs pages call requirePagePermission(\"projects:view\")", () => {
  assert.match(src("app/(app)/jobs/page.tsx"), /await requirePagePermission\("projects:view"\);/);
  assert.match(src("app/(app)/jobs/[id]/page.tsx"), /await requirePagePermission\("projects:view"\);/);
});

test("every inline write on /jobs/[id] is permission-checked, month-lock-checked, validated and audited", () => {
  const page = src("app/(app)/jobs/[id]/page.tsx");
  const actions = ["addEntry", "confirmEntry", "overrideMonthlyActualHours", "revertOverride"];
  for (const name of actions) {
    const start = page.indexOf(`async function ${name}(formData: FormData) {`);
    assert.ok(start > 0, `${name} exists`);
    const body = page.slice(start, page.indexOf("revalidatePath(`/jobs/${jobId}`);", start));
    assert.match(body, /"use server";/, `${name} is a server action`);
    assert.match(body, /await assertActionPermission\("monthly-etc:edit"\);/, `${name} permission`);
    assert.match(body, /await assertEtcMonthUnlocked\(/, `${name} month lock`);
    assert.match(body, /await logAudit\(/, `${name} audit`);
    assert.match(body, /await recordChanges\(/, `${name} change log`);
    assert.doesNotMatch(body, /Number\(formData\.get\(/, `${name} no raw Number(formData.get(...))`);
    assert.match(body, /parse(AddEntryInput|ConfirmEntryInput|OverrideHoursInput|RowId)\(/, `${name} validated input`);
  }
  // Row/entry ownership: a crafted id for another job's row is refused.
  assert.match(page, /if \(!entry \|\| entry\.jobId !== jobId\) throw/);
  assert.equal((page.match(/if \(!row \|\| row\.jobId !== jobId\) throw/g) ?? []).length, 2);
  // The helpers the actions share are module-scoped — inline "use server"
  // functions cannot close over other functions.
  assert.match(page, /^async function assertEtcMonthUnlocked\(month: string\)/m);
  assert.match(page, /^function etcCell\(/m);
});

test("jobtask and project-release writes are gated on projects:edit", () => {
  const tasks = src("lib/jobtask-actions.ts");
  // `\s*` rather than `\n` — the repo's files are CRLF on this box.
  assert.match(tasks, /export async function saveJobTask\([^)]*\) \{\s*await assertProjectsEditable\(\);/);
  assert.match(tasks, /export async function deleteJobTask\([^)]*\) \{\s*await assertProjectsEditable\(\);/);
  const releases = src("lib/project-release-actions.ts");
  for (const fn of ["uploadProjectRelease", "deleteProjectRelease", "createJobFromRelease"]) {
    const start = releases.indexOf(`export async function ${fn}(`);
    assert.ok(start > 0, fn);
    const head = releases.slice(start, start + 700);
    assert.match(head, /await assertProjectsEditable\(\);/, fn);
  }
});

// ── Finding 3: self-registration ────────────────────────────────────────────

test("self-registered accounts start inactive with an 8-character floor; SSO auto-provision stays active", () => {
  const register = src("app/login/actions.ts");
  assert.match(register, /data: \{ name, email, passwordHash, role: "ALL", active: false \}/);
  assert.match(register, /if \(password\.length < MIN_PASSWORD_LENGTH\)/);
  assert.match(register, /if \(newPassword\.length < MIN_PASSWORD_LENGTH\)/);
  assert.match(register, /return \{ ok: true, pendingActivation: true \};/);
  // The SSO path in auth.ts creates its row without touching `active`, so the
  // column default (true) applies — an SSO-provisioned person keeps working.
  const auth = src("lib/auth.ts");
  const create = auth.slice(auth.indexOf("prisma.user.create("), auth.indexOf("logAuditFor(created.id"));
  assert.doesNotMatch(create, /active/);
  // …and both authorize() paths refuse an inactive row via currentTokenVersion.
  assert.equal((auth.match(/=== null\) return null;/g) ?? []).length >= 2, true);
  // The form tells the person what happens next instead of attempting a doomed sign-in.
  assert.match(src("app/login/LoginForm.tsx"), /if \(res\.pendingActivation\)/);
});

// ── Finding 4 / 7: redirects go through safe-redirect ───────────────────────

test("the SSO route and the login form both sanitise their destination", () => {
  const route = src("app/api/auth/sso/route.ts");
  assert.match(route, /const next = safeRelativePath\(req\.nextUrl\.searchParams\.get\("next"\)\);/);
  assert.match(route, /NextResponse\.redirect\(resolveSameOrigin\(pathAndQuery, requestOrigin\(req\)\)\)/);
  assert.doesNotMatch(route, /searchParams\.get\("next"\) \|\| "\/"/, "the raw fallback is gone");
  const form = src("app/login/LoginForm.tsx");
  assert.match(form, /router\.push\(postLoginDestination\(\)\);/);
  assert.match(form, /safeRelativePath\(new URLSearchParams\(window\.location\.search\)\.get\("callbackUrl"\)\)/);
  assert.doesNotMatch(form, /router\.push\("\/"\)/);
});

// ── Finding 6: changePassword ends other sessions ───────────────────────────

test("changePassword bumps tokenVersion and clears the cache", () => {
  const s = src("app/login/actions.ts");
  const fn = s.slice(s.indexOf("export async function changePassword("));
  assert.match(fn, /data: \{ passwordHash, tokenVersion: \{ increment: 1 \} \}/);
  assert.match(fn, /invalidateTokenVersionCache\(user\.id\);/);
});

// ── Finding 8 / 9 ───────────────────────────────────────────────────────────

test("the shared-secret guard no longer compares with !==", () => {
  const s = src("lib/scheduler-api-auth.ts");
  assert.doesNotMatch(s, /token !== expected/);
  assert.match(s, /timingSafeEqual\(a, b\)/);
});

test("getEmployeePunches requires the Dashboard's permission", () => {
  const s = src("lib/data-quality-actions.ts");
  const fn = s.slice(s.indexOf("export async function getEmployeePunches("));
  assert.match(fn, /^\s*await assertActionPermission\("dashboard:view"\);/m);
  // It is hosted on the Dashboard, whose route is "/", which resolves to dashboard:view.
  assert.equal(permissionForPath("/"), "dashboard:view");
});
