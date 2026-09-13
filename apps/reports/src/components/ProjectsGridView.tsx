"use client";

import { GridViewProvider } from "@/components/GridViewProvider";
import { projectsViewWriteParams } from "@/lib/projects-view";

// The Projects grid's half of the instant-view mechanism. Same shape and same reason as
// EtcGridView: the provider needs functions, and functions cannot cross the Server
// Component boundary, so the wrapper supplies them from a plain module.
//
// No `extraRules` — unlike Monthly ETC's Job Name column, none of the Projects info
// columns carries a divider or a label that has to move when it is hidden.
export function ProjectsGridView({
  initialHidden,
  children,
}: {
  initialHidden: string[];
  children: React.ReactNode;
}) {
  return (
    <GridViewProvider scope='[data-grid="projects"]' initialHidden={initialHidden} writeParams={projectsViewWriteParams}>
      {children}
    </GridViewProvider>
  );
}
