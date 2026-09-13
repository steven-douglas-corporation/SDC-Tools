"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { nextParams, notePendingParams } from "@/lib/url-params";
import { usePendingWatchdog } from "@/components/usePendingWatchdog";
import { applyDelayMs } from "@/components/useDraftParamMenu";
import type { HoursGroupBy } from "@/lib/hours-filters";

// A parallel to useDraftParamMenu.ts's useDraftParamsMenu, for the ONE control on this
// page where order is the point rather than incidental.
//
// useDraftParamsMenu can't be reused as-is: its dirty check normalizes each param by
// SORTING its values before comparing —
//
//     JSON.stringify(Object.keys(v).sort().map((k) => [k, [...v[k]].sort()]))
//
// — which is correct for Filters/Dates, where a bucket is an unordered SET (which
// departments are picked, never in what order). Group By is the opposite: [job,
// employee] and [employee, job] are different requests. Sorting first would make a
// pure reorder compare equal to `committed`, `dirty` would stay false, and apply()'s
// `if (!dirty) return` would silently swallow the reorder — it would never navigate.
//
// Reuses the same low-level primitives (applyDelayMs's leading-edge-then-trailing
// debounce math, nextParams/notePendingParams for the in-flight-navigation overlay,
// usePendingWatchdog for a bounded pending flag) rather than forking the whole hook,
// but keeps its OWN plain, order-preserving dirty check over a single HoursGroupBy[].

const DEFAULT_DEBOUNCE_MS = 250;

export function useDraftGroupByMenu({
  committed,
  buildParams,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: {
  // The server's current answer: the ordered list of chosen dimensions.
  committed: HoursGroupBy[];
  // Write the draft into the query string, same contract as useDraftParamsMenu's.
  buildParams: (draft: HoursGroupBy[], qs: URLSearchParams) => void;
  debounceMs?: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [pending, startTransition] = useTransition();
  const { busy: menuBusy } = usePendingWatchdog(pending);
  const [draft, setDraft] = useState<HoursGroupBy[]>(() => [...committed]);

  const norm = (v: HoursGroupBy[]) => JSON.stringify(v);
  const committedKey = norm(committed);
  const draftKey = norm(draft);
  const dirty = committedKey !== draftKey;

  // Adopt a new server answer (a saved view loading a different groupBy, the Back
  // button, …) — same set-state-during-render resync useDraftParamsMenu uses, for the
  // same reason: an effect would render one stale frame first.
  //
  // NOT a plain "did committed change" check (useDraftParamsMenu's own resync is, and
  // a first attempt here copied it gated on `!dirty`) — found BOTH failure modes live,
  // not theorized, while verifying this feature:
  //
  // 1. Gate on nothing: check Job, then Employee, then Section a few hundred ms apart
  //    (slower than the dev server's own navigation, not an instant triple-click).
  //    Job's OWN push was still committing when Employee was checked; when it finally
  //    landed, `committed` moved to `["job"]` while `draft` had already moved on to
  //    `["job","employee"]` — and the resync stomped straight back to `["job"]`,
  //    silently dropping the Employee click.
  // 2. Gate on `!dirty` (the first fix): correctly protects case 1, but ALSO blocks a
  //    genuinely external change — loading a saved view lands a brand new `committed`
  //    while this hook's own leftover `draft` (stale from whatever the page showed
  //    before) is "dirty" relative to it for a completely unrelated reason. `!dirty`
  //    can't tell "the user has a newer unsent edit" from "the local draft is just
  //    stale and irrelevant" — both look identical from the outside.
  //
  // The actual distinguishing signal is neither: it's whether the INCOMING committed
  // value is the one THIS hook itself is waiting to see land. `expectedCommitted` is
  // set, proactively, the moment apply() pushes — to whatever draft it just pushed —
  // and is compared here, not to `dirty`. A match means "our own earlier push finally
  // arrived," which is safe to ignore (draft already reflects it, or has moved further
  // ahead from a newer click since — either way, leave it). A mismatch means the
  // change came from somewhere this hook never pushed from at all (a view, the Back
  // button), which must be adopted outright regardless of whatever `draft` was.
  //
  // State, not a ref: it has to be READ during render (here, in this resync check),
  // and refs may not be read OR written during render — only in effects/handlers.
  const [expectedCommitted, setExpectedCommitted] = useState(committedKey);
  const [lastSeenCommittedKey, setLastSeenCommittedKey] = useState(committedKey);
  if (lastSeenCommittedKey !== committedKey) {
    setLastSeenCommittedKey(committedKey);
    if (committedKey !== expectedCommitted) {
      setDraft([...committed]);
      setExpectedCommitted(committedKey);
    }
  }

  /** Checking an unselected dimension appends it; unchecking removes it, preserving
   *  the relative order of whatever's left. */
  function toggle(dim: HoursGroupBy) {
    setDraft((prev) => (prev.includes(dim) ? prev.filter((d) => d !== dim) : [...prev, dim]));
  }

  function moveUp(index: number) {
    setDraft((prev) => {
      if (index <= 0 || index >= prev.length) return prev;
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }

  function moveDown(index: number) {
    setDraft((prev) => {
      if (index < 0 || index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }

  function clear() {
    setDraft([]);
  }

  const lastPushedRef = useRef<string | null>(null);

  function apply() {
    if (!dirty) return;
    const current = searchParams.toString();
    const qs = nextParams(current);
    buildParams(draft, qs);
    const q = qs.toString();
    if (lastPushedRef.current === q) return;
    lastPushedRef.current = q;
    notePendingParams(current, q);
    startTransition(() => {
      // Record what `committed` should become once THIS push lands, before it can
      // possibly land — see the resync block above for why this (not `dirty`) is the
      // signal that distinguishes our own push landing from a genuinely external
      // change. Inside startTransition alongside the navigation itself, not just
      // before it: a plain setState call directly in this function's synchronous body
      // would run inside the scheduling effect below on its `wait === 0` (no-debounce)
      // path, which is exactly the "setState synchronously within an effect" shape
      // that risks a cascading render — wrapping it as part of the same transition as
      // the navigation avoids that, the same fix HoursGroupedTree's own effect-driven
      // fetch needed for the identical reason.
      setExpectedCommitted(draftKey);
      router.push(q ? `${pathname}?${q}` : pathname, { scroll: false });
    });
  }

  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  });

  const lastAppliedAtRef = useRef(0);
  useEffect(() => {
    if (!dirty) return;
    const since = Date.now() - lastAppliedAtRef.current;
    const wait = applyDelayMs(since, pending, debounceMs);
    if (wait === 0) {
      lastAppliedAtRef.current = Date.now();
      applyRef.current();
      return;
    }
    const t = window.setTimeout(() => {
      lastAppliedAtRef.current = Date.now();
      applyRef.current();
    }, wait);
    return () => window.clearTimeout(t);
  }, [draftKey, dirty, debounceMs, pending]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      const el = detailsRef.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    }
    // Escape closes, the same way it does for the Filters/Dates menus — see the
    // longer note in useDraftParamMenu. Both hooks need it because this menu's
    // draft is an ORDERED list rather than a set of values, so it could not
    // share that hook's state, only its behaviour.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const el = detailsRef.current;
      if (!el?.open) return;
      el.open = false;
      el.querySelector("summary")?.focus();
    }
    document.addEventListener("click", onClickOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClickOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return {
    draft,
    toggle,
    moveUp,
    moveDown,
    clear,
    dirty,
    pending: menuBusy,
    detailsRef,
    detailsProps: {
      onToggle: (e: React.SyntheticEvent<HTMLDetailsElement>) => {
        if (e.target !== e.currentTarget) return;
        if (!e.currentTarget.open) applyRef.current();
      },
    },
  };
}
