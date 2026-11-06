"use client";

import dynamic from "next/dynamic";
import type { OpenPoRow } from "@/lib/open-pos-rules";

// AG Grid touches `window`, so load it client-only (no SSR), same as AuditLogGrid.
const Inner = dynamic(() => import("@/components/open-pos/OpenPosGridInner"), {
  ssr: false,
  loading: () => <div className="h-[calc(var(--app-vh)_*_0.6)] w-full animate-pulse rounded-xl bg-sdc-gray-50" />,
});

export function OpenPosGrid({ rows }: { rows: OpenPoRow[] }) {
  return <Inner rows={rows} />;
}
