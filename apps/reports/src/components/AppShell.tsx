import Sidebar from "@/components/Sidebar";
import ExcelCellFocus from "@/components/ExcelCellFocus";
import ColumnResize from "@/components/ColumnResize";
import ScrollHandoff from "@/components/ScrollHandoff";
import { ToastProvider } from "@/components/ui/Toast";
import { DEFAULT_PREFS, sidebarWidthCss, type SidebarPrefs } from "@/lib/sidebar-prefs";

export default function AppShell({
  children,
  userEmail,
  visibleHrefs,
  signOutAction,
  schedulerProjectsUrl,
  sidebar = DEFAULT_PREFS,
}: {
  children: React.ReactNode;
  userEmail?: string | null;
  /** Which nav hrefs this role may see, computed server-side in the (app) layout — see its own note on why this can't be decided inside Sidebar itself. */
  visibleHrefs: string[];
  /** Omitted since the SDC Tools shell owns sign-out for the whole suite (2026-08-20) — when absent the sidebar renders no sign-out control. */
  signOutAction?: () => Promise<void>;
  schedulerProjectsUrl?: string;
  /** Resolved from cookies in the (app) layout, so the first paint is already correct. */
  sidebar?: SidebarPrefs;
}) {
  // --app-vh rather than `min-h-screen`: `zoom` (§45) scales `vh` along with every
  // other length while the viewport itself does not scale, so a raw 100vh would be a
  // screen and a half at 150%. See the note on that variable in globals.css.
  //
  // ── --sidebar-w, the shared layout variable (§46.9) ────────────────────────
  //
  // §46.9 asks for "a shared layout variable for the current sidebar width instead of
  // hardcoded margins in individual pages". The good news, confirmed by audit: no page
  // has ever had such a margin — this is a flex row, the aside is `shrink-0` at its own
  // width and `main` is `flex-1`, so the content offset IS the sidebar width by
  // construction and cannot be computed from a stale one.
  //
  // The variable is published anyway, and earns its place twice. It is the value the
  // SERVER resolved, so it is what the first paint agrees on before any client store
  // exists. And anything that later needs the sidebar's width (a fixed-position panel, a
  // popover boundary) now has one place to read it rather than a second copy of the
  // number.
  //
  // `data-app-shell` is how the Sidebar finds this element to keep the variable in step
  // when the user toggles — see the effect there. Without that, a client-side collapse
  // would leave this at the width the SERVER rendered, which is precisely the "stale
  // expanded-sidebar dimension" §46.9 forbids. Both writers derive the value from
  // sidebarWidthCss, so there is one formula and not two.
  // ── ToastProvider wraps the WHOLE shell, not just <main> (2026-08-10) ───────
  //
  // It used to wrap only {children} inside <main>, which left the Sidebar — and
  // everything rendered inside it — outside the toast context entirely.
  // RefreshDataButton lives in the Sidebar (moved there §41.16, 2026-08-05) and
  // calls toast() on every refresh outcome; useToast() silently no-ops when
  // there is no provider ancestor, so every one of those calls — including the
  // ones marked `critical: true` specifically so they would always reach the
  // user — has never actually rendered anything. Found auditing this exact
  // guarantee, not reported on its own; fixed here rather than left for whoever
  // next wonders why a "critical" refresh toast never shows.
  return (
    <ToastProvider>
      <div
        data-app-shell
        className="flex min-h-[var(--app-vh)]"
        style={{ "--sidebar-w": sidebarWidthCss(sidebar) } as React.CSSProperties}
      >
        {/* Keyboard/AT skip-link — jumps past the sidebar to the page content.
            Visually hidden until focused. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-sdc-navy focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to content
        </a>
        <Sidebar userEmail={userEmail} visibleHrefs={visibleHrefs} signOutAction={signOutAction} schedulerProjectsUrl={schedulerProjectsUrl} initial={sidebar} />
        <main id="main-content" className="min-w-0 flex-1 bg-background">
          {children}
        </main>
        {/* RowSelect (click-to-highlight-a-whole-row) removed 2026-08-03 by request —
            see the note where its CSS used to live in globals.css. Hover highlighting
            and Excel-style cell focus are unaffected. */}
        <ExcelCellFocus />
        <ColumnResize />
        {/* Nested-scroll handoff for every scroll container in the app, from one
            document-level listener. Mounted here rather than per page for the same
            reason the two above are: a page cannot forget to include it, and a
            container that appears after a client-side navigation is covered. */}
        <ScrollHandoff />
      </div>
    </ToastProvider>
  );
}
