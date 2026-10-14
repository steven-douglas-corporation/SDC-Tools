"use client";

import dynamic from "next/dynamic";
import type { AppliedTransferRow, ReviewPullRow } from "@/lib/sync-totaleto";

// AG Grid touches `window`, so load it client-only (no SSR).
const Inner = dynamic(() => import("@/components/PartsTransfersGridInner"), {
  ssr: false,
  loading: () => <div className="h-[calc(var(--app-vh)_*_0.72)] w-full animate-pulse rounded-xl bg-sdc-gray-50" />,
});

export function PartsTransfersGrid(props: { needsReview: ReviewPullRow[]; applied: AppliedTransferRow[] }) {
  return <Inner {...props} />;
}
