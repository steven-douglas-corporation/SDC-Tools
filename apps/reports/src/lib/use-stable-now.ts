"use client";

import { useState } from "react";

// One frozen "now" per component instance, computed once at mount rather
// than freshly on every render. `Date.now()` is impure, so calling it
// directly during render (or inside a `useMemo(() => Date.now(), [])`, which
// looks like it runs once but isn't a timing React actually guarantees) trips
// react-hooks/purity -- five call sites each had their own copy of exactly
// this pattern before this hook existed. useState's initializer is the one
// place a one-time impure read like this belongs; it runs exactly once, at
// mount, which is what every one of those call sites actually wanted.
export function useStableNow(): number {
  return useState(() => Date.now())[0];
}
