"use client";

import { GridViewProvider } from "@/components/GridViewProvider";
import { etcViewWriteParams, etcViewExtraRules } from "@/lib/etc-view";

// The Monthly ETC grid's half of the instant-view mechanism (lib/grid-view.ts).
//
// ── Why this wrapper exists ─────────────────────────────────────────────────
//
// GridViewProvider needs two functions: how to write this grid's view into the query
// string, and what cosmetic rules follow from hiding a column. Those cannot be passed
// from etc/page.tsx, because it is a Server Component and a function is not
// serialisable across that boundary — "Functions cannot be passed directly to Client
// Components", which is what the first attempt hit.
//
// So each grid gets a thin client wrapper that supplies its own contract from a plain
// module (lib/etc-view.ts, shared with the server page). The server passes only data,
// which is what the boundary is for.
export function EtcGridView({
  initialHidden,
  children,
}: {
  initialHidden: string[];
  children: React.ReactNode;
}) {
  return (
    <GridViewProvider
      scope='[data-grid="etc"]'
      initialHidden={initialHidden}
      writeParams={etcViewWriteParams}
      extraRules={etcViewExtraRules}
    >
      {children}
    </GridViewProvider>
  );
}
