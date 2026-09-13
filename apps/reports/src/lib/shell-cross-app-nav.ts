// ── Linking to another SDC Tools app, from inside or outside the shell ──────
//
// One implementation of the three-tier decision every cross-app link in this
// app has to make. It was written once inline in JobCellMenuHost.tsx (the
// Projects grid's "Project Schedule" job-menu item, 2026-08-28) and then two
// other links — SchedulerJobLink's Gantt icon and the Sidebar's "Apps ->
// Project Scheduler" item — kept the plain target="_blank" they shipped with,
// so the same click behaved two different ways depending on which control you
// used. This is that logic, extracted rather than copied a third time.
//
// ── The three tiers, and why each exists ───────────────────────────────────
//
//   1. window.sdcShell.openApp (shell build >= 2026-08-28)
//      Hands the shell an appId + same-origin PATH. openAppWindow() focuses the
//      app window that is already open and NAVIGATES it to the deep link,
//      rather than starting a second copy — which is what "open job 1127 in the
//      Scheduler" has to mean when the Scheduler is already showing something
//      else. Only a path crosses the bridge: the shell owns every app's origin
//      (processManager's port registry), and accepting a full URL from a
//      renderer would let an embedded page aim a shell window anywhere.
//
//   2. Inside the shell, but no bridge (older shell build)
//      Navigate THIS window instead. Electron's default for target="_blank"
//      from an embedded app is to silently deny the new-window request — the
//      click does nothing at all, no error and no window — which is why the
//      shell's setWindowOpenHandler answers those with shell.openExternal
//      instead. That throws the user out of SDC Tools into their default
//      browser, at a standalone copy of an app very likely already open as a
//      shell window, and without the shell's session. Staying inside is
//      strictly better. This branch is unreachable once every shell in the
//      field has the bridge, and can be deleted then.
//
//   3. A normal browser tab
//      target="_blank" is exactly right. Do nothing and let the anchor work.
//
// Feature-detected rather than configured, because one build of this app is
// served to both the shell and plain browsers at the same time.

/**
 * What `decideCrossAppNav` did, plus the bridge's own pending result.
 *
 * `pending` is openApp's promise, present only for mode "bridge". Await it to
 * report the one failure the bridge has: the target app not running. It is
 * handed back rather than awaited internally because a click handler that
 * awaits before calling preventDefault has already let the default action fire.
 */
export type CrossAppNavResult = {
  mode: CrossAppNavMode;
  pending?: Promise<{ error?: string } | void>;
};

/** What `decideCrossAppNav` told the caller to do. */
export type CrossAppNavMode =
  /** Handled via the shell bridge. The caller must preventDefault. */
  | "bridge"
  /** Navigated this window. The caller must preventDefault. */
  | "in-place"
  /** Not handled — let the anchor's own target="_blank" run. */
  | "anchor";

type ShellGlobals = {
  // openApp resolves to { success } or { error } — openAppWindow() in the
  // shell's main.js returns { error: 'Server not ready yet' } when the target
  // app's process is not running.
  sdcShell?: { openApp?: (appId: string, path?: string) => Promise<{ error?: string } | void> };
  // appPreload.js has exposed electronAPI to every embedded app window for far
  // longer than sdcShell has existed, so it — not sdcShell — is the reliable
  // "am I inside the shell" signal, including on builds that predate the bridge.
  electronAPI?: unknown;
};

function shellGlobals(): ShellGlobals {
  return globalThis as unknown as ShellGlobals;
}

/** True when running inside an SDC Tools shell window, bridge or not. */
export function insideShell(): boolean {
  return Boolean(shellGlobals().electronAPI);
}

/**
 * Decide (and perform) how a cross-app link should open.
 *
 * @param appId  the shell's own app id — "scheduler", "assemblies", …
 * @param href   the FULL url the anchor would have opened. Only its path+query
 *               is sent across the bridge; the origin is dropped, since the
 *               shell supplies its own.
 * @returns the tier that handled it, plus openApp's pending promise for the
 *          "bridge" case. "bridge" and "in-place" mean the caller must call
 *          preventDefault(); "anchor" means it must not.
 *
 * Deliberately synchronous: see CrossAppNavResult.pending.
 */
export function decideCrossAppNav(appId: string, href: string): CrossAppNavResult {
  const g = shellGlobals();
  const openApp = g.sdcShell?.openApp;

  if (openApp) {
    // Relative to the shell's own origin for the app, so a malformed href
    // cannot become an origin change. URL() throws on a non-absolute href —
    // treat that as "not handled" rather than swallowing a real bug.
    try {
      const u = new URL(href);
      const pending = Promise.resolve(openApp(appId, `${u.pathname}${u.search}`));
      return { mode: "bridge", pending };
    } catch {
      return { mode: "anchor" };
    }
  }

  if (insideShell()) {
    window.location.assign(href);
    return { mode: "in-place" };
  }

  return { mode: "anchor" };
}

/**
 * Reports the one failure the bridge has: openAppWindow() answers
 * `{ error: 'Server not ready yet' }` when the target app's process is not
 * running (mid-restart, or never started). The original caller fired openApp
 * and dropped that on the floor, so the click looked like it did nothing —
 * the exact silent failure tier 2 exists to avoid.
 *
 * Pass the result of decideCrossAppNav and a reporter (a toast, typically).
 * Awaiting this never delays the navigation, because the decision was already
 * made and preventDefault already called.
 */
export async function reportCrossAppNavError(
  result: CrossAppNavResult,
  onError: (message: string) => void,
): Promise<void> {
  if (!result.pending) return;
  try {
    const outcome = await result.pending;
    if (outcome && typeof outcome === "object" && "error" in outcome && outcome.error) {
      onError(outcome.error);
    }
  } catch {
    // An IPC that rejects outright is not something the user can act on, and
    // the window either opened or did not — silence beats a second message.
  }
}
