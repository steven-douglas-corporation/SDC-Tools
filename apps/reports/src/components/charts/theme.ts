import type { EChartsOption } from "echarts";

// SDC chart design tokens. Categorical pair validated (dataviz skill):
// blue #118dff ↔ amber #f59e0b — CVD ΔE 31.6 (strong). Both series always carry
// direct value labels, which satisfies amber's low surface-contrast (secondary
// encoding). Text always uses ink tokens, never the series color.
export const SERIES = {
  planned: "#408bf7", // Quoted / ETC (planned basis)
  actual: "#162398", // Actual
} as const;

const INK = "#12239e"; // sdc-navy — headings/values
const MUTED = "#64748b"; // axis / secondary
const GRID = "#eef1f5"; // recessive gridlines
// ── The chart font is the app font, not a copy of it (§39.1, §39.16) ────────
//
// This was a hand-written duplicate of the stack in globals.css:
//
//     "Montserrat, -apple-system, 'Segoe UI', system-ui, sans-serif"
//
// which is wrong in two ways. It is a second definition of something §39.17 says must
// be declared once — change the theme and the charts silently do not follow — and the
// literal name "Montserrat" is not the font the rest of the app uses. next/font
// self-hosts the file under a generated family name (`__Montserrat_e9a909…`), so
// asking for "Montserrat" gets whatever Montserrat the machine happens to have
// installed, or the fallback. Chart labels could therefore render in a different face
// from every other label on the same screen.
//
// Read from the document instead, so it is the resolved stack the body is actually
// using, generated family name included. ECharts needs a real string — it writes
// `ctx.font` for canvas text, where `var(--font-sans)` means nothing — which is why
// this is resolved rather than referenced.
//
// Memoised on first use, not at module load: this module is imported by server
// components too, and the value only has to be right by the time a chart renders.
let resolvedFont: string | null = null;

function chartFont(): string {
  if (resolvedFont) return resolvedFont;
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") {
    // Server render: ECharts only draws in the browser, so this is never the string a
    // label is painted with. Left as a plain system stack rather than a guess at the
    // generated name.
    return "system-ui, sans-serif";
  }
  const family = getComputedStyle(document.body).fontFamily;
  if (family) resolvedFont = family;
  return family || "system-ui, sans-serif";
}

// Imported (not just re-exported) so the option builders below can call it.
import { usd } from "@/components/ui/format";
export { usd };
export function compact(n: number): string {
  return Math.round(n).toLocaleString();
}

// A polished grouped-bar chart: two series (planned vs actual) over a set of
// categories, with a recessive axis/grid, rounded thin bars, a rich shared
// tooltip, and selective direct labels. `rows` supply the category + values;
// `sub` is optional secondary text (e.g. "Phase · Dept") shown in the tooltip.
const DIFF_GREEN = "#15803d"; // under (Quoted − Actual > 0)
const DIFF_RED = "#dc2626"; // over
const DIFF_GRAY = "#94a3b8"; // even

export function groupedBarOption(opts: {
  categories: string[];
  planned: number[];
  actual: number[];
  plannedLabel: string;
  sub?: string[];
  valueFormatter?: (n: number) => string;
  rotate?: number;
  // Per-category Quoted − Actual variance. When present, shown on top of each
  // group: green if positive (under Quoted), red if negative (over).
  diffs?: number[];
}): EChartsOption {
  const fmt = opts.valueFormatter ?? compact;
  const barLabel = { show: true, position: "top" as const, color: MUTED, fontSize: 10, formatter: (p: unknown) => { const v = Number((p as { value?: number }).value) || 0; return v ? fmt(v) : ""; } };
  const series: NonNullable<EChartsOption["series"]> = [
    { name: opts.plannedLabel, type: "bar", data: opts.planned, barMaxWidth: 26, itemStyle: { borderRadius: [4, 4, 0, 0] }, label: barLabel },
    { name: "Actual", type: "bar", data: opts.actual, barMaxWidth: 26, itemStyle: { borderRadius: [4, 4, 0, 0] }, label: barLabel },
  ];

  // Quoted − Actual variance on top of each group: a zero-size scatter point at
  // the taller bar's height, carrying a green (under) / red (over) label.
  if (opts.diffs) {
    const diffs = opts.diffs;
    series.push({
      type: "scatter",
      symbolSize: 0,
      silent: true,
      z: 5,
      tooltip: { show: false },
      data: opts.categories.map((c, i) => ({
        value: [c, Math.max(opts.planned[i] ?? 0, opts.actual[i] ?? 0)] as [string, number],
        label: { color: diffs[i] > 0 ? DIFF_GREEN : diffs[i] < 0 ? DIFF_RED : DIFF_GRAY },
      })),
      label: {
        show: true,
        position: "top",
        distance: 16,
        fontWeight: "bold",
        fontSize: 12,
        formatter: (p: unknown) => { const d = diffs[(p as { dataIndex: number }).dataIndex] || 0; return d ? `${d > 0 ? "+" : ""}${fmt(d)}` : ""; },
      },
    });
  }

  return {
    color: [SERIES.planned, SERIES.actual],
    textStyle: { fontFamily: chartFont() },
    // ── Headroom for the label stack above the tallest bar ────────────────────
    //
    // Reported: the variance labels collided with the Quoted/Actual legend. It is
    // arithmetic rather than bad luck, and worth writing down because the numbers
    // are what decide `top`.
    //
    // TWO labels stack above each bar group, both anchored to the taller bar's top:
    //   • the bar's own value label — position "top", default distance ~5, 10px font
    //   • the variance label       — position "top", distance 16, 12px font
    // so the stack reaches roughly 16 + 14 = 30px ABOVE the bar.
    //
    // The y-axis rounds its max up to a tick, so the tallest bar can sit within a
    // few px of the plot ceiling (measured: 3,427 against a 3,500 max = 98% of the
    // plot height, ~6px of clearance). At the old `grid.top: 40` the stack therefore
    // reached y≈16 — inside the legend, which at `top: 6` occupies y 6…24.
    //
    // So the legend goes to the very top and the plot starts below the stack's reach.
    //
    // `top` is budgeted for the WORST CASE, which is a legend on TWO rows — and that
    // case is real, not hypothetical: this chart is the middle 1fr of a three-card row
    // whose first card takes 2fr (§55), so at a 1024px viewport the SVG is only ~120px
    // wide and ECharts wraps the two items onto separate lines (measured: `Quoted` at
    // y 3.7…18.3, `Actual` at y 33.7…48.3). Budgeting for one row put the plot at y=64
    // and `+2,587` at y 40.7…55.4 — straight through that second row. Two items is the
    // ceiling, so two rows is the worst case and this is bounded:
    //
    //     two-row legend bottom (~48) + label stack (~30) + small slack  ->  82
    //
    // At wide widths the legend is one row, so the extra ~34px simply reads as the top
    // padding this fix is asked for; the plot still gets 290 of the 400px. Both numbers
    // are px in the SVG, and CSS `zoom` scales the whole rendered chart uniformly, so a
    // fix that clears at 100% clears at every zoom level (§45) — verified across all
    // seven steps rather than assumed.
    grid: { top: 82, left: 8, right: 12, bottom: opts.rotate ? 64 : 28, containLabel: true },
    legend: {
      top: 0,
      itemWidth: 12,
      itemHeight: 12,
      itemGap: 18,
      icon: "roundRect",
      textStyle: { color: MUTED, fontSize: 12 },
      data: [opts.plannedLabel, "Actual"],
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(17,141,255,0.06)" } },
      backgroundColor: "#ffffff",
      borderColor: GRID,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: "#0f172a", fontSize: 12 },
      extraCssText: "box-shadow:0 8px 24px rgba(6,29,57,0.12); border-radius:10px;",
      formatter: (params: unknown) => {
        const arr = (params as { dataIndex: number; seriesName: string; value: number; marker: string }[]).filter((p) => p.seriesName === opts.plannedLabel || p.seriesName === "Actual");
        const i = arr[0]?.dataIndex ?? 0;
        const head = `<div style="font-weight:600;color:${INK};margin-bottom:2px">${opts.categories[i]}</div>`;
        const subLine = opts.sub?.[i] ? `<div style="color:${MUTED};font-size:11px;margin-bottom:6px">${opts.sub[i]}</div>` : "";
        const lines = arr
          .map((p) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${p.marker}${p.seriesName}</span><b style="color:${INK}">${fmt(Number(p.value) || 0)}</b></div>`)
          .join("");
        return head + subLine + lines;
      },
    },
    xAxis: {
      type: "category",
      data: opts.categories,
      axisLine: { lineStyle: { color: GRID } },
      axisTick: { show: false },
      axisLabel: { color: MUTED, fontSize: 11, rotate: opts.rotate ?? 0, interval: 0, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: GRID } },
      axisLabel: { color: MUTED, fontSize: 11, formatter: (v: number) => fmt(v) },
    },
    series,
  };
}
