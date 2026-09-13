"use client";

import { decideCrossAppNav, reportCrossAppNavError } from "@/lib/shell-cross-app-nav";
import { useToast } from "@/components/ui/Toast";

// ── An <a> to another SDC Tools app, that behaves correctly inside the shell ──
//
// The click handling is lib/shell-cross-app-nav.ts; this is the smallest client
// boundary that can host it, so the href can still be built on the SERVER.
//
// ── Why a wrapper rather than "use client" on the link components ───────────
//
// The first attempt put "use client" directly on SchedulerJobLink. That broke
// the build: SchedulerJobLink calls schedulerScheduleUrl() from
// lib/scheduler-link.ts, which is `import "server-only"` and pulls in
// next/headers, auth and scheduler-db — so marking its component client
// dragged the whole server module into the client bundle (Module not found:
// 'net', 'tls'). The same failure class as the `server-only` breach in
// job-hours-dashboard.ts.
//
// And splitting schedulerScheduleUrl out as "the pure part" is NOT available
// here, unlike tm-drill-search.ts: it calls withSchedulerSso(), which mints a
// fresh single-use HMAC SSO assertion per link so arriving at the Scheduler
// does not hit a login modal. That needs a server secret and a per-row nonce.
// The URL genuinely must be built server-side.
//
// So the boundary goes here instead: the server builds the href (token and
// all), and this component — which imports nothing server-only — decides where
// the click goes.
export function CrossAppAnchor({
  appId,
  href,
  className,
  title,
  ariaLabel,
  children,
}: {
  /** The shell's own app id: "scheduler", "assemblies", … */
  appId: string;
  /** Fully-built URL, from the server. Only its path+query crosses the bridge. */
  href: string;
  className?: string;
  title?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}) {
  const { toast } = useToast();

  // target="_blank" stays on the anchor: it is still correct in a plain browser
  // tab, and it is exactly what runs when the decision comes back "anchor".
  // Inside the shell the handler preventDefaults before it can matter.
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const result = decideCrossAppNav(appId, href);
    if (result.mode === "anchor") return;
    e.preventDefault();
    // The one failure the bridge reports — the target app not running yet.
    // Previously dropped on the floor, which made the click look like a no-op.
    void reportCrossAppNavError(result, (message) => toast(message, "error"));
  };

  return (
    <a
      href={href}
      onClick={onClick}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      aria-label={ariaLabel}
      className={className}
    >
      {children}
    </a>
  );
}
