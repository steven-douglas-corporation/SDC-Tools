import { HiringStatusPill } from "@/components/HiringStatusPill";
import { hiringStatusStyle } from "@/lib/hiring-position-status";
import { countOpenings, openingsSuffix } from "@/lib/hiring-openings";
import type { HiringPosition } from "@/lib/hiring-positions";

// "See open positions N" — the closed-by-default dropdown at the foot of a
// department card, on both the Cards view and the Org chart (2026-10-07). It
// sits under the people (and the contractors), so a card leads with who is
// there and the openings are one click away. Clicking a position opens its panel,
// where the Move to control is the override for where it sits.
//
// Native <details>, so there is no state and it works from the keyboard; no
// hooks, so it renders on server or client like the rest of the Org chart.
export function OpenPositionsDropdown({
  positions,
  onSelect,
  className = "",
}: {
  /** Already narrowed to what the viewer may see (hidden positions removed for a non-editor). */
  positions: HiringPosition[];
  onSelect?: (position: HiringPosition) => void;
  className?: string;
}) {
  if (positions.length === 0) return null;
  return (
    <details className={`group border-t border-dashed border-sdc-border ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-sdc-green-text hover:bg-sdc-gray-50 [&::-webkit-details-marker]:hidden">
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="h-3.5 w-3.5 shrink-0 motion-interactive group-open:rotate-90"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M7 4l6 6-6 6" />
        </svg>
        <span>See open positions</span>
        <span className="rounded-full bg-sdc-green-bg px-1.5 py-px tabular-nums">{countOpenings(positions)}</span>
      </summary>
      <ul className="px-1.5 pb-1.5">
        {positions.map((p) => {
          // Same three indicators as HiringPositionsList's rows, from the same
          // central lookup, so a row reads the same wherever it is drawn.
          const style = hiringStatusStyle(p.status);
          return (
            <li key={p.sourceId}>
              <button
                type="button"
                onClick={onSelect ? () => onSelect(p) : undefined}
                disabled={!onSelect}
                className={`flex w-full items-center gap-1.5 rounded-md border-l-2 px-2 py-1.5 text-left text-sm text-sdc-navy hover:brightness-95 disabled:cursor-default ${style.accent} ${style.tint}`}
                title={p.title}
              >
                <span className="min-w-0 flex-1 truncate">
                  {p.title}
                  {openingsSuffix(p.quantity)}
                </span>
                <HiringStatusPill status={p.status} />
                {!p.isVisible && (
                  <span className="shrink-0 rounded bg-sdc-yellow-bg px-1.5 py-0.5 text-micro font-bold uppercase tracking-wide text-sdc-yellow-text">
                    Hidden
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
