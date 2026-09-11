"use client";

import Image from "next/image";
import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSplitNav } from "@/components/useSplitNav";
import { tabById } from "@/lib/workspace";
import { closePaneHref } from "@/lib/split-view";
import { useWorkspaceActions } from "@/components/useWorkspaceActions";
import { NavItemMenu, NavItemMenuButton, type NavMenuAnchor } from "@/components/NavItemMenu";
import { decideCrossAppNav, insideShell, reportCrossAppNavError } from "@/lib/shell-cross-app-nav";
import { useToast } from "@/components/ui/Toast";
import {
  applyNavOrder,
  moveItem,
  readNavOrder,
  subscribeNavOrder,
  writeNavOrder,
  clearNavOrder,
  NO_NAV_ORDER,
} from "@/lib/nav-order";
import { appVersionLabel } from "@/lib/app-version";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isEtcDirty } from "@/lib/etc-dirty-tracker";
import { RefreshDataButton } from "@/components/RefreshDataButton";
import { AppZoom } from "@/components/AppZoom";
import { AppRefreshButton } from "@/components/AppRefreshButton";
import {
  COLLAPSED_WIDTH,
  DEFAULT_PREFS,
  MAX_WIDTH,
  MIN_WIDTH,
  readCollapsed,
  readWidth,
  sidebarWidthCss,
  subscribeSidebar,
  writeCollapsed,
  writeWidth,
  type SidebarPrefs,
} from "@/lib/sidebar-prefs";

// ── Collapse and width now come from cookies (§46.14) ───────────────────────
//
// They used to be two module-level localStorage stores right here, each with a
// `getServerSnapshot` that returned the EXPANDED default — because localStorage does
// not exist on the server, so there was nothing else it could return. That is what
// made every page load paint the full sidebar and then snap to the rail. See
// lib/sidebar-prefs.ts for the measurement and for why this one preference is a
// cookie while §45's zoom is not.
//
// For a value that is fixed before React runs and never changes: there is no
// event to subscribe to, so the store simply never notifies.
const subscribeNever = () => () => {};

// The store shape is unchanged: useSyncExternalStore, a primitive snapshot, and a
// server snapshot — except the server snapshot is now the value the server actually
// rendered with, handed down as `initial`.

// ── Collapsed geometry, in one place each (§46.1, §46.6) ────────────────────
//
// The rail's own metrics, named rather than repeated: every collapsed control is
// centred in RAIL_ITEM and every icon target is the same size, which is what §46.6's
// "equal-sized click targets" and "centered in the collapsed sidebar" reduce to.
//
// Why the target is the full rail minus 6px: the nav used to pad 14px a side, so a
// 60px rail gave its links 32px of width — a click 10px from the rail's edge, plainly
// inside the sidebar and plainly on a row, hit nothing at all. RAIL_PAD is 3px so the
// target spans 54 of the rail's 60px while the highlight still reads as a pill rather
// than a full-bleed band.
const RAIL_PAD = "px-[3px]";
const RAIL_ITEM = "flex h-9 w-full items-center justify-center rounded-[7px]";

/** So the collapse toggle can `aria-controls` the thing it collapses (§46.15). */
const SIDEBAR_ID = "app-sidebar";

type NavItem = { href: string; label: string; icon: React.ReactNode; isActive: (path: string) => boolean };
type NavGroup = { label: string; items: NavItem[] };

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
      {children}
    </svg>
  );
}

// ── "Did my click land?" (§36.4, §36.19) ────────────────────────────────────
//
// Every tab in this app is dynamically rendered (the (app) layout awaits auth(), see
// its note), so a click is followed by a real server round trip. The destination now
// paints a skeleton for that wait — but the skeleton belongs to the CONTENT AREA, and
// the thing the user's cursor is on is this link. §36.19 wants a response within
// ~100ms; this is it.
//
// useLinkStatus (next/link, 15.3+) reports the pending state of the enclosing <Link>,
// which is why this has to be its own component rendered inside one. Its own docs warn
// that inline indicators "can easily introduce layout shifts" and recommend a
// fixed-size, always-rendered element toggled by opacity — which is exactly what this
// is: the 6px dot occupies its slot in every state, and only `data-pending` changes.
// The 120ms reveal delay lives in the CSS (.motion-link-hint), shared with the page
// skeleton, so a prefetched route that lands immediately shows neither.
function NavPendingHint() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      data-pending={pending ? "true" : "false"}
      className="motion-link-hint ml-auto flex h-1.5 w-1.5 shrink-0 items-center justify-center"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-[#4C8DE8]" />
    </span>
  );
}

// Named here so the item's own `href` below and route-permissions.ts's map
// (which decides whether the SERVER lets a direct visit through, and what
// permission gates it in the nav filter below) can never name two different
// routes by accident.
const PROFITABILITY_HREF = "/job-cost-explorer";

const GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        href: "/",
        label: "Dashboard",
        isActive: (p) => p === "/",
        icon: (
          <Icon>
            <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" />
            <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" />
            <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" />
            <rect x="9" y="9" width="5.5" height="5.5" rx="1" />
          </Icon>
        ),
      },
    ],
  },
  {
    label: "Work",
    items: [
      {
        href: "/employees",
        label: "Employees",
        isActive: (p) => p === "/employees",
        icon: (
          <Icon>
            <circle cx="6" cy="5.5" r="2.5" />
            <path d="M1.5 13.5 C1.5 10.5 3.5 9.5 6 9.5 C8.5 9.5 10.5 10.5 10.5 13.5" strokeLinecap="round" />
            <circle cx="11.5" cy="6" r="2" />
            <path d="M12 9.5 C13.8 9.8 14.8 11 14.8 13" strokeLinecap="round" />
          </Icon>
        ),
      },
    ],
  },
  {
    label: "Planning",
    items: [
      {
        href: "/quoted",
        label: "Projects",
        isActive: (p) => p === "/quoted",
        icon: (
          <Icon>
            <circle cx="8" cy="8" r="6" />
            <line x1="8" y1="2" x2="8" y2="8" strokeLinecap="round" />
          </Icon>
        ),
      },
      {
        href: "/etc",
        label: "Monthly ETC",
        isActive: (p) => p === "/etc",
        icon: (
          <Icon>
            <rect x="2" y="2" width="12" height="12" rx="1.5" />
            <line x1="2" y1="6" x2="14" y2="6" />
          </Icon>
        ),
      },
      {
        href: "/job-hours",
        label: "Job Details",
        isActive: (p) => p === "/job-hours",
        icon: (
          <Icon>
            <line x1="2" y1="14" x2="14" y2="14" strokeLinecap="round" />
            <rect x="2.5" y="8" width="2.5" height="5" rx="0.5" />
            <rect x="6.75" y="4.5" width="2.5" height="8.5" rx="0.5" />
            <rect x="11" y="6.5" width="2.5" height="6.5" rx="0.5" />
          </Icon>
        ),
      },
      {
        href: PROFITABILITY_HREF,
        label: "Profitability",
        isActive: (p) => p === PROFITABILITY_HREF,
        icon: (
          <Icon>
            <circle cx="8" cy="8" r="6.25" />
            <path d="M8 4.5 V11.5 M5.75 6.25 C5.75 5.25 6.75 4.75 8 4.75 C9.25 4.75 10.25 5.4 10.25 6.35 C10.25 8.1 5.75 7.5 5.75 9.4 C5.75 10.4 6.75 11.05 8 11.05 C9.25 11.05 10.25 10.5 10.25 9.5" strokeLinecap="round" />
          </Icon>
        ),
      },
      {
        href: "/hours",
        label: "Hours",
        isActive: (p) => p === "/hours",
        icon: (
          <Icon>
            <circle cx="8" cy="8" r="6.25" />
            <path d="M8 4.5 V8 L10.5 9.5" strokeLinecap="round" strokeLinejoin="round" />
          </Icon>
        ),
      },
      {
        href: "/tm",
        label: "T&M",
        isActive: (p) => p === "/tm",
        icon: (
          <Icon>
            <path d="M2 4.5 H14 M4.5 4.5 V2.5 H11.5 V4.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4.5 4.5 L5 13.5 H11 L11.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </Icon>
        ),
      },
      {
        href: "/build-readiness",
        label: "Build Readiness",
        isActive: (p) => p === "/build-readiness",
        icon: (
          <Icon>
            <path d="M8 1.5 L14 4.5 V11.5 L8 14.5 L2 11.5 V4.5 Z" strokeLinejoin="round" />
            <path d="M2 4.5 L8 7.5 L14 4.5 M8 7.5 V14.5" strokeLinecap="round" strokeLinejoin="round" />
          </Icon>
        ),
      },
      {
        // Gated on cash-flow:view like every other link here (2026-09-01).
        // Was ELT-only via a hardcoded role check in layout.tsx; the permission
        // is seeded ELT-only, so what shows up here has not changed.
        href: "/cash-flow",
        label: "Cash Flow Forecast",
        isActive: (p) => p === "/cash-flow",
        icon: (
          <Icon>
            <path d="M2 8 H14 M9.5 4.5 L14 8 L9.5 11.5" strokeLinecap="round" strokeLinejoin="round" />
          </Icon>
        ),
      },
    ],
  },
];

const ADMIN_GROUP: NavGroup = {
  label: "Admin",
  items: [
    {
      href: "/audit-log",
      label: "Audit Log",
      isActive: (p) => p === "/audit-log",
      icon: (
        <Icon>
          <rect x="2" y="2" width="12" height="12" rx="1.5" />
          <line x1="4.5" y1="5.5" x2="11.5" y2="5.5" strokeLinecap="round" />
          <line x1="4.5" y1="8" x2="11.5" y2="8" strokeLinecap="round" />
          <line x1="4.5" y1="10.5" x2="8.5" y2="10.5" strokeLinecap="round" />
        </Icon>
      ),
    },
    {
      href: "/admin/data-management",
      label: "Data Management",
      isActive: (p) => p === "/admin/data-management",
      icon: (
        <Icon>
          <path d="M2 4.5 C2 3.4 4.7 2.5 8 2.5 C11.3 2.5 14 3.4 14 4.5" strokeLinecap="round" />
          <path d="M2 4.5 V11.5 C2 12.6 4.7 13.5 8 13.5 C11.3 13.5 14 12.6 14 11.5 V4.5" strokeLinecap="round" />
          <path d="M2 8 C2 9.1 4.7 10 8 10 C11.3 10 14 9.1 14 8" strokeLinecap="round" />
        </Icon>
      ),
    },
    {
      href: "/admin/users",
      label: "Users & Roles",
      isActive: (p) => p === "/admin/users",
      icon: (
        <Icon>
          <circle cx="6" cy="5.5" r="2.5" />
          <path d="M1.5 13.5 C1.5 10.5 3.5 9.5 6 9.5 C8.5 9.5 10.5 10.5 10.5 13.5" strokeLinecap="round" />
          <circle cx="11.5" cy="6" r="2" />
          <path d="M12 9.5 C13.8 9.8 14.8 11 14.8 13" strokeLinecap="round" />
        </Icon>
      ),
    },
    {
      href: "/admin/permissions",
      label: "Role Permissions",
      isActive: (p) => p === "/admin/permissions",
      icon: (
        <Icon>
          <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
          <path d="M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" strokeLinecap="round" />
        </Icon>
      ),
    },
  ],
};

export default function Sidebar({
  userEmail,
  visibleHrefs,
  signOutAction,
  schedulerProjectsUrl,
  initial = DEFAULT_PREFS,
}: {
  userEmail?: string | null;
  // Computed server-side (the (app) layout) from the live Role Permissions
  // matrix — see that file's own note on why this can't be decided here with
  // hasPermission() directly: a client bundle's copy of that check is a
  // frozen build-time snapshot, and a DB-backed permission change needs to
  // reach this list on every server re-render, not just at build time.
  visibleHrefs: string[];
  /** Omitted since the SDC Tools shell owns sign-out for the whole suite (2026-08-20) — when absent no sign-out control renders. */
  signOutAction?: () => Promise<void>;
  // Absolute URL of the SDC Scheduler's Projects page, resolved server-side in
  // the layout (SCHEDULER_BASE_URL). Undefined hides the link rather than
  // rendering a dead one.
  schedulerProjectsUrl?: string;
  // Collapse + width as the SERVER resolved them from cookies. This is the
  // `getServerSnapshot` for both stores below, which is the whole fix for §46.14:
  // the value React hydrates with is the value already painted.
  initial?: SidebarPrefs;
}) {
  const pathname = usePathname();
  // ── Split view (2026-09-03) ────────────────────────────────────────────────
  //
  // Two things this adds to every nav item. A plain click follows `hrefFor`, which
  // is the item's own href normally and — while a split is open — the same /split
  // URL with only the ACTIVE pane's route replaced, so navigating one pane cannot
  // disturb the other. And a right-click offers "Open in Split View", which keeps
  // the page you are on and opens the item beside it.
  //
  // See components/useSplitNav.ts for the URL derivation and lib/split-view.ts for
  // why a split is one document with a namespaced URL rather than two frames.
  const splitNav = useSplitNav();
  // Which page the sidebar should call "current". On an ordinary route that is the
  // pathname; in the workspace it is whichever tab is active, because the pathname
  // there is always "/w".
  const sidebarPath = splitNav.workspace
    ? tabById(splitNav.workspace, splitNav.workspace.active)?.path ?? pathname
    : pathname;
  // ONE menu for both entry points — the visible ⋮ button and right-click. See
  // components/NavItemMenu.tsx for why right-click alone was not enough.
  const [navMenu, setNavMenu] = useState<NavMenuAnchor | null>(null);
  const { toast } = useToast();
  // Whether we are inside an SDC Tools shell window, resolved AFTER mount.
  // insideShell() reads a preload-injected global, which does not exist during
  // SSR — reading it in render would make the server and client disagree about
  // the "opens in a new tab" wording and the external-link arrow below, which
  // is a hydration mismatch. The click handler has no such problem: it runs
  // only on the client, so it calls decideCrossAppNav() directly.
  //
  // useSyncExternalStore, not setState-in-effect — the same idiom navOrder and
  // the collapsed state below already use, for the same hydration reason. The
  // server snapshot is `false`; the client reads the real value on the first
  // client render. The global is injected by the preload before any script
  // runs and never changes afterwards, so the subscription has nothing to
  // listen to and is a no-op by design.
  const inShell = useSyncExternalStore(subscribeNever, insideShell, () => false);

  const onSchedulerClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!schedulerProjectsUrl) return;
    const result = decideCrossAppNav("scheduler", schedulerProjectsUrl);
    if (result.mode === "anchor") return;
    e.preventDefault();
    void reportCrossAppNavError(result, (message) => toast(message, "error"));
  };
  // Every tab action, centralized. Nothing in this file decides what opening a tab
  // means any more — see components/useWorkspaceActions.ts.
  const tabs = useWorkspaceActions();
  const router = useRouter();
  // Every item is filtered against visibleHrefs — computed server-side from
  // the SAME map proxy.ts uses to decide whether a direct URL visit is let
  // through (route-permissions.ts), so a link can never be visible here and
  // refused there, or the reverse. An item whose href isn't in that map at
  // all (there are none today) would show unconditionally; every current nav
  // item has an entry.
  const visibleGroups = [...GROUPS, ADMIN_GROUP]
    .map((g) => ({ ...g, items: g.items.filter((i) => visibleHrefs.includes(i.href)) }))
    .filter((g) => g.items.length > 0);

  // User-chosen link order (localStorage, per browser). useSyncExternalStore
  // rather than reading storage in render — that would hydrate differently from
  // the server — and rather than setState-in-effect, which flickers the default
  // order for a frame and is a lint error in this repo.
  const navOrder = useSyncExternalStore(subscribeNavOrder, readNavOrder, () => NO_NAV_ORDER);
  const allGroups = visibleGroups.map((g) => ({ ...g, items: applyNavOrder(g.label, g.items, navOrder) }));
  const hasCustomOrder = Object.keys(navOrder).length > 0;

  // The drag SOURCE lives in a ref, not state: dragover/drop can fire in the same
  // tick as dragstart, and a state update isn't visible to those handlers yet —
  // which silently dropped the reorder. The ref is read synchronously and is always
  // current. State mirrors it purely so the row can dim while it's being dragged.
  const dragRef = useRef<{ group: string; index: number } | null>(null);
  const [drag, setDrag] = useState<{ group: string; index: number } | null>(null);
  const [over, setOver] = useState<{ group: string; index: number } | null>(null);

  function reorder(group: string, items: { href: string }[], from: number, to: number) {
    const hrefs = moveItem(items, from, to);
    // Nothing moved (Alt+Up on the first item, a drop onto itself, a one-item
    // group): write nothing. Persisting a no-op would light up "Reset order" as
    // though the user had customised something.
    if (hrefs.every((h, i) => h === items[i].href)) return;
    writeNavOrder({ ...navOrder, [group]: hrefs });
  }

  // Nav filter behind the search field. Groups whose every item is filtered out
  // drop away with their heading, so there are no orphan labels.
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const groups = q
    ? allGroups
        .map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(q)) }))
        .filter((g) => g.items.length > 0)
    : allGroups;

  // Ctrl+K focuses the filter. The hint is static "Ctrl K" rather than the mock's
  // ⌘K, and deliberately not platform-detected: everyone reaches this app from
  // Windows (it's LAN-only on SERVER-APP1), and detecting via `navigator` needs
  // either a setState-in-effect or a hydration-mismatching lazy initial state.
  // The handler still accepts ⌘ as well, so a Mac visitor isn't locked out.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Leaving /etc with unsaved New ETC values (typing alone doesn't autosave —
  // see EtcSectionCells/EtcAutosave) is a plain client-side route
  // change, so it never fires the browser's native beforeunload warning.
  // This is the sidebar's equivalent of that warning; every nav item runs it
  // before navigating.
  function handleNavClick(e: React.MouseEvent) {
    if (isEtcDirty() && !window.confirm("You have unsaved New ETC changes that haven't been saved. Leave this page anyway?")) {
      e.preventDefault();
    }
  }

  // Global Back — returns to the exact previous view (its URL preserves the
  // filters/sort/scroll that were active), so e.g. Projects → a job's Job Hour
  // Details → Back lands you right back on the Projects grid as you left it.
  // Hidden when there's no in-app history to return to (fresh/direct load), and
  // guarded by the same unsaved-New-ETC check as the nav items.
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => {
    // window.history isn't available during the server render; deferring to
    // an effect keeps the hydration render matched to the server's, same
    // reason as ProjectViewsMenu.tsx's readMyViews().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCanGoBack(window.history.length > 1);
  }, [pathname]);
  function handleBack() {
    if (isEtcDirty() && !window.confirm("You have unsaved New ETC changes that haven't been saved. Go back anyway?")) return;
    router.back();
  }
  // Both snapshots come from the cookies; both server snapshots come from what the
  // server rendered. On hydration those agree by construction, so there is no frame at
  // the wrong width and no label that appears and then vanishes (§46.14).
  const collapsed = useSyncExternalStore(subscribeSidebar, readCollapsed, () => initial.collapsed);
  const persistedWidth = useSyncExternalStore(subscribeSidebar, readWidth, () => initial.width);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? persistedWidth;

  function toggleCollapsed() {
    writeCollapsed(!collapsed);
  }

  // ── Keep --sidebar-w honest (§46.9) ────────────────────────────────────────
  //
  // AppShell publishes the variable with the width the SERVER resolved from the cookie.
  // That is right for the first paint and wrong from the first click onwards: a collapse
  // is a client-side state change, so without this the variable would still read 276px
  // while the rail measured 60 — a stale expanded-sidebar dimension, which is the thing
  // §46.9 names.
  //
  // A DOM write rather than lifting the state into a client AppShell: `collapsed` belongs
  // to this component, and making the shell a client component to carry one number would
  // pull the whole app's children across the boundary. Both writers call
  // sidebarWidthCss, so the value cannot be computed two ways.
  //
  // Runs on the settled width AND on dragWidth, so a drag-resize keeps it in step frame
  // by frame exactly as the aside's own inline width does.
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>("[data-app-shell]");
    shell?.style.setProperty("--sidebar-w", sidebarWidthCss({ collapsed, width }));
  }, [collapsed, width]);

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = persistedWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMouseMove(ev: MouseEvent) {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (ev.clientX - startX)));
      setDragWidth(next);
    }

    function onMouseUp(ev: MouseEvent) {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (ev.clientX - startX)));
      writeWidth(next);
      setDragWidth(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  return (
    <aside
      id={SIDEBAR_ID}
      aria-label="Primary navigation"
      // ONE width, from ONE source (§46.1). It used to be an inline width when expanded
      // and a `w-16` class when collapsed — two places to state the rail's size, and the
      // class disagreed with what the server had reserved. Now both states come from
      // here, and the collapsed value is the COLLAPSED_WIDTH token that
      // lib/sidebar-prefs.ts also gives the server for --sidebar-w.
      style={{ width: collapsed ? COLLAPSED_WIDTH : width }}
      // Pin the sidebar to the viewport height with its own internal scroll
      // (the nav is flex-1 overflow-y-auto below). Without this the aside
      // stretches to match the page content, so on tall tabs (Projects /
      // Monthly ETC grids) it grew very tall and pushed the bottom controls
      // (Zoom / Refresh / Collapse / user) far down the page — making the
      // item positions appear to shift between tabs. sticky + one viewport
      // height keeps it fixed regardless of how tall the page content is.
      // Dark navy sidebar (#061D39) — the "Porcelain" layout (design ref: SDC
      // Sidebar.html, variant 1B) recolored to the SDC brand navy.
      //
      // ── The px sizes here, and why they are now fine (§45) ────────────────
      //
      // They used to be justified as "px, not rem, deliberately": the old Text size
      // control moved the ROOT FONT SIZE, and letting the app chrome grow with it
      // made the nav crowd the content, so the sidebar was pinned to fixed pixels to
      // opt out. §45 asks for the opposite — one control that scales the sidebar
      // WITH everything else — and `zoom` gives it without touching any of these
      // numbers, because it scales px and rem alike. The design's proportions are
      // preserved at every level instead of being frozen at one.
      //
      // --app-vh, not `h-screen`: `zoom` scales `vh` along with everything else while
      // the viewport does not scale, so a 100vh sidebar hangs off the bottom of the
      // screen at 125%. See the note on that variable in globals.css.
      // ── bg-sdc-navy, not bg-[#061D39] (§46.15) ────────────────────────────
      //
      // The same colour either way — `--sdc-navy` IS #061d39 — but the class is
      // load-bearing. globals.css carries
      //
      //     .bg-sdc-navy :focus-visible { outline-color: #fff }
      //
      // because the app's default focus ring is `--sdc-blue` (#1574c4), which on this
      // navy panel is blue on navy: present, and very hard to see. That override was
      // written for exactly this surface and had never applied to it, because the
      // sidebar spelled its background as an arbitrary value instead of the token.
      // Verified in the running app: `aside.closest('.bg-sdc-navy')` was null, so every
      // focusable in the sidebar — fourteen of them in the rail, where the label is
      // hidden and focus is the only cue — took the low-contrast ring.
      className={`sticky top-0 z-20 flex h-[var(--app-vh)] max-h-[var(--app-vh)] shrink-0 flex-col self-start border-r border-[#12314F] bg-sdc-navy ${
        // motion-panel-size is the ONE justified width animation in the app (§36.15
        // discourages animating width, and rightly): the sidebar's width IS the thing
        // changing when it collapses, and no transform expresses that without leaving
        // the page content overlapped. Suppressed entirely while the user is dragging
        // the resize handle — a transition there would lag the pointer by a frame and
        // feel like the drag was fighting back.
        dragWidth === null ? "motion-panel-size" : ""
      }`}
    >
      {!collapsed && (
        <div
          onMouseDown={startResize}
          title="Drag to resize"
          className="absolute top-0 right-0 z-10 h-full w-1.5 -mr-0.5 cursor-col-resize hover:bg-white/[0.10] active:bg-white/[0.10]"
        />
      )}
      {/* ── Header (§46.8) ──────────────────────────────────────────────────────
          The logo tile is 34px and `shrink-0` in BOTH states, so collapsing cannot
          stretch or clip it and it does not move vertically — `pt-5 pb-[18px]` are the
          same either way, which is what §46.8's "prevent the top controls from shifting
          when the sidebar toggles" asks for. Only the horizontal padding changes, and
          only to centre the tile in the rail.

          The wordmark is now `sr-only` when collapsed rather than unmounted: it is the
          application's name, and a screen reader should still be able to reach it from
          the landmark (§46.15). */}
      <div className={`flex items-center gap-[11px] pt-5 pb-[18px] ${collapsed ? "justify-center px-0" : "px-[18px]"}`}>
        {/* Slightly lifted tile so the white-on-navy SDC mark still reads as a
            distinct badge against the navy panel behind it. */}
        <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-[#0D2A49] shadow-[inset_0_0_0_1px_#1B4270]">
          <Image src="/brand/sdc-logo-white.png" alt="SDC" width={26} height={14} unoptimized />
        </div>
        <div className={collapsed ? "sr-only" : "min-w-0"}>
          <p className="truncate text-sm font-semibold leading-tight tracking-[-0.005em] text-[#F3F6FA]">SDC Projects Reports</p>
          <p className="truncate text-note text-[#7E93AC]">Steven Douglas Corp.</p>
        </div>
      </div>

      {/* Search — the design shows this field, so it had to be real rather than
          decorative: it filters the nav below by label. ⌘/Ctrl+K focuses it,
          Escape clears. Hidden when collapsed (no room for a text field). */}
      {!collapsed && (
        <div className="px-[14px] pb-[14px]">
          <div className="flex h-8 items-center gap-[9px] rounded-[7px] bg-[#0B2846] px-[10px] shadow-[inset_0_0_0_1px_#17395C,0_1px_1px_rgba(0,0,0,0.35)] focus-within:shadow-[inset_0_0_0_1px_#4C8DE8]">
            <span className="h-[11px] w-[11px] shrink-0 rounded-full shadow-[inset_0_0_0_1.4px_#5F7B98]" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              placeholder="Search reports"
              aria-label="Filter navigation"
              className="min-w-0 flex-1 bg-transparent text-xs text-[#C3D1E0] placeholder:text-[#7189A3] focus:outline-none"
            />
            {query === "" && <span className="ml-auto font-mono text-label tracking-[0.04em] text-[#6E86A0]">Ctrl K</span>}
          </div>
        </div>
      )}

      {/* Back — the same RAIL_ITEM box as a nav icon when collapsed, so the top of the
          rail is one column of equal, centred targets rather than three sizes (§46.8:
          "keep the Back control centered and clearly separated"). */}
      {canGoBack && (
        <div className={`pb-1 ${collapsed ? RAIL_PAD : "px-[14px]"}`}>
          <button
            onClick={handleBack}
            title="Go back to the previous page"
            className={
              collapsed
                ? `${RAIL_ITEM} text-[#A9BCD0] hover:bg-[#0E3157] hover:text-[#F3F6FA]`
                : "flex h-8 w-full items-center gap-[10px] rounded-[7px] px-[10px] text-xs text-[#A9BCD0] hover:bg-[#0E3157] hover:text-[#F3F6FA]"
            }
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <Icon>
                <path d="M9.5 3 L4.5 8 L9.5 13" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="4.5" y1="8" x2="13" y2="8" strokeLinecap="round" />
              </Icon>
            </span>
            {/* "Back" not the mock's "Back to workspace": this runs router.back(),
                so the honest label is the one that matches the behavior.
                sr-only rather than unmounted when collapsed, so the button keeps its
                accessible name from its own content and not only from `title`
                (§46.15: "tooltips must not be the only source of accessible text"). */}
            <span className={collapsed ? "sr-only" : ""}>Back</span>
          </button>
        </div>
      )}

      {/* ── The nav (§46.6) ─────────────────────────────────────────────────────
          Two things change when collapsed, both measured problems:

          PADDING. It was `p-[14px]` in both states, so a 60px rail gave its links 32px
          of width. A click 10px inside the rail's edge — visibly on a row — hit nothing.
          RAIL_PAD is 3px, so the target is 54px wide.

          GROUP GAPS. `gap-5` between groups plus a heading inside each one reads
          correctly when the headings are visible. With them hidden the gap remained and
          the spacing went uneven: measured 36/37px between items in a group against
          52/53px between groups, which §46.6's "consistent vertical spacing" rules out.
          Collapsed, the gap collapses to the same 3px the items use, so the rail is one
          evenly spaced column. The headings stay in the DOM as `sr-only`, so the groups
          are still announced. */}
      <nav
        aria-label="Application sections"
        // `rail-scroll` only when collapsed: it hides the scrollbar so the nav's content
        // box stays the full rail width and the icons cannot drift off-centre when it
        // overflows. See the rule in globals.css for the measurement. Expanded, the
        // normal scrollbar is fine — there is width to spare and it is a useful cue.
        className={`flex min-h-0 flex-1 flex-col overflow-y-auto ${
          collapsed ? `rail-scroll gap-[3px] py-[14px] ${RAIL_PAD}` : "gap-5 p-[14px]"
        }`}
      >
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-[3px]">
            <p
              className={
                collapsed
                  ? "sr-only"
                  : "px-[10px] pb-[7px] font-mono text-micro tracking-[0.16em] text-[#6E88A5] uppercase"
              }
            >
              {group.label}
            </p>
            <div className="flex flex-col gap-[3px]">
              {group.items.map((item, index) => {
                // In the workspace the pathname is always "/w", so isActive(pathname)
                // never matched anything and NO sidebar item was highlighted. The
                // page that is actually on screen is the active tab's route.
                const active = item.isActive(sidebarPath);
                const isDragging = drag?.group === group.label && drag.index === index;
                const isOver = over?.group === group.label && over.index === index && !isDragging;
                // Tabs are supported for exactly the routes the workspace can host.
                // The ⋮ button appears for those and nowhere else, so its presence is
                // itself the signal that a page has these options.
                const hostable = tabs.canHost(item.href);
                return (
                  // The row, not the link: the ⋮ has to be a SIBLING of the <Link>. A
                  // button nested inside an anchor is invalid markup and its click
                  // would activate the link on the way past.
                  //
                  // `group/nav` is a named group so the button can reveal itself on row
                  // hover without also reacting to the sidebar's other groups.
                  <div
                    key={item.href}
                    className={`group/nav relative flex items-center ${collapsed ? "" : "gap-0.5"}`}
                  >
                  <Link
                    // Not `item.href`: while split, this resolves to the /split URL
                    // that swaps ONLY the active pane. `item.href` is still what the
                    // context menu and the drag payload use, since those are about
                    // the item itself rather than about where a click lands.
                    href={splitNav.hrefFor(item.href)}
                    onClick={(e) => {
                      // ── One implementation, in useWorkspaceActions ────────
                      //
                      // This used to run openTab + applyWorkspace inline, which made it
                      // the third place that knew what "open a tab" means — beside the
                      // href builders the context menu used and the tab strip's own "+".
                      // The ⋮ menu would have been a fourth. They are all one call now.
                      //
                      // Behaviour is unchanged and is what the request restated: resume
                      // the most recently used open instance, or open a normal tab when
                      // there is none. Inside the workspace that is a visibility toggle
                      // — the pane is already mounted behind <Activity>.
                      //
                      // Modified clicks are left to the browser: ctrl/cmd/shift-click
                      // means "open this href your way", and a real navigation is right.
                      if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
                        if (tabs.openExistingTab(item.href)) {
                          e.preventDefault();
                          return;
                        }
                      }
                      handleNavClick(e);
                    }}
                    onAuxClick={(e) => {
                      // Middle-click = another instance, the same gesture that opens a
                      // new tab in a browser. A plain click resumes the one you already
                      // have, which is what keeps duplicates from being accidental.
                      if (e.button !== 1) return;
                      e.preventDefault();
                      tabs.openNewTab(item.href);
                    }}
                    onContextMenu={(e) => {
                      // Kept as an OPTIONAL shortcut, by request — the ⋮ button beside
                      // this link is now the discoverable route to the same menu. Only
                      // where tabs are possible: an admin route has no pane view, and a
                      // menu of disabled entries is worse than the browser's own.
                      if (!hostable) return;
                      e.preventDefault();
                      setNavMenu({ href: item.href, label: item.label, x: e.clientX, y: e.clientY });
                    }}
                    title={
                      collapsed
                        ? item.label
                        : `${item.label} — middle-click for another tab; drag to reorder, or Alt+↑/↓`
                    }
                    // Reorderable by drag, and by Alt+Arrow for anyone not using a
                    // mouse. Only within this group: the headings above say what
                    // these links are, so a link that moved out from under one
                    // would make the heading wrong.
                    draggable={group.items.length > 1}
                    onDragStart={(e) => {
                      dragRef.current = { group: group.label, index };
                      setDrag({ group: group.label, index });
                      // Firefox ignores a drag with no payload; the href is also the
                      // sensible thing to hand to anything else that accepts a drop.
                      e.dataTransfer.setData("text/plain", item.href);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      const src = dragRef.current;
                      if (!src || src.group !== group.label) return; // never across groups
                      e.preventDefault(); // required, or the drop never fires
                      e.dataTransfer.dropEffect = "move";
                      setOver({ group: group.label, index });
                    }}
                    onDrop={(e) => {
                      const src = dragRef.current;
                      if (!src || src.group !== group.label) return;
                      e.preventDefault();
                      reorder(group.label, group.items, src.index, index);
                      dragRef.current = null;
                      setDrag(null);
                      setOver(null);
                    }}
                    onDragEnd={() => {
                      dragRef.current = null;
                      setDrag(null);
                      setOver(null);
                    }}
                    onKeyDown={(e) => {
                      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                      e.preventDefault(); // don't scroll the nav while moving an item
                      reorder(group.label, group.items, index, index + (e.key === "ArrowUp" ? -1 : 1));
                    }}
                    // ── The current page, announced and not only coloured (§46.7, §46.15)
                    //
                    // `aria-current="page"` was missing app-wide. The active state was a
                    // background tint, an icon colour and an accent bar — three visual
                    // cues and nothing a screen reader could report, and in the rail the
                    // label is not visible either, so there was no non-visual way at all to
                    // tell which page you were on. This is the fix for §46.7's "do not rely
                    // on color alone" as much as for §46.15.
                    aria-current={active ? "page" : undefined}
                    // ── No justify-center toggle (§36.12: "icons and labels must not
                    // jump") ────────────────────────────────────────────────────
                    //
                    // It used to add `justify-center` when collapsed, which is what made
                    // collapsing lurch: the class applies on the frame of the click while
                    // the aside is still 276px wide, so the icon leapt to the middle of a
                    // wide panel and the panel then narrowed around it.
                    //
                    // The rail now centres its icons a different way — `justify-center` on
                    // a FULL-WIDTH item (RAIL_ITEM), not on a 32px one — so the icon has
                    // nowhere to leap to: the item is as wide as the box it is centred in
                    // in both states. That also fixes the 1.5px offset the old note
                    // measured and accepted, and makes the whole 54px row clickable
                    // instead of only the icon (§46.6).
                    // min-w-0 with flex-1: the label truncates inside the row rather
                    // than pushing the ⋮ out of it.
                    className={`relative text-sm motion-interactive ${
                      collapsed ? RAIL_ITEM : "flex h-9 min-w-0 flex-1 items-center gap-[11px] rounded-[7px] px-[10px]"
                    } ${
                      active
                        ? "bg-[#0E3159] font-medium text-[#FFFFFF] shadow-[inset_0_0_0_1px_#1B4270,0_1px_2px_rgba(0,0,0,0.45)]"
                        : "text-[#C3D1E0] hover:bg-[#0E3157]"
                    } ${isDragging ? "opacity-40" : ""} ${
                      // Insertion line where the dragged item would land, drawn on
                      // the target rather than moving anything until the drop.
                      isOver ? "shadow-[inset_0_2px_0_0_#4C8DE8]" : ""
                    }`}
                  >
                    {/* The active-page accent bar fades in rather than appearing (§36.12:
                        "the active-tab indicator must transition cleanly"). It is
                        absolutely positioned, so it has never affected the row's layout —
                        only its arrival was abrupt.
                        Not drawn in the rail: it is a 2px bar on the item's left edge,
                        which when the item was 32px wide floated in the middle of the rail
                        pointing at nothing. Collapsed, the tinted pill IS the indicator —
                        §46.7 asks for "one compact highlight around the active icon", and
                        one is what it now gets. */}
                    {active && !collapsed && (
                      <span className="motion-fade absolute top-[9px] bottom-[9px] left-0 w-[2px] rounded-r-[2px] bg-[#4C8DE8]" />
                    )}
                    <span className={`flex h-[15px] w-[15px] shrink-0 items-center justify-center ${active ? "text-[#4C8DE8]" : "text-[#8FA6BE]"}`}>
                      {item.icon}
                    </span>
                    {/* The label is HIDDEN, not removed (§46.15). Unmounting it took the
                        link's accessible name with it and left `title` as the only source,
                        which is exactly what that clause forbids. */}
                    <span className={collapsed ? "sr-only" : "truncate"}>{item.label}</span>
                    {!collapsed && <NavPendingHint />}
                  </Link>
                  {/* ── The visible affordance ──────────────────────────────────
                      Not drawn in the collapsed rail: the row is a 32px icon there with
                      no room beside it, and right-click still reaches the same menu.
                      Expanded, it is always present for a hostable page so that the
                      options are discoverable without knowing about right-click. */}
                  {hostable && !collapsed && (
                    <NavItemMenuButton
                      label={item.label}
                      open={navMenu?.href === item.href}
                      onOpen={(rect) =>
                        setNavMenu(
                          navMenu?.href === item.href
                            ? null
                            : // Anchored under the button's left edge rather than at a
                              // pointer position, so a keyboard activation lands the
                              // menu somewhere sensible too.
                              { href: item.href, label: item.label, x: rect.left, y: rect.bottom + 4 },
                        )
                      }
                    />
                  )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {/* Only offered once the order has actually been customised — a permanent
            "Reset order" would be clutter for the majority who never drag anything. */}
        {hasCustomOrder && !collapsed && (
          <button
            type="button"
            onClick={clearNavOrder}
            className="self-start px-[10px] text-label text-[#6E88A5] underline decoration-dotted underline-offset-2 hover:text-[#C3D1E0]"
            title="Put the sidebar links back in their default order"
          >
            Reset order
          </button>
        )}

        {/* Cross-app link out to the SDC Scheduler. Deliberately NOT part of
            GROUPS: those are internal next/link routes with an isActive test,
            while this is a different app on another port — a plain <a> in a new
            tab, so the report you're on is never lost. The Scheduler has the
            mirror-image button back to here. */}
        {schedulerProjectsUrl && (
          <div className="flex flex-col gap-[3px]">
            <p
              className={
                collapsed ? "sr-only" : "px-[10px] pb-[7px] font-mono text-micro tracking-[0.16em] text-[#6E88A5] uppercase"
              }
            >
              Apps
            </p>
            <a
              href={schedulerProjectsUrl}
              onClick={onSchedulerClick}
              target="_blank"
              rel="noopener noreferrer"
              title={
                inShell
                  ? "Project Scheduler — opens the SDC Scheduler's Projects page in SDC Tools"
                  : "Project Scheduler — opens the SDC Scheduler's Projects page in a new tab"
              }
              className={`text-sm text-[#C3D1E0] motion-interactive hover:bg-[#0E3157] ${
                collapsed ? RAIL_ITEM : "flex h-9 items-center gap-[11px] rounded-[7px] px-[10px]"
              }`}
            >
              <span className="flex h-[15px] w-[15px] shrink-0 items-center justify-center text-[#8FA6BE]">
                {/* Same staggered gantt bars used for the Scheduler link in the
                    grids, so the two read as the same destination. */}
                <Icon>
                  <line x1="2.5" y1="3.5" x2="9.5" y2="3.5" strokeLinecap="round" />
                  <line x1="5.5" y1="8" x2="13.5" y2="8" strokeLinecap="round" />
                  <line x1="3.5" y1="12.5" x2="10.5" y2="12.5" strokeLinecap="round" />
                </Icon>
              </span>
              <span className={collapsed ? "sr-only" : "truncate"}>Project Scheduler</span>
              {/* External-link cue, matching the new-tab behavior — and dropped
                  inside the shell, where the click opens an SDC Tools window
                  rather than leaving for a browser. Dropped in the rail too:
                  there is no room for a second glyph beside the icon, and the tooltip
                  and the sr-only label both say it opens in a new tab. */}
              {!collapsed && !inShell && (
                <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" className="ml-auto shrink-0 text-[#6E88A5]">
                  <path d="M6 3 H13 V10" strokeLinecap="round" strokeLinejoin="round" />
                  <line x1="13" y1="3" x2="6.5" y2="9.5" strokeLinecap="round" />
                </svg>
              )}
            </a>
          </div>
        )}
      </nav>

      {/* ── Footer block (§46.5, §46.11) ────────────────────────────────────────
          One bordered group holding Zoom, Refresh, the collapse toggle and the account
          row.

          `shrink-0` is the fix for the reported clipping, and it is worth being precise
          about what went wrong because the symptom did not look like a flex bug.

          The aside is a fixed-height column: `h-[var(--app-vh)]` with the nav as
          `flex-1 overflow-y-auto`. This footer had no `shrink-0`, and the two buttons
          inside it carried `flex-1` — which they need SIDE BY SIDE when expanded, but
          which in the collapsed `flex-col` becomes a rule about HEIGHT: `flex: 1 1 0%`
          sets `flex-basis: 0`, and flex-basis beats `h-[30px]` on the main axis. So the
          two 30px buttons rendered **14px tall**, with "Refresh Data" clipped to
          "Refresh Dat" inside a 59px box.

          Measured before the fix, in the running app: Refresh h=14, Expand h=14. That is
          the screenshot. The fix is structural, not cosmetic — the footer refuses to
          shrink, and `flex-1` is applied only in the state that wants it. */}
      <div className={`flex shrink-0 flex-col border-t border-[#12314F] pt-2.5 pb-3 ${collapsed ? RAIL_PAD : "px-[14px]"}`}>
        {/* THE size control for the whole application (§45). Here, and only here:
            the Monthly ETC and Projects toolbars used to carry their own Text size,
            Font size, Row height and Column width steppers, so the same app could
            be at two densities on two tabs. See lib/app-zoom.ts. */}
        <AppZoom collapsed={collapsed} />

        {/* ── Split View, on its own row (2026-09-03) ──────────────────────────
            The discoverable half of the feature. The right-click menu on a nav item
            is the useful entry point — it is the only one that can say WHICH page to
            open beside this one — but a context menu discovers nobody, so this
            states that the feature exists and what the gesture is.

            Its behaviour depends on which state you are in, and it only ever does
            the unambiguous thing:
              not split  There is no way to guess which page you want beside this
                         one, so this does not open a split. It points at the
                         gesture that can, and stays disabled-looking rather than
                         picking a page for you.
              split      Closes it, leaving the active pane full width — the same
                         thing Ctrl+\ does, which is why the shortcut is on the
                         label rather than hidden in a tooltip.

            Full width in both states, and label-free when collapsed, for the same
            reason recorded in App Refresh's note directly below: this footer's
            widths have been guessed wrong before, and at 128px two labels already
            fill a row. */}
        <div className="flex pt-1">
          {splitNav.isSplit ? (
            <button
              type="button"
              onClick={() => {
                if (isEtcDirty() && !window.confirm("You have unsaved New ETC changes that haven't been saved. Leave this page anyway?")) return;
                // The pane you are working in is the one that survives.
                router.push(closePaneHref(splitNav.state!, splitNav.state!.active === "l" ? "r" : "l"));
              }}
              title="Close split view (Ctrl+\) — the active pane fills the window"
              className={`motion-interactive flex h-[30px] w-full items-center justify-center gap-[7px] rounded-[7px] bg-[#123A63] text-xs whitespace-nowrap text-[#DCE8F5] shadow-[inset_0_0_0_1px_#1E568F] hover:bg-[#17497C] ${
                collapsed ? "shrink-0" : "px-2"
              }`}
            >
              <SplitIcon />
              {!collapsed && <span>Exit Split View</span>}
            </button>
          ) : (
            <div
              title="Right-click any page in the sidebar and choose “Open in Split View” to open it beside this one"
              className={`flex h-[30px] w-full cursor-default items-center justify-center gap-[7px] rounded-[7px] bg-[#0B2846] text-xs whitespace-nowrap text-[#5A7391] shadow-[inset_0_0_0_1px_#17395C] ${
                collapsed ? "shrink-0" : "px-2"
              }`}
            >
              <SplitIcon />
              {!collapsed && <span>Split View</span>}
            </div>
          )}
        </div>

        {/* ── App Refresh, on its own row (2026-09-02) ─────────────────────────
            The SECOND refresh: it reloads this tab's frontend and changes no data
            — see AppRefreshButton for why the two are deliberately separate
            controls rather than one.

            Its own row rather than a third button beside Refresh Data and
            Collapse. The note above records what happened the last time this
            footer's widths were guessed at: at 128px the two existing labels
            already fill the row, and a third would have clipped all three. Full
            width expanded, full rail collapsed, so no label competes for space in
            either state. */}
        <div className={`flex pt-1 ${collapsed ? "flex-col" : ""}`}>
          <AppRefreshButton
            compact={collapsed}
            className={`motion-interactive flex h-[30px] w-full items-center justify-center gap-[7px] rounded-[7px] bg-[#0B2846] text-xs whitespace-nowrap text-[#C3D1E0] shadow-[inset_0_0_0_1px_#17395C] hover:bg-[#0E3157] disabled:opacity-60 ${
              collapsed ? "shrink-0" : "px-2"
            }`}
          />
        </div>

        {/* Side-by-side in the mock rather than the two stacked full-width rows
            this used to be — it reclaims a row of vertical space. Stacks again
            when collapsed, where there's no width for two. */}
        <div className={`flex gap-[3px] pt-1 pb-2.5 ${collapsed ? "flex-col" : "gap-1.5"}`}>
          {/* THE refresh control (§25). It used to be `window.location.reload()` —
              which, to anyone reading the label, was a second refresh button that
              refreshed no data at all: it re-read the same rows the last sync had left
              behind. It now runs the one application-wide pass, from every page, and the
              reload it replaces is unnecessary because the action revalidates the routes
              and broadcasts to the other tabs. */}
          {/* ── One Refresh Data, and it lives here (§41.16, 2026-08-05) ────────
              This was hidden on /etc from §29 until 2026-08-05, because §29 had moved a
              second copy into the Monthly ETC toolbar on the reasoning that "the sidebar
              collapses to a rail, and a control nobody can find is not a control".
              §41.16 reverses that and asks for one application-wide control here. The
              discoverability worry §29 raised is real but is answered by the rail rather
              than by a second button: `compact={collapsed}` keeps it visible as an icon
              with its label as a tooltip, so it never disappears — and the ETC toolbar
              copy is gone, so there is exactly ONE on screen on every route.
              There was only ever one refresh PATH (lib/refresh-actions ->
              refresh-service -> runAllSyncs); this was always about how many buttons
              point at it. */}
          <RefreshDataButton
            compact={collapsed}
            // `dense` keeps its label to what fits beside Collapse at 128px (see the note
            // on the prop). Irrelevant when compact, which shows no label at all.
            dense
            // `flex-1` ONLY when expanded — see the footer's note. In the rail it made
            // this a 14px-tall sliver with a clipped label.
            className={`motion-interactive flex h-[30px] items-center justify-center gap-[7px] rounded-[7px] bg-[#0B2846] text-xs whitespace-nowrap text-[#C3D1E0] shadow-[inset_0_0_0_1px_#17395C] hover:bg-[#0E3157] disabled:opacity-60 ${
              collapsed ? "w-full shrink-0" : "flex-1 px-2"
            }`}
          />

          {/* ── One toggle, one position (§46.4) ──────────────────────────────────
              It is the same button in both states, in the same slot, so it cannot "move
              unexpectedly when the sidebar content changes". Collapsed it is a
              full-rail-width chevron pointing right (expand); expanded it is the
              labelled Collapse button.

              `aria-expanded` describes the SIDEBAR, and `aria-controls` names it, so the
              button reports the state it controls rather than relying on the label
              swapping (§46.15). */}
          <button
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls={SIDEBAR_ID}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={`flex h-[30px] items-center justify-center gap-[7px] rounded-[7px] bg-[#0B2846] text-xs text-[#C3D1E0] shadow-[inset_0_0_0_1px_#17395C] hover:bg-[#0E3157] ${
              collapsed ? "w-full shrink-0" : "flex-1"
            }`}
          >
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              <Icon>
                {collapsed ? (
                  <path d="M6 3 L11 8 L6 13" strokeLinecap="round" strokeLinejoin="round" />
                ) : (
                  <path d="M10 3 L5 8 L10 13" strokeLinecap="round" strokeLinejoin="round" />
                )}
              </Icon>
            </span>
            {/* Hidden, not removed: this is the button's accessible name, and it changes
                with the state, which is exactly what a screen reader needs to hear. */}
            <span className={collapsed ? "sr-only" : ""}>{collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
          </button>
        </div>

        {/* ── The account row, and the control that was missing entirely (§46.5) ──
            Collapsed, this used to render the avatar and NOTHING else: the email and the
            Sign out button were both inside a `{!collapsed && …}`. So there was no way to
            sign out of the application without expanding the sidebar first — the one
            control in the footer that had no rail form at all.

            It now has one: a door-out icon beside the avatar, stacked in the rail. The
            email survives as `sr-only` (and as the avatar's tooltip), so who is signed in
            is still reachable without it taking a row it does not have. */}
        <div
          className={`flex border-t border-[#12314F] pt-2.5 ${
            collapsed ? "flex-col items-center gap-[3px]" : "items-center gap-[10px] px-[10px]"
          }`}
        >
          <div
            className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-[#123B66] text-note font-semibold text-[#4C8DE8]"
            title={collapsed ? (userEmail ?? "Signed in") : undefined}
          >
            {userEmail?.[0]?.toUpperCase() ?? "?"}
          </div>
          <div className={collapsed ? "contents" : "min-w-0 flex-1"}>
            <p className={collapsed ? "sr-only" : "truncate text-note text-[#C3D1E0]"}>{userEmail}</p>
            {signOutAction && (
            <form action={signOutAction} className={collapsed ? "w-full" : undefined}>
              <button
                onClick={(e) => {
                  if (isEtcDirty() && !window.confirm("You have unsaved New ETC changes that haven't been saved. Sign out anyway?")) {
                    e.preventDefault();
                  }
                }}
                title={collapsed ? "Sign out" : undefined}
                className={
                  collapsed
                    ? "flex h-[26px] w-full items-center justify-center rounded-[7px] text-[#7189A3] motion-interactive hover:bg-[#0E3157] hover:text-[#C3D1E0]"
                    : "text-note text-[#7189A3] hover:text-[#C3D1E0] hover:underline"
                }
              >
                {collapsed && (
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden>
                    <Icon>
                      <path d="M6.5 2.5 H3.5 A1 1 0 0 0 2.5 3.5 V12.5 A1 1 0 0 0 3.5 13.5 H6.5" strokeLinecap="round" strokeLinejoin="round" />
                      <line x1="6.5" y1="8" x2="13.5" y2="8" strokeLinecap="round" />
                      <path d="M11 5.5 L13.5 8 L11 10.5" strokeLinecap="round" strokeLinejoin="round" />
                    </Icon>
                  </span>
                )}
                <span className={collapsed ? "sr-only" : ""}>Sign out</span>
              </button>
            </form>
            )}
          </div>
        </div>

        {/* The running application version. In the sidebar, so it is on every tab
            without each page having to render it, and sourced from
            lib/app-version.ts — which reads the ONE value in package.json — so no
            component can ever report a different number.
            Collapsed it is `sr-only`: a version string does not fit in a 60px rail
            (§46.2 lists it among the things that must not appear clipped), but it is the
            first thing anyone is asked for in a bug report, so it stays reachable to a
            screen reader and in the tooltip rather than being unmounted. */}
        <div
          className={
            collapsed ? "sr-only" : "border-t border-[#12314F] px-[10px] pt-2 text-label text-[#5A7391]"
          }
          title={`SDC Projects Reports ${appVersionLabel()}`}
        >
          {appVersionLabel()}
        </div>
      </div>

      {/* ── The nav item's context menu (2026-09-03) ────────────────────────────
          Rendered once at the aside's own level rather than inside each of the
          fourteen nav items: one open menu at a time is the invariant, and a menu
          nested inside the item would be clipped by the nav's `overflow` and would
          inherit the item's hover styling.

          Fixed-positioned at the pointer, like a native context menu. It is
          deliberately NOT a full popover system — two entries, no submenus, no
          icons; the sidebar already has a drag-reorder interaction on these same
          items and a heavier menu here would start competing with it. */}
      {navMenu && (
        // Every entry goes through useWorkspaceActions, so this renders identically and
        // behaves identically whether it was opened by the ⋮ button or by right-click.
        <NavItemMenu
          anchor={navMenu}
          onClose={() => setNavMenu(null)}
          instances={tabs.instancesOf(navMenu.href)}
          duplicable={tabs.duplicableInstance(navMenu.href)}
          refusal={tabs.refusalFor(navMenu.href)}
          refusesSecondInstance={tabs.refusesSecondInstance(navMenu.href)}
          onOpenNewTab={() => tabs.openNewTab(navMenu.href)}
          onOpenInSplitView={(opts) => tabs.openInSplitView(navMenu.href, opts)}
          onDuplicate={(id) => tabs.duplicateTab(id)}
        />
      )}
    </aside>
  );
}

function SplitIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <line x1="8" y1="2.5" x2="8" y2="13.5" />
    </svg>
  );
}
