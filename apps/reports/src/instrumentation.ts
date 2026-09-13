// Starts the app's one refresh schedule. WHAT gets refreshed, and the rules it
// follows, live in lib/auto-sync.ts — this file only decides when it runs.
export async function register() {
  // register() runs in both the Node.js and Edge runtimes (the latter for
  // proxy.ts/middleware). Every sync behind runAllSyncs pulls in Node-only
  // modules — mssql, MSAL's native token cache, fs — which cannot load under
  // Edge, so skip entirely there.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const g = globalThis as typeof globalThis & { __sdcAutoSyncStarted?: boolean };
  if (g.__sdcAutoSyncStarted) return; // guard against HMR / repeated registration
  g.__sdcAutoSyncStarted = true;

  // The Role Permissions matrix (2026-08-18): load the DB-backed state into
  // lib/permissions.ts's in-memory cache before anything else runs, so the
  // very first request sees the ELT-configured matrix rather than the
  // hardcoded fallback. A failure here is not fatal — hasPermission() falls
  // back to DEFAULT_OWN_PERMISSIONS (today's shipped values) until a save or
  // a restart succeeds in loading the real thing.
  try {
    const { loadRolePermissionsFromDb } = await import("@/lib/role-permissions-store");
    await loadRolePermissionsFromDb();
  } catch (err) {
    console.error("[permissions] could not load Role Permissions from the database at boot:", err);
  }

  const { SYNC_INTERVAL_MS } = await import("@/lib/auto-sync");
  // Through the SHARED service, not runAllSyncs directly (§25.5): the scheduled pass and
  // the `Refresh Data` button must be the same work, under the same lock, writing the
  // same RefreshRun record and broadcasting the same event. Calling the runner straight
  // from here is what would let the two drift.
  const { refreshAllData } = await import("@/lib/refresh-service");

  // Once at boot, then EVERY HOUR (was every 6). Still no retry policy: the interval is
  // the retry, and it is now four times more forgiving of a single failed pass. Every
  // step records its own failure where the app can show it — see auto-sync.ts rule 3.
  const tick = (trigger: "startup" | "interval") => {
    // refreshAllData catches per step and returns a result rather than throwing, so a
    // rejection reaching here means the runner itself broke. Caught anyway: an unhandled
    // rejection can take the process down, and losing the server is worse than losing a
    // pass. A tick that finds the lock held (a manual refresh in flight) simply returns
    // "locked" and does nothing — which is the correct outcome, not an error.
    refreshAllData({ trigger }).catch((err) => console.error("[auto-sync] pass could not run:", err));
  };

  tick("startup");
  setInterval(() => tick("interval"), SYNC_INTERVAL_MS);
}
