"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { FeedbackDetailDrawer, type FeedbackDetail } from "@/components/FeedbackDetailDrawer";
import type { FeedbackGridRow } from "@/components/FeedbackGridInner";

// AG Grid touches `window`, so load it client-only (no SSR) — same pattern as
// AuditLogGrid and the ECharts wrapper.
const Inner = dynamic(() => import("@/components/FeedbackGridInner"), {
  ssr: false,
  loading: () => <div className="h-[calc(var(--app-vh)_*_0.72)] w-full animate-pulse rounded-xl bg-sdc-gray-50" />,
});

export function FeedbackGrid({
  rows,
  details,
  canTriage,
}: {
  rows: FeedbackGridRow[];
  /** The full record per row, so opening one costs no round trip. */
  details: Record<number, FeedbackDetail>;
  canTriage: boolean;
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  const open = openId != null ? details[openId] : null;

  return (
    <>
      {/* Every row opens — a submitter needs to read the response as much as a
          triager needs to write it. What differs inside the drawer is whether
          the controls are there, not whether it opens. */}
      <Inner rows={rows} onOpen={(id) => setOpenId(id)} />
      {open && <FeedbackDetailDrawer item={open} canTriage={canTriage} onClose={() => setOpenId(null)} />}
    </>
  );
}
