// Group-level loading state for /(app) pages. These tabs are server components
// that fetch from the DB (and sometimes Power BI / TotalETO), so without this
// the tab appears frozen on the previous page until the new one is ready. This
// renders inside the (app) layout, so the sidebar stays put and only the
// content area shows the indicator — instant feedback on every tab transition.
//
// ── Was a centred spinner; is now the page's shape (§36.4, §36.9) ────────────
//
// The previous version was one spinner in the middle of a 60vh box. Two things
// were wrong with that and both are named in §36:
//
//   * §36.4 asks for the destination page SHELL, not a blank area — "avoid blank
//     white screens", "avoid large layout jumps", "do not wait for all background
//     data before displaying the page structure". A lone spinner is a blank
//     screen with a spinner on it, and every one of these tabs then jumped from
//     centred-nothing to a top-aligned header + toolbar + grid.
//   * §36.9 forbids "full-page spinners for small actions" and asks to "prevent
//     loading-state flicker for very fast requests". Every route here shares this
//     one fallback, so a warm tab that renders in 80ms still flashed it.
//
// The shape below is the shape every tab in this app actually has — a title, a
// toolbar row, a bounded data grid — so what appears is where the content will
// be, and the swap moves nothing. It is deliberately generic: the earlier note
// warned that a fake skeleton "would flash misleadingly on the faster pages", and
// the answer to that is the delay, not the absence of a shell.
//
// The delay is CSS, not state: `motion-loading-reveal` starts at opacity 0 and
// fades in only after --motion-loading-delay (120ms). A navigation that resolves
// before then paints nothing at all — no timer to clear, nothing left behind if
// the route lands mid-delay, because the element unmounts with the fallback.
// See the Motion system section of globals.css.
//
// Every block here animates opacity only (§36.15), and the pulse is dropped
// entirely under prefers-reduced-motion (§36.16).

// One skeleton block. `motion-skeleton` is the shared opacity pulse; the size is
// the caller's, because a skeleton that does not match what replaces it is the
// layout shift it was supposed to prevent.
function Block({ className }: { className: string }) {
  return <div className={`motion-skeleton rounded bg-sdc-border-soft ${className}`} />;
}

export default function AppLoading() {
  return (
    <div
      className="motion-loading-reveal p-6"
      aria-busy="true"
      aria-live="polite"
      // The whole shell is decorative: it conveys "the page is coming", which the
      // live region below says in words. Marking it hidden keeps a screen reader
      // from reading out a dozen empty boxes.
      role="presentation"
    >
      <span className="sr-only" aria-live="polite">
        Loading…
      </span>

      {/* Page heading + the action that usually sits opposite it. */}
      <div className="mb-5 flex items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Block className="h-5 w-56" />
          <Block className="h-3 w-80" />
        </div>
        <Block className="h-9 w-32 shrink-0" />
      </div>

      {/* Toolbar row — the filter pills / month picker / export controls every
          grid tab carries. Fixed heights matching TOOLBAR_BTN's h-9, so the real
          toolbar lands exactly here. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Block className="h-9 w-28" />
        <Block className="h-9 w-24" />
        <Block className="h-9 w-24" />
        <Block className="h-9 w-20" />
      </div>

      {/* The grid. A real bordered container with a header band and rows, because
          that container is what stops the page growing and shrinking as the rows
          arrive. */}
      <div className="overflow-hidden border border-sdc-border bg-white shadow-sm">
        <div className="flex items-center gap-4 border-b-2 border-sdc-border px-3 py-2.5">
          <Block className="h-2.5 w-10" />
          <Block className="h-2.5 w-24" />
          <Block className="h-2.5 w-16" />
          <Block className="h-2.5 w-16" />
          <Block className="ml-auto h-2.5 w-20" />
        </div>
        {/* Eight rows: enough to read as a table, few enough that the fallback
            itself is cheap to paint on the frame the navigation starts. */}
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-sdc-border-soft px-3 py-2">
            <Block className="h-2.5 w-8" />
            <Block className="h-2.5 w-32" />
            <Block className="h-2.5 w-14" />
            <Block className="h-2.5 w-14" />
            <Block className="ml-auto h-2.5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
