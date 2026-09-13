"use client";

import { useEffect } from "react";

// Scrolls one element into view on mount — the client half of a server-rendered
// deep link (e.g. `?section=procurement` on /job-hours) that needs to land the
// viewer on a specific part of an otherwise-plain page, not just load the data.
// Renders nothing; the server decides WHETHER this should run by only
// rendering the component at all when its condition is met, so there is no
// prop for that here.
export function ScrollIntoView({ id }: { id: string }) {
  useEffect(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [id]);
  return null;
}
