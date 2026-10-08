"use client";

import { useEffect, useState } from "react";
import { useWorkspaceActions } from "@/components/useWorkspaceActions";
import { currentDrag, useDragPayload, watchDragEnd } from "@/lib/drag-payload";
import { ratioBounds } from "@/lib/split-view";
import type { Side } from "@/lib/workspace";

// ── Drag onto a side of the screen to start a split (2026-10-08) ─────────────
//
// Shown only WHILE something is being dragged — a page out of the sidebar, or a tab out
// of a strip — and only when there is no split yet. Two zones, one on each edge of the
// content area. Dropping on one starts a split with the dragged page or tab on that
// side; everything already open stays together on the other.
//
// With a split open there is nothing to show: the panes are the drop targets
// (WorkspaceShell's PaneHost), and the same gesture means "put it in that side".
//
// ── Why it is mounted once, in the app layout ──────────────────────────────────
//
// The zones have to work from an ordinary single-page route too, where there is no
// workspace and no tab strip at all — dragging a page there is how you ENTER a split.
// So this lives above the pages, and uses the live workspace store to know whether a
// split exists.
//
// ── Where the zones sit ────────────────────────────────────────────────────────
//
// Over the content area (not the sidebar), below the tab strip when there is one: a
// strip is itself a drop target for reordering, and a zone over it would swallow that.
// They are hidden altogether when the content is too narrow to hold two panes, because a
// split made there would collapse straight back to one and the drop would look broken.
// Everything is measured when the drag starts, which is when this renders — the layout
// cannot change under the cursor mid-drag.

/** The zone is a fifth of the content, never narrower than this. */
const MIN_ZONE_PX = 120;

export function SplitDropOverlay() {
  const drag = useDragPayload();
  const actions = useWorkspaceActions();
  const ws = actions.workspace;
  const [hover, setHover] = useState<Side | null>(null);

  // One listener for the whole app: clears the drag however it ends, including when the
  // dragged element is gone by the time the browser would have fired its `dragend`.
  useEffect(() => watchDragEnd(), []);

  if (!drag || ws?.split) return null;
  // A page that cannot be a tab has nothing to split with; a tab needs another tab left
  // behind to be the other side.
  if (drag.kind === "page" && !actions.canHost(drag.path)) return null;
  if (drag.kind === "tab" && (!ws || ws.tabs.length < 2)) return null;

  const main = document.getElementById("main-content");
  if (!main) return null;
  const rect = main.getBoundingClientRect();
  if (ratioBounds(rect.width) === null) return null;

  // Below the strip when there is one, otherwise from the top of what is on screen.
  const stripBottom = document.querySelector("[data-ws-strip]")?.getBoundingClientRect().bottom;
  const top = Math.max(stripBottom ?? rect.top, 0);
  const left = Math.max(rect.left, 0);
  const right = Math.max(window.innerWidth - rect.right, 0);
  const width = Math.max(MIN_ZONE_PX, Math.round(rect.width * 0.2));

  const label = (side: Side) =>
    drag.kind === "tab" ? `Split to the ${side}` : `Open on the ${side}`;

  const zone = (side: Side) => (
    <div
      key={side}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (hover !== side) setHover(side);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setHover(null);
        const d = currentDrag();
        if (!d) return;
        actions.dropToSide(d.kind === "page" ? { kind: "page", path: d.path } : { kind: "tab", id: d.id }, side);
      }}
      style={{ position: "fixed", top, bottom: 0, width, ...(side === "left" ? { left } : { right }) }}
      // Faintly outlined while dragging so the edges announce themselves; the one under the
      // cursor fills in and says what the drop will do, in words rather than a symbol.
      className={`z-40 flex items-center justify-center border-2 border-dashed ${
        hover === side ? "border-sdc-blue bg-sdc-blue/10" : "border-sdc-blue/25 bg-sdc-blue/[0.03]"
      }`}
    >
      {hover === side && (
        <span className="pointer-events-none rounded bg-white/95 px-2.5 py-1 text-label font-semibold text-sdc-blue-dark shadow-sm">
          {label(side)}
        </span>
      )}
    </div>
  );

  return (
    <>
      {zone("left")}
      {zone("right")}
    </>
  );
}
