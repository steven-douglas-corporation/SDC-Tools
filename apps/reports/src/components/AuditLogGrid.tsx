"use client";

import dynamic from "next/dynamic";
import type { AuditRow } from "@/components/AuditLogGridInner";

// AG Grid touches `window`, so load it client-only (no SSR) — same pattern as
// the ECharts wrapper.
const Inner = dynamic(() => import("@/components/AuditLogGridInner"), {
  ssr: false,
  loading: () => <div className="h-[calc(var(--app-vh)_*_0.72)] w-full animate-pulse rounded-xl bg-sdc-gray-50" />,
});

export function AuditLogGrid({ rows }: { rows: AuditRow[] }) {
  return <Inner rows={rows} />;
}
