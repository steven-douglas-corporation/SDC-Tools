import { card } from "@/components/ui/classnames";

// KPI "indicator" card modeled on Plotly's number + delta + gauge indicators
// (https://plotly.com/python/indicator/), rendered as robust CSS rather than a
// per-card chart: a prominent number, an optional delta vs a reference (▲/▼,
// colored by whether the move is good), and an optional bullet/progress bar
// showing the value against a target (a compact stand-in for the gauge — the
// form Plotly itself recommends for dense dashboards).

const GREEN = "#15803d";
const RED = "#dc2626";
const MUTED = "#64748b";

export type Delta = {
  reference: number; // what we're comparing against
  goodWhenLower?: boolean; // true → a decrease is "good" (green)
  format?: (n: number) => string;
};

export type Bullet = {
  value: number; // filled amount
  target: number; // target / budget (100% mark)
  color?: string; // fill color (default SDC blue)
};

export function IndicatorCard({
  label,
  value,
  numericValue,
  delta,
  bullet,
  tone,
  hint,
}: {
  label: string;
  value: string; // pre-formatted display value
  numericValue?: number; // raw value, needed for a delta
  delta?: Delta;
  bullet?: Bullet;
  tone?: "green";
  hint?: string;
}) {
  // Delta chip.
  let deltaEl: React.ReactNode = null;
  if (delta && numericValue != null && Number.isFinite(delta.reference)) {
    const change = numericValue - delta.reference;
    const good = delta.goodWhenLower ? change < 0 : change > 0;
    const color = change === 0 ? MUTED : good ? GREEN : RED;
    const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "▬";
    const f = delta.format ?? ((n: number) => Math.round(n).toLocaleString());
    deltaEl = (
      <span className="text-xs font-semibold tabular-nums" style={{ color }}>
        {arrow} {f(Math.abs(change))}
      </span>
    );
  }

  // Bullet / progress bar vs target.
  let bulletEl: React.ReactNode = null;
  if (bullet && bullet.target > 0) {
    const pct = Math.max(0, Math.min(1.15, bullet.value / bullet.target)); // allow a little overrun
    const over = bullet.value > bullet.target;
    const fill = bullet.color ?? "#118dff";
    bulletEl = (
      <div className="mt-2">
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-sdc-gray-100">
          <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, pct * 100)}%`, background: over ? RED : fill }} />
          {/* target tick at 100% */}
          <div className="absolute inset-y-[-2px] w-px bg-sdc-gray-400" style={{ left: "100%" }} />
        </div>
        <div className="mt-1 flex justify-between text-label tabular-nums" style={{ color: MUTED }}>
          <span>{Math.round((bullet.value / bullet.target) * 100)}% of target</span>
          <span>{(bullet.target).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={card("p-3.5")}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-sdc-gray-600">{label}</p>
        {deltaEl}
      </div>
      <p className={`mt-1.5 font-heading text-2xl font-bold leading-none tracking-tight tabular-nums ${tone === "green" ? "text-sdc-green-text" : "text-sdc-navy"}`}>
        {value}
      </p>
      {bulletEl}
      {hint && <p className="mt-1.5 text-label leading-tight text-sdc-gray-400">{hint}</p>}
    </div>
  );
}
