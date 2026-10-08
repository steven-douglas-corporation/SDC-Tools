import { cardStats, type CardStatsInput } from "@/lib/card-stats";
import { hours as fmtHours } from "@/components/ui/format";

// The stat block under a department card's title (2026-10-08), shared by the Cards
// view and the Org chart so the two read alike. What it says — and why — is in
// lib/card-stats.ts. With a capacity drill (`onOpen`) the whole block is one
// button: the numbers are what the breakdown explains.

const BASE = "border-b border-sdc-border bg-sdc-gray-50 px-3.5 py-2 text-xs text-sdc-muted";

export function CardStats({
  stats,
  onOpen,
  shown,
}: {
  stats: CardStatsInput;
  /** Opens the capacity breakdown; omitted, the block is plain text. */
  onOpen?: () => void;
  /** While searching: how many of the card's people are drawn. Omitted when nothing is filtered out. */
  shown?: { shown: number; of: number } | null;
}) {
  const s = cardStats(stats, fmtHours);
  const hasHours = s.rows[0].hours != null;

  const body = s.table ? (
    <div className={`grid items-baseline gap-x-4 gap-y-0.5 tabular-nums ${hasHours ? "grid-cols-[1fr_auto_auto]" : "grid-cols-[1fr_auto]"}`}>
      <span />
      <span className="text-right text-label font-semibold uppercase tracking-[0.04em] text-sdc-gray-600">People</span>
      {hasHours && <span className="text-right text-label font-semibold uppercase tracking-[0.04em] text-sdc-gray-600">Hrs/yr</span>}
      {s.rows.map((r) => {
        const tone = r.key === "hiring" ? "text-sdc-green-text" : "text-sdc-navy";
        const rule = r.key === "planned" ? "border-t border-sdc-border pt-0.5" : "";
        return (
          <div key={r.key} className="contents">
            <span className={rule}>{r.label}</span>
            <span className={`text-right font-bold ${tone} ${rule}`}>{r.people}</span>
            {hasHours && <span className={`text-right font-bold ${tone} ${rule}`}>{r.hours}</span>}
          </div>
        );
      })}
    </div>
  ) : (
    <div>
      <span className="font-bold tabular-nums text-sdc-navy">{s.rows[0].people}</span> people
      {hasHours && (
        <>
          <span className="mx-1.5 text-sdc-gray-400">·</span>
          <span className="font-bold tabular-nums text-sdc-navy">{s.rows[0].hours}</span> hrs/yr
        </>
      )}
    </div>
  );

  const notes = (s.inactive > 0 || shown) && (
    <div className="mt-1 flex flex-wrap gap-x-3 text-note text-sdc-gray-600">
      {s.inactive > 0 && <span>{s.inactive} inactive</span>}
      {shown && <span>{shown.shown} of {shown.of} shown</span>}
    </div>
  );

  if (!onOpen) {
    return (
      <div className={BASE}>
        {body}
        {notes}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title="See how this capacity total was built, by employee and open position"
      className={`block w-full text-left hover:bg-sdc-blue-light/30 ${BASE}`}
    >
      {body}
      {notes}
    </button>
  );
}
