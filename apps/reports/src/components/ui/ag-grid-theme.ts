import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

// ── The one AG Grid theme, and the one module registration ──────────────────
//
// Lifted out of AuditLogGridInner.tsx on 2026-09-17, when the feedback queue
// became the second ag-grid in the app. It was inline there and would have
// been copy-pasted here, which is exactly the failure Drill.tsx's header
// records for the charts (§39.16): two "identical" theme definitions that
// drift, and a grid that quietly renders at a different font size from its
// neighbour. One export, so a brand change reaches every grid.
//
// ModuleRegistry.registerModules is idempotent, and calling it at module scope
// here means a new grid cannot forget it — the failure mode for that is an
// empty grid with a console warning, which looks like a data bug and gets
// debugged as one.
ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * AG Grid v36 Theming API (no CSS import needed) — tuned to the SDC brand so a
 * grid reads like the rest of the app.
 *
 * The font sizes look implausibly small because they are in the app's zoomed
 * coordinate space (§45) rather than in CSS pixels; leave them alone unless
 * you are changing the zoom system itself.
 */
export const sdcTheme = themeQuartz.withParams({
  accentColor: "#1574C4",
  headerBackgroundColor: "#061D39",
  headerTextColor: "#ffffff",
  headerFontWeight: 600,
  fontFamily: "inherit",
  fontSize: 8,
  headerFontSize: 8,
  rowHoverColor: "#e6f0fa",
  borderColor: "#e6e9ee",
  wrapperBorderRadius: 12,
  oddRowBackgroundColor: "#fafbfc",
});

/** The height every full-page grid uses, so two of them can't disagree. */
export const GRID_HEIGHT = "calc(var(--app-vh) - 175px)";
