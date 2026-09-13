// ── Anchored popover positioning, kept I/O-free ─────────────────────────────
//
// One rule, shared by every portaled menu that needs to sit against a specific trigger
// element rather than wherever its ancestor happens to be: `side`/`align`/`sideOffset`
// pick the PREFERRED spot, and the viewport is only consulted afterward, to shift the
// panel the minimum amount needed to stay on screen — never to re-center it, and never
// to prefer some other anchor (Views, the toolbar, the page) just because there was
// room there. "align: end" means the panel's right edge is the trigger's right edge,
// full stop, unless that would run off the viewport.
//
// Pure and DOM-free so it's testable without a browser — the same reason
// table-sort.ts's compareByType and hours-filters.ts's buildHoursWhere live in their
// own no-I/O modules. The DOM-touching half (measuring rects, a useLayoutEffect) is
// use-anchored-position.ts; this file only ever sees plain numbers.

export type Side = "top" | "bottom";
export type Align = "start" | "end" | "center";

export type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
export type Size = { width: number; height: number };

export type AnchoredPositionOptions = {
  side?: Side; // preferred side of the trigger to open on. Default "bottom".
  align?: Align; // which edge of the panel lines up with the trigger. Default "end".
  sideOffset?: number; // gap between trigger and panel along `side`. Default 4.
  pad?: number; // minimum gap kept from the viewport edge. Default 6.
};

export type AnchoredPosition = { top: number; left: number; side: Side };

/**
 * Where a panel should sit relative to `anchor`, given the panel's own size and the
 * viewport it has to stay inside. Flips to the opposite side only when the preferred
 * side genuinely doesn't fit and the opposite one does (never flips out of stubbornness
 * when the preferred side already fits, and never flips to a THIRD side — there are
 * only two). Horizontal placement is clamped, not re-aligned: it stays exactly at
 * `align`'s position until doing so would carry the panel past the viewport edge, and
 * only then shifts by the smallest amount that brings it back in bounds.
 */
export function computeAnchoredPosition(
  anchor: Rect,
  panel: Size,
  viewport: Size,
  opts: AnchoredPositionOptions = {},
): AnchoredPosition {
  const side = opts.side ?? "bottom";
  const align = opts.align ?? "end";
  const sideOffset = opts.sideOffset ?? 4;
  const pad = opts.pad ?? 6;

  const fitsBelow = anchor.bottom + sideOffset + panel.height + pad <= viewport.height;
  const fitsAbove = anchor.top - sideOffset - panel.height - pad >= 0;
  const resolvedSide: Side = side === "bottom" ? (fitsBelow || !fitsAbove ? "bottom" : "top") : fitsAbove || !fitsBelow ? "top" : "bottom";

  const top = resolvedSide === "bottom" ? anchor.bottom + sideOffset : anchor.top - sideOffset - panel.height;

  const preferredLeft = align === "end" ? anchor.right - panel.width : align === "center" ? anchor.left + anchor.width / 2 - panel.width / 2 : anchor.left;
  const maxLeft = viewport.width - panel.width - pad;
  // `pad` can legitimately exceed `maxLeft` when the panel is wider than the viewport —
  // clamping to `pad` first would then push it back past `maxLeft` and undo the clamp.
  // Preferring the smaller bound keeps the panel's chosen edge nearest the anchor.
  const left = Math.min(Math.max(preferredLeft, pad), Math.max(maxLeft, pad));

  return { top, left, side: resolvedSide };
}
