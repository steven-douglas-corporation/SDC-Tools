// Pure geometry for the Monthly ETC quick-nav bar (components/EtcQuickNav.tsx).
//
// The bar is both a row of jump buttons and a scrollbar for the grid, so it has to
// translate between two coordinate systems:
//
//   content x  — a position along the grid's scrollable width, measured from the left
//                edge of the scroller's content. The frozen #/Job Id/Job Name columns
//                occupy [0, stickyWidth); the section blocks start at stickyWidth.
//   bar x      — a position along the bar, in pixels from its left edge.
//
// The two are NOT proportional. A narrow block such as Parts Cost has to stay wide enough
// to read its own label, so the bar's segments are laid out by the browser with a minimum
// width and each one stretches its own slice of the grid. The mapping is therefore
// piecewise: linear inside a segment, with the segment's edges as the breakpoints.
// Keeping that out of the component keeps it testable without a DOM.

export type Span = { start: number; end: number };

/** Where `x` falls in `from`, expressed at the same relative place in `to`. */
export function mapAcross(x: number, from: readonly Span[], to: readonly Span[]): number {
  if (from.length === 0 || from.length !== to.length) return 0;
  if (x <= from[0].start) return to[0].start;
  const last = from.length - 1;
  if (x >= from[last].end) return to[last].end;
  for (let i = 0; i < from.length; i++) {
    const f = from[i];
    if (x > f.end) continue;
    const width = f.end - f.start;
    const t = width > 0 ? (x - f.start) / width : 0;
    return to[i].start + t * (to[i].end - to[i].start);
  }
  return to[last].end;
}

/**
 * The scrollLeft for jumping to a block: centre it in the visible window, which is the
 * scroller minus the frozen columns on its left.
 *
 * A block wider than the window cannot be centred without cutting off both its ends —
 * Complete Design and Build is wider than most screens — so that one is aligned to the
 * left edge of the window instead, where its first column is visible. The browser clamps
 * at the far right and this at the far left, so the first and last blocks land as near
 * the middle as the grid's own extent allows.
 */
export function scrollLeftForSection(
  section: Span,
  stickyWidth: number,
  clientWidth: number,
  maxScroll: number,
): number {
  const windowWidth = clientWidth - stickyWidth;
  const sectionWidth = section.end - section.start;
  const raw =
    sectionWidth >= windowWidth
      ? section.start - stickyWidth
      : (section.start + section.end) / 2 - windowWidth / 2 - stickyWidth;
  return Math.min(Math.max(0, raw), Math.max(0, maxScroll));
}

/**
 * The scrollLeft that puts the visible window's centre at `contentX`, minus `grabOffset`
 * (how far from the window's centre the user grabbed it, so dragging the thumb by its
 * edge does not snap its middle under the pointer).
 *
 * The visible window is [scrollLeft + stickyWidth, scrollLeft + clientWidth]: the frozen
 * columns cover the left of the scroller, so that part of it never shows a section.
 */
export function scrollLeftForCenter(opts: {
  contentX: number;
  grabOffset: number;
  clientWidth: number;
  stickyWidth: number;
  maxScroll: number;
}): number {
  const windowWidth = opts.clientWidth - opts.stickyWidth;
  const raw = opts.contentX - opts.grabOffset - windowWidth / 2 - opts.stickyWidth;
  return Math.min(Math.max(0, raw), Math.max(0, opts.maxScroll));
}

/** The visible window in content x. */
export function visibleWindow(scrollLeft: number, clientWidth: number, stickyWidth: number): Span {
  return { start: scrollLeft + stickyWidth, end: scrollLeft + clientWidth };
}

/**
 * Which section the user is looking at: the one with the most of its width inside the
 * visible window. Largest overlap rather than "the one at the left edge", because at the
 * far right the last block can never reach the left edge, and a narrow block should not
 * lose to the wide one that is only just clipping into view. Ties go to the earlier one.
 * Returns -1 when nothing overlaps.
 */
export function activeSectionIndex(sections: readonly Span[], view: Span): number {
  let best = -1;
  let bestOverlap = 0;
  for (let i = 0; i < sections.length; i++) {
    const overlap = Math.min(sections[i].end, view.end) - Math.max(sections[i].start, view.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = i;
    }
  }
  return best;
}
