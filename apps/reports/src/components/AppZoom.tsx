"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_ZOOM,
  currentZoom,
  isMaxZoom,
  isMinZoom,
  readZoom,
  serverZoom,
  stepZoom,
  subscribeZoom,
  writeZoom,
  zoomLabel,
} from "@/lib/app-zoom";

// The application's one size control (§45) — `−  80%  +` in the sidebar footer,
// where "Text size" used to be. The rules it enforces and why it is CSS `zoom` are
// in lib/app-zoom.ts; this file is only the control.
//
// ── It reads through useSyncExternalStore, not useState ─────────────────────
//
// The level lives in localStorage, which the server cannot see. Reading it in render
// would hydrate differently from the server; restoring it in a mount effect would
// show the default for a frame on every page load. useSyncExternalStore is the primitive
// for exactly this — a server snapshot of the default, then the real value.
//
// Note what this state is FOR: the label and the two disabled ends, and nothing else.
// The zoom itself is already on screen before React hears about it, because writeZoom
// sets a custom property on <html> (§45: "no reload, no backend request, no rebuild").
// If this component never re-rendered, the app would still be zoomed — which is why
// switching tabs, refetching data or re-rendering a grid cannot disturb it.
//
// That is also why the two steppers step from currentZoom() rather than from `zoom`:
// see the note on that function for the fast-double-click it prevents.
//
// ── No Ctrl+ / Ctrl− binding ────────────────────────────────────────────────
//
// §45 asks that browser zoom keep working independently. Those are the browser's
// shortcuts; taking them would replace a feature that already works at the OS level
// (and composes with this one) with a worse copy of it.
export function AppZoom({ collapsed }: { collapsed?: boolean }) {
  const zoom = useSyncExternalStore(subscribeZoom, readZoom, serverZoom);

  // Dark navy sidebar styling (#061D39 panel — see Sidebar.tsx). The enclosing footer
  // block owns the border and padding, so this is just the label + stepper.
  //
  // 1.6rem (24px) rather than the 20px the text-size stepper used: this control is
  // inside the zoomed subtree, so at the 50% floor it renders 12px — §45 wants every
  // control usable at every level, and the control that ends a bad zoom is the one
  // that must never become too small to click. Deliberately NOT counter-scaled with
  // `zoom: calc(1 / var(--app-zoom))`: it would hold a constant size while its
  // neighbours moved, which reads as a rendering fault rather than a feature.
  const btn =
    "flex h-[1.6rem] w-[1.6rem] items-center justify-center rounded-[5px] bg-[#0B2846] text-sm leading-none text-[#A9BCD0] shadow-[inset_0_0_0_1px_#17395C] hover:bg-[#0E3157] disabled:opacity-40";

  const out = (
    <button
      type="button"
      onClick={() => writeZoom(stepZoom(currentZoom(), -1))}
      disabled={isMinZoom(zoom)}
      className={btn}
      aria-label="Zoom out"
      title="Zoom out — make the whole application smaller"
    >
      −
    </button>
  );
  const inn = (
    <button
      type="button"
      onClick={() => writeZoom(stepZoom(currentZoom(), 1))}
      disabled={isMaxZoom(zoom)}
      className={btn}
      aria-label="Zoom in"
      title="Zoom in — make the whole application larger"
    >
      +
    </button>
  );
  // The readout doubles as the reset, per §45. A plain <button> and not a click
  // handler on a <span>: it is a real action, so it needs a real focus ring and a
  // real Enter/Space.
  const reset = (
    <button
      type="button"
      onClick={() => writeZoom(DEFAULT_ZOOM)}
      // Not disabled at the default: a disabled control is unreadable at 40% opacity,
      // and this is primarily a READOUT. Clicking it there is simply a no-op.
      className="min-w-[2.6rem] rounded-[5px] px-1 py-0.5 text-center font-mono text-note tabular-nums text-[#C3D1E0] hover:bg-[#0E3157]"
      // The default is stated from DEFAULT_ZOOM rather than written out, so the
      // label cannot claim a level the button does not actually set.
      aria-label={`Zoom: ${zoomLabel(zoom)}. Reset to ${zoomLabel(DEFAULT_ZOOM)}`}
      title={`Reset the zoom to ${zoomLabel(DEFAULT_ZOOM)}`}
    >
      {zoomLabel(zoom)}
    </button>
  );

  // Collapsed, the sidebar is a 60px rail. The control stays — §45 requires it on
  // every page, and a rail is a page state, not a different app — but stacks
  // vertically, which is the only way the readout still fits and stays legible.
  // Same reasoning as Refresh Data keeping an icon-only form there (§41.16).
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 pb-1">
        {inn}
        {reset}
        {out}
      </div>
    );
  }

  return (
    <div className="flex min-h-[2.27rem] items-center justify-between gap-2 px-[10px]">
      <span className="text-xs text-[#7E93AC]">Zoom</span>
      <div className="flex items-center gap-1">
        {out}
        {reset}
        {inn}
      </div>
    </div>
  );
}
