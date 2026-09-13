"use client";

import { useEffect, useRef, useState } from "react";
import {
  MAX_TABS,
  activateTab,
  closeOtherTabs,
  closeTab,
  duplicateTab,
  enterSplit,
  exitSplit,
  moveTab,
  openTab,
  openableRoutes,
  tabById,
  tabIndex,
  tabTitle,
  type TabId,
  type Workspace,
} from "@/lib/workspace";
import { isExclusive, pairingRefusal } from "@/lib/split-view";

// ── The tab strip ────────────────────────────────────────────────────────────
//
// Chrome only. Every mutation goes through lib/workspace.ts and comes back as a URL,
// so this file holds no rules — which tab is active, what closing does to the split,
// and where a drag leaves the indices are all decided (and tested) there. What lives
// here is the strip, the two menus, and the drag.
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
}: {
  ws: Workspace;
  apply: (next: Workspace, opts?: { navigate?: boolean }) => void;
}) {
  const go = (next: Workspace) => apply(next);
  const goOpen = (next: Workspace) => apply(next, { navigate: true });

  const [menu, setMenu] = useState<null | "add" | "split">(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  /** Which tab's right-click menu is open. */
  const [ctxMenu, setCtxMenu] = useState<TabId | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Close either menu on an outside click or Escape. Both are single-select and
  // short-lived, so they get this rather than a focus trap.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest("[data-ws-menu]")) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Keep the active tab in view. A workspace restored from a URL can open with the
  // active tab scrolled out of the strip, which reads as the wrong tab being active.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>("[data-active='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [ws.active, ws.tabs.length]);

  // ── Ctrl+Tab / Ctrl+W / Ctrl+1..8 ────────────────────────────────────────
  //
  // Skipped while focus is in a text field: Monthly ETC is a grid of inputs, and a
  // shortcut that fires mid-cell-edit would navigate away from an unsaved value. Same
  // guard, for the same reason, as SplitViewShell's Ctrl+\.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

      if (e.key === "Tab" && ws.tabs.length > 1) {
        e.preventDefault();
        const step = e.shiftKey ? -1 : 1;
        const at = tabIndex(ws, ws.active);
        go(activateTab(ws, ws.tabs[(at + step + ws.tabs.length) % ws.tabs.length].id));
      } else if (e.key.toLowerCase() === "w" && ws.tabs.length > 0) {
        e.preventDefault();
        go(closeTab(ws, ws.active));
      } else if (/^[1-8]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (i < ws.tabs.length) {
          e.preventDefault();
          go(activateTab(ws, ws.tabs[i].id));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `go` and `router` are stable for a given ws; ws is the only real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const atCap = ws.tabs.length >= MAX_TABS;
  const openPaths = new Set(ws.tabs.map((t) => t.path));
  const activePath = tabById(ws, ws.active)?.path;

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-sdc-border bg-sdc-gray-50">
      {/* The strip scrolls; the controls after it do not. min-w-0 is what confines the
          overflow to this element instead of letting it widen the bar. */}
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Open pages"
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {ws.tabs.map((tab, i) => {
          const id = tab.id;
          const isActive = id === ws.active;
          const inSplit = ws.split != null && (ws.split.left === id || ws.split.right === id);
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
                setDragFrom(i);
                e.dataTransfer.effectAllowed = "move";
                // Firefox will not start a drag unless data is set on the transfer.
                e.dataTransfer.setData("text/plain", String(i));
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                setDragOver(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null && dragFrom !== i) go(moveTab(ws, ws.tabs[dragFrom].id, i));
                setDragFrom(null);
                setDragOver(null);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              className={`motion-interactive group relative flex max-w-[220px] shrink-0 items-center gap-1.5 border-r border-sdc-border px-3 ${
                isActive ? "bg-background" : "bg-sdc-gray-50 hover:bg-white/60"
              } ${dragOver === i && dragFrom !== i ? "border-l-2 border-l-sdc-blue" : ""}`}
            >
              {/* A 2px top rule marks the active tab, matching the split panes' own
                  active indication rather than inventing a second visual language. */}
              {isActive && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-sdc-blue" />}
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => {
                  if (!isActive) go(activateTab(ws, id));
                }}
                title={tabTitle(ws, id, { detailed: true })}
                className={`min-w-0 truncate py-1 text-label ${
                  isActive ? "font-semibold text-sdc-navy" : "font-medium text-sdc-gray-600"
                }`}
              >
                {label}
              </button>
              {inSplit && (
                // Which tabs the split is showing has to be legible from the strip:
                // without this, two pages are on screen and only one tab looks active.
                <span
                  title="Shown in the split view"
                  className="shrink-0 rounded bg-sdc-blue/10 px-1 text-micro font-semibold text-sdc-blue-dark"
                >
                  split
                </span>
              )}
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
                      disabled={ws.tabs.length < 2}
                      onClick={() => {
                        setCtxMenu(null);
                        go(closeOtherTabs(ws, id));
                      }}
                    >
                      Close Other Tabs
                    </MenuItem>
                  </Menu>
                </div>
              )}
            </div>
          );
        })}

        {/* ── "+" ──────────────────────────────────────────────────────────── */}
        <div className="relative flex shrink-0 items-stretch" data-ws-menu>
          <button
            type="button"
            onClick={() => setMenu(menu === "add" ? null : "add")}
            disabled={atCap}
            aria-label="Open another page in a new tab"
            title={atCap ? `At the ${MAX_TABS}-tab limit — close a tab first` : "Open another page in a new tab"}
            className="motion-interactive px-3 text-sdc-muted hover:bg-white/60 hover:text-sdc-navy disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M7 2.5v9M2.5 7h9" strokeLinecap="round" />
            </svg>
          </button>
          {menu === "add" && (
            <Menu title="Open in a new tab">
              {openableRoutes().map((r) => (
                <MenuItem
                  key={r.path}
                  onClick={() => {
                    setMenu(null);
                    goOpen(openTab(ws, r.path, {}, { newInstance: true }));
                  }}
                  // "+" is the EXPLICIT way to ask for another instance, so it requests
                  // a new one rather than resuming - that is exactly what separates it
                  // from a sidebar click. Monthly ETC resumes anyway, and the note says
                  // so rather than the item being disabled, because switching to it is
                  // still a useful answer to this click.
                  note={
                    !openPaths.has(r.path)
                      ? undefined
                      : isExclusive(r.path)
                        ? "already open - switches to it"
                        : "opens another one"
                  }
                >
                  {r.label}
                </MenuItem>
              ))}
            </Menu>
          )}
        </div>
      </div>

      {/* ── Split View ───────────────────────────────────────────────────────
          The requested picker: currently open tabs as the primary choices, with
          "Open another page…" beneath for a page that is not open yet. */}
      <div className="relative flex shrink-0 items-stretch border-l border-sdc-border" data-ws-menu>
        {ws.split ? (
          <button
            type="button"
            onClick={() => go(exitSplit(ws))}
            title="Leave the split and go back to one tab at a time (Ctrl+\)"
            className="motion-interactive px-3 text-label font-medium text-sdc-blue-dark hover:bg-white/60"
          >
            Exit Split
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setMenu(menu === "split" ? null : "split")}
            disabled={ws.tabs.length === 0}
            title={
              ws.tabs.length < 2
                ? "Open a second page first — a split shows two tabs side by side"
                : "Show another tab beside this one"
            }
            className="motion-interactive px-3 text-label font-medium text-sdc-gray-600 hover:bg-white/60 hover:text-sdc-navy disabled:cursor-not-allowed disabled:opacity-40"
          >
            Split View
          </button>
        )}
        {menu === "split" && (
          <Menu title="Show beside this tab" align="right">
            {ws.tabs.map((t) => {
              if (t.id === ws.active) return null;
              // Monthly ETC beside Monthly ETC is refused, with the reason shown.
              // Path-based duplicate matching means two ETC tabs cannot normally both
              // exist, so this is reachable only from a hand-edited URL — but the
              // guard belongs wherever the pairing is offered. See split-view.ts.
              const refusal = pairingRefusal(t.path, activePath);
              return (
                <MenuItem
                  key={t.id}
                  disabled={refusal != null}
                  note={refusal ?? undefined}
                  onClick={() => {
                    setMenu(null);
                    go(enterSplit(ws, t.id));
                  }}
                >
                  {/* detailed: the whole job of a label HERE is telling two otherwise
                      identical entries apart, which is the case the request called out
                      - "show enough context to distinguish duplicate tabs". */}
                  {tabTitle(ws, t.id, { detailed: true })}
                </MenuItem>
              );
            })}
            {ws.tabs.length < 2 && <p className="px-3 py-2 text-micro text-sdc-muted">No other tab is open yet.</p>}
            <div className="my-1 border-t border-sdc-border" />
            <p className="px-3 pb-1 pt-1 text-micro font-semibold uppercase tracking-wide text-sdc-gray-400">
              Open another page…
            </p>
            {openableRoutes()
              .filter((r) => !openPaths.has(r.path))
              .map((r) => {
                const refusal = pairingRefusal(r.path, activePath);
                return (
                  <MenuItem
                    key={r.path}
                    disabled={refusal != null || atCap}
                    note={refusal ?? (atCap ? `at the ${MAX_TABS}-tab limit` : undefined)}
                    onClick={() => {
                      setMenu(null);
                      // Open it, then split. openTab makes the NEW tab active, so the
                      // split is entered from the tab we were on — which keeps the
                      // page the user was reading on the left, where they left it.
                      const opened = openTab(ws, r.path);
                      const newIndex = opened.active;
                      go(enterSplit(activateTab(opened, ws.active), newIndex));
                    }}
                  >
                    {r.label}
                  </MenuItem>
                );
              })}
          </Menu>
        )}
      </div>
    </div>
  );
}

function Menu({
  title,
  align = "left",
  children,
}: {
  title: string;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  return (
    <div
      role="menu"
      aria-label={title}
      className={`absolute top-full z-30 mt-px max-h-[calc(var(--app-vh)*0.7)] w-64 overflow-y-auto rounded-md border border-sdc-border bg-white py-1 shadow-lg ${
        align === "right" ? "right-0" : "left-0"
      }`}
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
      className="motion-interactive block w-full px-3 py-1.5 text-left text-label text-sdc-gray-700 hover:bg-sdc-blue-light/40 hover:text-sdc-navy disabled:cursor-not-allowed disabled:text-sdc-gray-400 disabled:hover:bg-transparent"
    >
      {children}
      {note && <span className="block truncate text-micro font-normal text-sdc-gray-400">{note}</span>}
    </button>
  );
}
