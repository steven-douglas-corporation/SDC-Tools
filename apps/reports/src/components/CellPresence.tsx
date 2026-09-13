"use client";

import { useCellPresence } from "@/components/RealtimeProvider";

// The "somebody else is editing this cell" indicator (spec 3).
//
// Rendered inside an editable cell, absolutely positioned so it cannot change the
// cell's size — this grid is 800 cells of fixed width and an indicator that
// reflowed the layout every time a colleague clicked something would be unusable.
//
// It names the user, and the cell's own row/column identity is already visible from
// where the marker sits, so the dot carries the name in its tooltip rather than
// spelling out all four facts on a 64px cell. The full sentence (user, tab, row,
// column) is in the `title`, which is what a manager reads before typing.
//
// Deliberately shows the FIRST editor plus a count rather than a list: two people in
// one cell is already the situation the warning exists for, and a stack of names
// would not fit.
export function CellPresence({ cellKey }: { cellKey: string }) {
  const editors = useCellPresence(cellKey);
  if (editors.length === 0) return null;

  const first = editors[0];
  const others = editors.length - 1;
  const who = others > 0 ? `${first.userName} +${others}` : first.userName;
  const title =
    `${who} ${editors.length > 1 ? "are" : "is"} editing ${first.columnName} for ${first.rowRef} in ${first.tab}. ` +
    `Your change may conflict — check the current value before saving.`;

  return (
    <span
      // Top-right of the cell, clear of the caret and of the yellow
      // needs-attention background.
      className="pointer-events-none absolute top-0 right-0 z-10 flex items-center gap-0.5 rounded-bl bg-[#7C3AED] px-1 text-micro leading-[11px] font-semibold text-white"
      title={title}
      aria-label={title}
    >
      <span className="inline-block h-1 w-1 rounded-full bg-white/90" />
      {/* Initials only — a full name does not fit a 64px column, and the tooltip
          carries the whole sentence. */}
      {initials(first.userName)}
      {others > 0 ? `+${others}` : ""}
    </span>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}
