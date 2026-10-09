"use client";

import { useEffect, useRef, useState } from "react";
import {
  MAX_TABS,
  activateTab,
  closeOtherTabs,
  closeTab,
  duplicateTab,
  focusedSide,
  groupTabs,
  moveTabTo,
  needsRender,
  openTab,
  tabTitle,
  visibleIn,
  type Side,
  type TabId,
  type Workspace,
} from "@/lib/workspace";
import { isExclusive, isSplittable } from "@/lib/split-view";
import { beginDrag, currentDrag, endDrag } from "@/lib/drag-payload";

// ── Ctrl+Tab / Ctrl+W / Ctrl+1..8 ────────────────────────────────────────────
//
// Registered ONCE, by WorkspaceShell — the strips are one per group now, and a shortcut
// registered by each would fire twice. They act on the group the user is working in:
// Ctrl+Tab cycles through ITS tabs, Ctrl+1..8 numbers ITS strip.
//
// Skipped while focus is in a text field: Monthly ETC is a grid of inputs, and a
// shortcut that fires mid-cell-edit would navigate away from an unsaved value. Same
// guard, for the same reason, as the shell's Ctrl+\.
export function useTabShortcuts(ws: Workspace, apply: (next: Workspace) => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

      const mine = groupTabs(ws, focusedSide(ws));
      if (e.key === "Tab" && mine.length > 1) {
        e.preventDefault();
        const step = e.shiftKey ? -1 : 1;
        const at = mine.findIndex((m) => m.id === ws.active);
        apply(activateTab(ws, mine[(at + step + mine.length) % mine.length].id));
      } else if (e.key.toLowerCase() === "w" && ws.tabs.length > 0) {
        e.preventDefault();
        apply(closeTab(ws, ws.active));
      } else if (/^[1-8]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (i < mine.length) {
          e.preventDefault();
          apply(activateTab(ws, mine[i].id));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws, apply]);
}

// ── The tab strip ────────────────────────────────────────────────────────────
//
// Chrome only. Every mutation goes through lib/workspace.ts and comes back as a URL,
// so this file holds no rules — which tab is active, what closing does to the split,
// and where a drag leaves the tabs are all decided (and tested) there. What lives
// here is the strip, the menus, and the drag.
//
// ── One strip per group (2026-10-08) ────────────────────────────────────────
//
// Outside a split this is the one strip across the top, holding every tab. In a split
// each GROUP has its own — rendered by WorkspaceShell at the top of that group's pane —
// holding only that group's tabs. `side` says which; outside a split it is "left",
// which is every tab.
//
// ── No action here is a navigation any more (2026-09-04) ────────────────────
//
// Every tab action used to be a router.push, which meant a tab switch re-ran the
// target page on the server and remounted it — the reported slowness. Panes are now
// all mounted at once behind <Activity> (see WorkspaceShell), so switching, closing,
// reordering and splitting are pure state changes.
//
// `apply` is the shell's single commit point and it decides which of the two kinds an
// action is. This file passes `{ navigate: true }` for exactly the actions that need a
// pane nobody has rendered yet: opening a page in a new tab, and duplicating one.
export function WorkspaceTabBar({
  ws,
  apply,
  side = "left",
}: {
  ws: Workspace;
  apply: (next: Workspace, opts?: { navigate?: boolean }) => void;
  /** Which group's tabs this strip shows. Outside a split there is only "left". */
  side?: Side;
}) {
  const go = (next: Workspace) => apply(next);
  const goOpen = (next: Workspace) => apply(next, { navigate: true });

  /** The tab a drag is currently hovering, for the insertion marker. */
  const [dragOver, setDragOver] = useState<TabId | null>(null);
  /** Which tab's right-click menu is open. */
  const [ctxMenu, setCtxMenu] = useState<TabId | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  const tabs = groupTabs(ws, side);
  const shownId = visibleIn(ws, side);
  // Outside a split there is one group and it is always the one in use.
  const focused = !ws.split || focusedSide(ws) === side;

  // Keep the group's visible tab in view. A workspace restored from a URL can open with
  // it scrolled out of the strip, which reads as the wrong tab being active.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>("[data-active='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [shownId, tabs.length]);

  const atCap = ws.tabs.length >= MAX_TABS;

  return (
    <div
      // data-ws-strip: SplitDropOverlay starts its edge zones below this, so they never
      // sit over a strip that is itself a drop target.
      data-ws-strip
      // sticky top-0: the strip stays on screen while the page scrolls. z-40 keeps it (and
      // its z-30 dropdowns) above the sticky headers inside pages. In a split the panes
      // scroll internally, so there it simply stays put as before.
      className={`sticky top-0 z-40 flex h-11 shrink-0 items-stretch border-b bg-sdc-gray-50 ${
        ws.split && focused ? "border-sdc-blue/40" : "border-sdc-border"
      }`}
    >
      {/* The strip scrolls; the controls after it do not. min-w-0 is what confines the
          overflow to this element instead of letting it widen the bar. */}
      <div
        ref={stripRef}
        role="tablist"
        aria-label={ws.split ? `Open pages, ${side} side` : "Open pages"}
        // A tab dropped on the empty part of a strip goes to the end of THIS group. Only a
        // TAB is handled here: a dragged page is the pane's to place (see PaneHost) — except
        // outside a split, where there is no pane and dropping a page on the strip is
        // simply "open this as a tab".
        onDragOver={(e) => {
          const d = currentDrag();
          const takes = d?.kind === "tab" || (d?.kind === "page" && !ws.split && isSplittable(d.path));
          if (!takes) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          const d = currentDrag();
          if (d?.kind === "tab") {
            e.preventDefault();
            e.stopPropagation();
            go(moveTabTo(ws, d.id, side));
          } else if (d?.kind === "page" && !ws.split && isSplittable(d.path)) {
            e.preventDefault();
            e.stopPropagation();
            const next = openTab(ws, d.path);
            apply(next, needsRender(ws, next) ? { navigate: true } : undefined);
          }
          setDragOver(null);
        }}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const id = tab.id;
          const isActive = id === shownId;
          // tabTitle appends the instance hint ("Job Details - 1101") only when this
          // workspace actually holds more than one of that page, so a lone tab keeps its
          // plain name. See lib/workspace.ts.
          const label = tabTitle(ws, id);
          return (
            <div
              key={id}
              data-active={isActive}
              data-tab-id={id}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu(ctxMenu === id ? null : id);
              }}
              onAuxClick={(e) => {
                // Middle-click closes, as it does in every browser tab strip.
                if (e.button === 1) {
                  e.preventDefault();
                  go(closeTab(ws, id));
                }
              }}
              draggable
              onDragStart={(e) => {
                beginDrag({ kind: "tab", id });
                e.dataTransfer.effectAllowed = "move";
                // Firefox will not start a drag unless data is set on the transfer.
                e.dataTransfer.setData("text/plain", id);
              }}
              onDragOver={(e) => {
                const d = currentDrag();
                if (d?.kind !== "tab") return; // a page is the pane's, or the strip's
                e.preventDefault();
                e.stopPropagation();
                setDragOver(id);
              }}
              onDrop={(e) => {
                const d = currentDrag();
                if (d?.kind !== "tab") return;
                e.preventDefault();
                e.stopPropagation();
                if (d.id !== id) go(moveTabTo(ws, d.id, side, id));
                setDragOver(null);
              }}
              onDragEnd={() => {
                setDragOver(null);
                endDrag();
              }}
              className={`motion-interactive group relative flex max-w-[260px] shrink-0 items-center gap-1.5 border-r border-sdc-border px-3 ${
                isActive ? "bg-background" : "bg-sdc-gray-50 hover:bg-white/60"
              } ${dragOver === id ? "border-l-2 border-l-sdc-blue" : ""}`}
            >
              {/* A 2px top rule marks the group's visible tab. In a split it is blue only in
                  the group the sidebar will open into, so which side is in use is legible
                  from the strip alone. */}
              {isActive && (
                <span aria-hidden className={`absolute inset-x-0 top-0 h-0.5 ${focused ? "bg-sdc-blue" : "bg-sdc-gray-300"}`} />
              )}
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => {
                  if (!isActive) go(activateTab(ws, id));
                }}
                title={tabTitle(ws, id, { detailed: true })}
                className={`min-w-0 truncate py-1 text-sm ${
                  isActive ? "font-semibold text-sdc-navy" : "font-medium text-sdc-gray-600"
                }`}
              >
                {label}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  go(closeTab(ws, id));
                }}
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                // Always shown on the active tab, hover/focus-revealed otherwise:
                // eight tabs each carrying a permanent x is a strip of x symbols.
                className={`motion-interactive shrink-0 rounded p-0.5 text-sdc-gray-400 hover:bg-sdc-gray-200 hover:text-sdc-navy ${
                  isActive ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
                }`}
              >
                <svg
                  viewBox="0 0 14 14"
                  className="h-3 w-3"
                  aria-hidden
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" strokeLinecap="round" />
                </svg>
              </button>
              {ctxMenu === id && (
                // Right-click menu. Duplicate is the explicit "give me another one of
                // these" the request asked for, alongside middle-clicking a sidebar
                // item - a second instance is never what a plain click does.
                <div data-ws-menu className="absolute left-0 top-full z-30">
                  <Menu title={label}>
                    <MenuItem
                      disabled={atCap || isExclusive(tab.path)}
                      note={
                        isExclusive(tab.path)
                          ? "only one at a time - its unsaved-cell tracking is shared"
                          : atCap
                            ? `at the ${MAX_TABS}-tab limit`
                            : undefined
                      }
                      onClick={() => {
                        setCtxMenu(null);
                        goOpen(duplicateTab(ws, id));
                      }}
                    >
                      Duplicate Tab
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        setCtxMenu(null);
                        go(closeTab(ws, id));
                      }}
                    >
                      Close
                    </MenuItem>
                    <MenuItem
                      disabled={tabs.length < 2}
                      onClick={() => {
                        setCtxMenu(null);
                        go(closeOtherTabs(ws, id));
                      }}
                    >
                      Close Other Tabs
                    </MenuItem>
                    {ws.split && (
                      // The keyboard-and-menu way to do what dragging between the strips does.
                      <MenuItem
                        onClick={() => {
                          setCtxMenu(null);
                          go(moveTabTo(ws, id, side === "left" ? "right" : "left"));
                        }}
                      >
                        {side === "left" ? "Move to the Right Side" : "Move to the Left Side"}
                      </MenuItem>
                    )}
                  </Menu>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Menu({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      role="menu"
      aria-label={title}
      className="absolute left-0 top-full z-30 mt-px max-h-[calc(var(--app-vh)*0.7)] w-64 overflow-y-auto rounded-md border border-sdc-border bg-white py-1 shadow-lg"
    >
      <p className="px-3 pb-1 text-micro font-semibold uppercase tracking-wide text-sdc-gray-400">{title}</p>
      {children}
    </div>
  );
}

function MenuItem({
  onClick,
  disabled,
  note,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  /** Why this entry is refused, or what it will do instead — a disabled row with no explanation reads as a bug. */
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={note}
      className="motion-interactive block w-full px-3 py-1.5 text-left text-sm text-sdc-gray-700 hover:bg-sdc-blue-light/40 hover:text-sdc-navy disabled:cursor-not-allowed disabled:text-sdc-gray-400 disabled:hover:bg-transparent"
    >
      {children}
      {note && <span className="block truncate text-micro font-normal text-sdc-gray-400">{note}</span>}
    </button>
  );
}
