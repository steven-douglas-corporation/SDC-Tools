// The attributes a grid cell carries to become right-clickable, and the selector
// the menu host finds it by.
//
// Deliberately NOT in JobCellMenuHost.tsx, even though that is the only thing
// that reads them. That file is `"use client"`, and every export of a client
// module is a client REFERENCE — so calling this from the server render of
// quoted/page.tsx or etc/page.tsx throws "Attempted to call jobCellMenuProps()
// from the server". Both call sites are server components, which is the entire
// point of the delegated menu: the cells stay server-rendered and only one
// client component exists per grid.
//
// A plain .ts module with no directive is importable from both sides.

export const JOB_MENU_ID_ATTR = "data-job-menu-id";
export const JOB_MENU_CELL_SELECTOR = `[${JOB_MENU_ID_ATTR}]`;

export function jobCellMenuProps({
  jobId,
  jobName,
  schedulerUrl,
}: {
  jobId: string;
  jobName: string;
  // Null when this job has no matching Scheduler project, so the menu never
  // offers a dead link.
  schedulerUrl: string | null;
}) {
  return {
    [JOB_MENU_ID_ATTR]: jobId,
    "data-job-menu-name": jobName,
    // Omitted entirely rather than set empty: absent means "no Scheduler
    // project", which is exactly how the menu reads it.
    ...(schedulerUrl ? { "data-job-menu-url": schedulerUrl } : {}),
  } as const;
}

// ── Where the right-click menu goes (2026-08-28) ────────────────────────────
//
// Pure, and here rather than inline in JobCellMenuHost's layout effect, because
// it is the part that was WRONG and the part worth a test.
//
// The bug: globals.css puts `zoom: var(--app-zoom)` on <html> (lib/app-zoom.ts,
// §45). A `position: fixed` child of document.body sits inside that zoomed
// root, so a `top` of N paints at N x zoom physical pixels — while a
// MouseEvent's clientX/clientY are unzoomed viewport pixels. Assigning
// `top: clientY` therefore misses by `clientY x (zoom - 1)`: LOW above 100%,
// high below it, and worse the further down the grid you click. Measured with a
// real right-click at zoom 1.25: clientY 756, menu painted at 945 — 189px below
// the cursor. After this: 759, i.e. 3px.
//
// Everything is therefore converted into the zoomed layout space the element is
// positioned in. `size` must come from offsetWidth/offsetHeight (layout px);
// getBoundingClientRect() reports the zoom-MULTIPLIED size (213 vs 267 at 1.25)
// and would put the same error straight back into the flip test.
export type MenuPlacement = { x: number; y: number };

export function placeContextMenu(opts: {
  /** MouseEvent clientX/clientY — unzoomed viewport pixels. */
  clientX: number;
  clientY: number;
  /** window.innerWidth/innerHeight — also unzoomed. */
  viewportWidth: number;
  viewportHeight: number;
  /** offsetWidth/offsetHeight of the menu — layout pixels. */
  width: number;
  height: number;
  /** currentZoom(); 1 when the app is at 100%. */
  zoom: number;
}): MenuPlacement {
  const zoom = opts.zoom || 1;
  const px = opts.clientX / zoom;
  const py = opts.clientY / zoom;
  const vw = opts.viewportWidth / zoom;
  const vh = opts.viewportHeight / zoom;
  const pad = 6;
  // Beside the pointer, not under it: otherwise the first item sits directly
  // beneath the cursor and a stray click right after the right-click fires it.
  const nudge = 2;
  let x = px + opts.width + pad > vw ? px - opts.width - nudge : px + nudge;
  let y = py + opts.height + pad > vh ? py - opts.height - nudge : py + nudge;
  // Clamp after flipping, so a menu taller than the viewport still starts on
  // screen rather than at a negative offset.
  x = Math.min(Math.max(pad, x), Math.max(pad, vw - opts.width - pad));
  y = Math.min(Math.max(pad, y), Math.max(pad, vh - opts.height - pad));
  return { x, y };
}
