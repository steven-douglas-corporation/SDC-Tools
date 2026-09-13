"use client";

import dynamic from "next/dynamic";
import type { EChartsOption } from "echarts";

// echarts-for-react touches `window`, so load it client-only (no SSR) to avoid
// a server-render crash. SVG renderer for crisp output, resize-aware, notMerge
// so option swaps replace cleanly. All app charts go through this wrapper.
const ReactECharts = dynamic(() => import("echarts-for-react"), {
  ssr: false,
  loading: () => <div style={{ height: "100%", minHeight: 120 }} />,
});

export function EChart({
  option,
  height = 380,
  className,
}: {
  option: EChartsOption;
  height?: number;
  className?: string;
}) {
  return (
    <ReactECharts
      option={option}
      notMerge
      lazyUpdate
      style={{ height, width: "100%" }}
      opts={{ renderer: "svg" }}
      className={className}
    />
  );
}
