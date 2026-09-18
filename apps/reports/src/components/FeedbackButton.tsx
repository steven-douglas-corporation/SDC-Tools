"use client";

import { useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { FeedbackDrawer } from "@/components/FeedbackDrawer";
import { buildFeedbackContext, type FeedbackContext, type PaneLocation } from "@/lib/feedback-context";
import { decodeSplit, splitRoute } from "@/lib/split-view";
import { rawParams } from "@/lib/pane-url";
import { useLiveWorkspace } from "@/lib/workspace-store";
import { tabById } from "@/lib/workspace";

// ── The Flag button ─────────────────────────────────────────────────────────
//
// Mounted once in AppShell rather than per page, for the reason that file's
// own comment gives about ExcelCellFocus/ScrollHandoff: "a page cannot forget
// to include it, and a container that appears after a client-side navigation
// is covered." A feedback channel that exists on nine pages out of twelve is a
// feedback channel people stop trusting.
//
// ══ WHY THIS DOES NOT CALL usePaneUrl() ═════════════════════════════════════
//
// It would be the obvious thing, and it is wrong HERE specifically.
//
// usePaneUrl() answers "which pane am I rendered in", by reading the context
// PaneView puts around each pane's body. This button is mounted in AppShell —
// ABOVE every pane, outside every provider — so that hook would fall through
// to its plain-page branch and hand back the HOST url: "/w" with `t1.month`
// style keys, or "/split" with `l.`/`r.` ones. Every tab user's feedback would
// record the workspace shell instead of the report they were looking at.
//
// So this resolves the ACTIVE pane instead, which is a different question with
// a different answer, using the app's own decoders rather than a second copy
// of the encoding (see lib/feedback-context.ts's header for why re-deriving it
// would be the drift split-view.ts warns about):
//
//   /w      the live workspace's active tab -> its own path and params
//   /split  the left pane, which is the focused one by convention
//   else    the document's own path and query, which IS the view
//
// tests/feedback-context.test.ts pins all three shapes end to end.
function useActiveViewContext(): FeedbackContext {
  const pathname = usePathname();
  const search = useSearchParams();
  const searchKey = search.toString();
  // The LIVE workspace, not the URL-decoded one: a tab switch commits to this
  // store before the address bar catches up (see lib/workspace-store.ts), and
  // flagging in that window must describe the tab the user is looking at.
  const live = useLiveWorkspace();

  return useMemo(() => {
    const labelFor = (p: string) => splitRoute(p)?.label ?? null;
    let location: PaneLocation = { path: pathname, params: Object.fromEntries(new URLSearchParams(searchKey)) };

    if (pathname === "/w") {
      const ws = live;
      const tab = ws ? tabById(ws, ws.active) : undefined;
      // No live workspace yet (first paint, before the shell publishes) — the
      // fallback is the host URL, which is wrong but recoverable: the drawer
      // shows the captured view, so the user can see it is off and say so.
      // Losing the report entirely would be worse.
      if (tab) location = { path: tab.path, params: tab.params };
    } else if (pathname === "/split") {
      const state = decodeSplit(rawParams(searchKey));
      if (state) location = { path: state.l.path, params: state.l.params };
    }

    return buildFeedbackContext(location, labelFor);
  }, [pathname, searchKey, live]);
}

export function FeedbackButton({ canSubmit, canView }: { canSubmit: boolean; canView: boolean }) {
  const [open, setOpen] = useState(false);
  // Hooks must run unconditionally, so the context is resolved even for a role
  // that cannot submit — it is cheap (three reads and a memo) and returning
  // early above it would break the rules of hooks.
  const context = useActiveViewContext();

  // Gated on the permission resolved SERVER-side and passed down, never on a
  // client-side hasPermission() call: the permission matrix is DB-backed and
  // lives in the server process's memory, so a client bundle's own copy would
  // be a frozen build-time snapshot. Same reasoning as the (app) layout's
  // visibleHrefs note.
  if (!canSubmit) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Report a problem with this view"
        aria-label="Report a problem with this view"
        className="fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-full border border-sdc-border bg-white px-3.5 py-2 text-sm font-semibold text-sdc-gray-700 shadow-lg motion-interactive hover:border-sdc-blue hover:text-sdc-blue-dark"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M3.5 14V2.5h7l-1 2 1 2h-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Flag
      </button>
      {open && <FeedbackDrawer context={context} canView={canView} onClose={() => setOpen(false)} />}
    </>
  );
}
