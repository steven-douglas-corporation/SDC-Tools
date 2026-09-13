import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import AppShell from "@/components/AppShell";
import { COLLAPSED_COOKIE, WIDTH_COOKIE, parseSidebarPrefs } from "@/lib/sidebar-prefs";
import { LiveRefresh } from "@/components/LiveRefresh";
import { RealtimeProvider } from "@/components/RealtimeProvider";
import { InteractionMetrics } from "@/components/InteractionMetrics";
import { getSchedulerBaseUrlForRequest } from "@/lib/scheduler-link";
import { withSchedulerSso } from "@/lib/scheduler-sso";
import { hasPermission } from "@/lib/permissions";
import { ROUTE_PERMISSIONS } from "@/lib/route-permissions";

// NOTE for anyone tempted to cache this layout or lift the auth() call out of it:
// `await auth()` reads cookies, and that is what makes EVERY page under (app)
// dynamically rendered. Four route files contain no request-time API of their own
// and are dynamic purely by inheritance from here. Caching this would freeze them
// for every user at once — which is the shape of the bug fixed on 2026-08-04.
export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  // ── The sidebar's state, resolved SERVER-side (§46.14) ──────────────────────
  //
  // It used to live in localStorage, which the server cannot see — so a collapsed
  // sidebar was rendered EXPANDED (measured: `<aside style="width:276px">` with every
  // label, the search field and the version string) and snapped to the 60px rail after
  // hydration. One flash per page load, on every route.
  //
  // Reading it here costs nothing that isn't already being paid: `auth()` above reads
  // cookies, which is what makes every route under this layout dynamic. See
  // lib/sidebar-prefs.ts for why this preference — and only this one — is a cookie.
  const jar = await cookies();
  const sidebar = parseSidebarPrefs(jar.get(COLLAPSED_COOKIE)?.value, jar.get(WIDTH_COOKIE)?.value);

  // Which nav hrefs this role may see, computed HERE rather than inside
  // Sidebar (a "use client" component) — the Role Permissions matrix
  // (2026-08-18) is DB-backed and lives only in this server process's memory
  // (lib/permissions.ts), so a client bundle's own copy of hasPermission()
  // would be a frozen build-time snapshot no live change could ever reach.
  // Sidebar just filters against this list; every "live" permission update
  // reaches it because router.refresh() re-runs this layout, which reads
  // hasPermission() fresh every time.
  const role = session?.user?.role ?? "ALL";
  const visibleHrefs = ROUTE_PERMISSIONS.filter((r) => hasPermission(role, r.permission)).map((r) => r.path);
  if (hasPermission(role, "dashboard:view")) visibleHrefs.push("/");
  // /cash-flow needs no special case any more: it is a real row in
  // ROUTE_PERMISSIONS (cash-flow:view, 2026-09-01), so the filter above picks
  // it up like every other link. This used to push it off `role === "ELT"`.

  // ── Sign-out removed (2026-08-20, SDC Tools centralized login) ────────────
  // This app no longer owns a sign-out of its own. Identity comes from the SDC
  // Tools shell's single Azure AD login; only the shell signs you out, and it
  // clears this app's session cookie along with the rest of the suite.
  //
  // The old handler also called revokeSchedulerSession() before signOut(),
  // which — now that both apps share one login — created a MUTUAL REVOCATION
  // LOOP with the Scheduler: a session invalidated here bounced to /login,
  // that revoked the Scheduler, which invalidated the token the shell had just
  // seeded there, whose own sign-out revoked this app straight back. Observed
  // live on 2026-08-20: users.token_version climbing 7 → 9 → 14 on its own,
  // and BOTH apps demanding a fresh login seconds after a successful SSO
  // hand-off. Cross-app revoke made sense when each app had its own login; it
  // is actively destructive now. Do not reintroduce it without a single
  // owner for session lifetime (that owner is the shell).


  return (
    // The Scheduler's base URL lives in server-only env (SCHEDULER_BASE_URL),
    // so it has to be handed to the client sidebar as a prop rather than read
    // there. `/?view=projects` lands on the Scheduler's Projects page.
    <AppShell
      userEmail={session?.user?.email}
      visibleHrefs={visibleHrefs}
      // What the server rendered with. The client store reads the same two cookies, so
      // the value React hydrates with is the value already on screen.
      sidebar={sidebar}
      // Carries a 60-second signed assertion of who is signed in here, so the
      // Scheduler can start its own session instead of showing a login modal to
      // someone the app already authenticated. No secret configured, or no
      // session: the link is unchanged and the Scheduler asks as it does today.
      schedulerProjectsUrl={withSchedulerSso(`${await getSchedulerBaseUrlForRequest()}/?view=projects`, session?.user?.email)}
    >
      {/* Mounted once for the whole app, so every tab — Projects, Monthly ETC,
          Employees, Job Hours, the dashboard, a job page — picks up what other
          people have saved instead of staying the snapshot it loaded with. See
          LiveRefresh for why revalidatePath was not the answer. */}
      <LiveRefresh />
      {/* The realtime layer, also once for the whole app: one SSE connection per
          tab carrying presence ("who is editing this cell") and change events
          ("what did somebody just save"). RealtimeProvider renders nothing — it
          owns the connection. ChangeNotifications (the change-event banner) is
          no longer mounted here: since 2026-08-10 it renders from inside
          AppShell's ToastProvider, which is the one place notifications share a
          single fixed stack — see the note in ui/Toast.tsx. */}
      <RealtimeProvider />
      {/* Interaction timing (§38.14), once for the whole app so every route is measured
          the same way. Renders nothing, sends nothing, and stays dormant in production
          until somebody asks for it with ?perf=1 — see the header note. */}
      <InteractionMetrics />
      {children}
    </AppShell>
  );
}
