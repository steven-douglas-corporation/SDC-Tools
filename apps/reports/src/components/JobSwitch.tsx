"use client";

import { createContext, useCallback, useContext, useMemo, useOptimistic, useTransition } from "react";

// ── Picking a job is one thing; loading it is another ────────────────────────
//
// The Job Details picker used to write `?jobs=` and then wait for the server
// to render the whole new page before ANYTHING changed: the ✓, the chip and the
// summary label all read the selection from the URL the server had rendered, so a
// click sat dead for as long as the page took (a second or more, and minutes when
// TotalETO is degraded).
//
// This provider splits the two. `select()` runs the navigation inside a
// transition and, in the same transition, sets an OPTIMISTIC selection — so the
// picker reflects the click on the very next frame — while `pending` stays true
// until the new page has actually committed. React drops the optimistic value
// then and the server's own selection takes over, which is why a failed or
// superseded navigation cannot leave the picker claiming a job that is not on
// screen.
//
// Two consumers: JobSelect (the optimistic selection + the click handler) and
// JobSwitchBody (dims the stale figures while pending). They are far apart in the
// tree, with server-rendered content between them, hence a context rather than props.

type JobSwitch = {
  /** What the picker should show: the click's selection until the server catches up. */
  selected: string[];
  /** True from the click until the new page has committed. */
  pending: boolean;
  /** Run `commit` (the URL write) as a background transition showing `next` meanwhile. */
  select: (next: string[], commit: () => void) => void;
};

const Ctx = createContext<JobSwitch | null>(null);

export function JobSwitchProvider({ selected, children }: { selected: string[]; children: React.ReactNode }) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(selected);

  const select = useCallback(
    (next: string[], commit: () => void) => {
      startTransition(() => {
        setOptimistic(next);
        commit();
      });
    },
    [setOptimistic],
  );

  const value = useMemo(() => ({ selected: optimistic, pending, select }), [optimistic, pending, select]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Null outside a provider — JobSelect then falls back to the server's selection, as it always did. */
export function useJobSwitch(): JobSwitch | null {
  return useContext(Ctx);
}

/**
 * Wraps everything below the picker. While a new job loads, the previous job's
 * figures stay put but dim (after the shared loading delay, so a fast switch never
 * flickers), rather than sitting there looking final.
 */
export function JobSwitchBody({ children }: { children: React.ReactNode }) {
  const pending = useContext(Ctx)?.pending ?? false;
  return (
    <div aria-busy={pending} className={pending ? "motion-pending-dim" : undefined}>
      {children}
    </div>
  );
}
