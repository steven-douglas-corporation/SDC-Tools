import { card } from "@/components/ui/classnames";
import { hours } from "@/components/ui/format";
import type { HoursBySource } from "@/lib/hours-by-source";

// The Hours page's "Hours by source" band — see lib/hours-by-source.ts for the
// three sources and the overlap rule. Server-rendered: the only interaction is a
// hover title on each bar segment, which needs no client JS.
//
// Colours are the dataviz reference categorical slots 1–3 (blue, orange, aqua),
// validated together; none of the app's chart colours were free, since
// #408bf7/#162398 already mean planned/actual. The aqua is below 3:1 against white,
// so every segment is also a labelled row with its value — the colour is never the
// only way to read it.
const SOURCE_COLORS = {
  punches: "#2a78d6",
  snapshot: "#eb6834",
  frozen: "#1baf7a",
} as const;

type Band = HoursBySource & { snapshotBeforeRange: boolean; unavailableReason: string | null; fromMonth?: string; sectionFiltered?: boolean };

function Swatch({ color, hatched }: { color?: string; hatched?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]"
      style={
        hatched
          ? { backgroundImage: "repeating-linear-gradient(45deg, #94a3b8 0 1.5px, transparent 1.5px 4px)", boxShadow: "inset 0 0 0 1px #94a3b8" }
          : { background: color }
      }
    />
  );
}

function Row({
  swatch,
  label,
  note,
  value,
  muted,
}: {
  swatch: React.ReactNode;
  label: string;
  note: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      {swatch}
      <div className="min-w-0">
        <p className={`text-xs font-semibold ${muted ? "text-sdc-muted" : "text-sdc-navy"}`}>{label}</p>
        <p className="text-label text-sdc-muted">{note}</p>
        <p className={`mt-0.5 font-heading text-lg font-bold tabular-nums ${muted ? "text-sdc-muted" : "text-sdc-navy"}`}>{value}</p>
      </div>
    </div>
  );
}

export function HoursBySourceBand({ data }: { data: Band }) {
  const h = (n: number) => `${hours(n)} h`;
  const segments =
    data.total !== null && data.total > 0
      ? [
          { key: "punches", label: "Paylocity punches (counted)", value: data.punchesCounted, color: SOURCE_COLORS.punches },
          { key: "snapshot", label: "Migration snapshot", value: data.snapshot ?? 0, color: SOURCE_COLORS.snapshot },
          { key: "frozen", label: "Frozen ETC months", value: data.frozen ?? 0, color: SOURCE_COLORS.frozen },
        ].filter((s) => s.value > 0)
      : [];

  return (
    <div className={card("p-4")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-sdc-gray-600">Hours by source</p>
          <p className="mt-0.5 text-label text-sdc-muted">
            The table lists Paylocity punches only. Older hours come from two other sources — together they make up the Actual
            Hours shown on Projects and Job Hour Details.
          </p>
        </div>
        <div className="text-right">
          <p className="font-heading text-2xl font-bold tabular-nums text-sdc-navy">{data.total === null ? "—" : h(data.total)}</p>
          <p className="text-label text-sdc-muted">all sources</p>
        </div>
      </div>

      {segments.length > 0 && (
        // One row, one scale. Segments separated by a 2px surface gap; the outer
        // ends are rounded, the joins square.
        <div className="mt-3 flex h-2.5 w-full gap-[2px] overflow-hidden rounded" role="img" aria-label={segments.map((s) => `${s.label} ${h(s.value)}`).join(", ")}>
          {segments.map((s) => (
            <span
              key={s.key}
              title={`${s.label}: ${h(s.value)} (${Math.round((s.value / data.total!) * 100)}%)`}
              style={{ flexGrow: s.value, flexBasis: 0, background: s.color, minWidth: 3 }}
            />
          ))}
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
        <Row
          swatch={<Swatch color={SOURCE_COLORS.punches} />}
          label="Paylocity punches"
          note="Everything in the table below"
          value={h(data.punches)}
        />
        <Row
          swatch={<Swatch hatched />}
          label="Already in the snapshot"
          note="Jan 2025 punches — listed, not added again"
          value={data.overlap > 0 ? `− ${h(data.overlap)}` : "none"}
          muted={data.overlap === 0}
        />
        <Row
          swatch={<Swatch color={SOURCE_COLORS.snapshot} />}
          label="Migration snapshot"
          note={data.snapshotBeforeRange ? "All before this date range" : "Lifetime totals through Jan 2025"}
          value={data.snapshot === null ? "n/a" : h(data.snapshot)}
          muted={!data.snapshot}
        />
        <Row
          swatch={<Swatch color={SOURCE_COLORS.frozen} />}
          label="Frozen ETC months"
          note="Months before the punch feed"
          value={data.frozen === null ? "n/a" : h(data.frozen)}
          muted={!data.frozen}
        />
      </div>

      {data.unavailableReason && <p className="mt-3 text-label text-sdc-yellow-text">{data.unavailableReason} Clear them to see all sources.</p>}
      {!data.unavailableReason && data.sectionFiltered && (
        <p className="mt-3 text-label text-sdc-muted">
          The older sources only know the app&apos;s standard columns, so a Section-Function filter matches them by column
          (a 40-311 filter takes all of 40-211), which can be wider than the punches it selects.
        </p>
      )}
      {!data.unavailableReason && data.fromMonth && !data.snapshotBeforeRange && (data.snapshot ?? 0) > 0 && (
        <p className="mt-3 text-label text-sdc-muted">
          The snapshot has no dates, so it&apos;s shown whole whenever the range reaches back to January 2025.
        </p>
      )}
    </div>
  );
}
