"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { nextParams, notePendingParams } from "@/lib/url-params";
import { usePendingWatchdog } from "@/components/usePendingWatchdog";
import { useTransition } from "react";

// Shared behaviour for the Projects toolbar's bucketed dropdowns (Filters,
// Sections, Dates).
//
// ── Why local state at all (2026-07-30) ─────────────────────────────────────
// These menus used to navigate on EVERY checkbox, with `checked` read straight
// from a server prop. So a tick couldn't APPEAR until the server had re-rendered
// the whole 224-job x 20-column grid and shipped it back — the checkbox itself
// lagged the click by a visible beat, which is what made them feel broken.
//
// Keeping a local draft fixes that: the tick lands in state immediately and the
// checkbox is never waiting on the network.
//
// ── Why it no longer waits for the menu to close (2026-08-03, by request) ────
// The first version of this hook took the fix too far and only wrote the URL
// when the menu CLOSED. That made the checkbox instant but the RESULT deferred:
// untick a customer and the grid sat there unchanged until you closed the menu,
// with a "Applies when you close this menu" line as the only explanation. Users
// reasonably read that as the filter not working.
//
// ── Why the first tick no longer waits at all (§32.7, 2026-08-04) ───────────
//
// The version in between was a TRAILING debounce: every tick restarted a 250ms
// timer and the navigation went out once the user paused. That collapses a burst
// into one navigation, which is the point — but it also charged the 250ms to the
// case that does not need it. Ticking ONE box is by far the most common thing
// anyone does in these menus, and it sat there for a quarter of a second before
// the server was even asked. §32.7 says outright not to debounce checkboxes, and
// this is why: the delay is pure added latency on the single-selection case.
//
// Leading edge plus trailing, now. The first tick navigates on the same frame it
// lands. Further ticks inside the window do NOT each navigate — they mark the
// draft dirty and one trailing navigation goes out when the window closes, so a
// burst of five still costs two round-trips rather than five, and the grid is
// never left disagreeing with the boxes.
//
// The two together are what the spec asks for from a multi-select: results update
// incrementally, the menu stays open, and nothing waits on a timer that exists for
// somebody else's burst.
//
// Handles SEVERAL params per menu, because the buckets each cover more than one:
// Filters owns customers/types/statuses/billables, Sections owns cols/hide.
//
// The caller must NOT remount on a change of `committed` — this hook resyncs the
// draft itself (see below). Remounting was the old contract, and applying on
// every tick makes it actively wrong: a remount rebuilds the <details> element,
// which slams the menu shut on the first click, and throws away the search box's
// text along with it.

// How long after a navigation further ticks are collapsed rather than sent one by
// one. Not a delay on the first tick — see above.
const DEFAULT_DEBOUNCE_MS = 250;

/**
 * When the navigation for the current draft should go out: `0` means now, on this
 * frame; a positive number is the trailing delay in milliseconds.
 *
 * Pure and exported so the property that matters — a lone tick waits for nothing —
 * is pinned by a test rather than left to be re-derived from the effect below. The
 * whole complaint this addresses is a filter that "does not apply immediately", so
 * a regression to a trailing-only debounce should fail a test, not a code review.
 */
export function applyDelayMs(
  msSinceLastNavigation: number,
  navigationInFlight: boolean,
  windowMs: number,
): number {
  // A navigation is still rendering: sending another now would race it for no
  // gain, so let it land and carry this change on the trailing edge.
  if (navigationInFlight) return windowMs;
  // Outside the burst window with nothing in flight — this tick is on its own.
  if (msSinceLastNavigation >= windowMs) return 0;
  // Inside the window: wait out the remainder, and let a further tick restart it.
  return windowMs - msSinceLastNavigation;
}

/**
 * Should an incoming server answer REPLACE the local draft?
 *
 * No, if it is the echo of a push this menu made: the draft is already at least
 * as new as it, and may be newer — ticks made while that navigation was in
 * flight live only in the draft, and adopting the answer would delete them. That
 * is the bug this predicate exists for; see the resync's comment.
 *
 * Yes for anything else — the Back button, a loaded saved view, another
 * component's navigation — which is what the resync was written for and must
 * keep doing.
 *
 * Pure and exported so the rule is pinned by a test: the failure it prevents is
 * silent (a checkbox that un-ticks itself a moment after you tick it), which is
 * exactly the kind that comes back.
 */
export function shouldAdoptCommitted(committedKey: string, pushedKeys: readonly string[]): boolean {
  return !pushedKeys.includes(committedKey);
}

export function useDraftParamsMenu<K extends string>({
  committed,
  buildParams,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: {
  // param key -> the server's current answer for it
  committed: Record<K, string[]>;
  // Write the draft into the query string. Mutating `qs` is expected — delete a
  // param to keep default URLs clean, or set it, whichever suits the menu.
  buildParams: (draft: Record<K, string[]>, qs: URLSearchParams) => void;
  debounceMs?: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [pending, startTransition] = useTransition();
  // See the note on the returned `pending` below. `pending` itself is still used for the
  // scheduling decision (a navigation genuinely IS in flight, whatever the indicator
  // says), so only the value handed to callers is bounded.
  const { busy: menuBusy } = usePendingWatchdog(pending);
  const [draft, setDraft] = useState<Record<K, string[]>>(() => ({ ...committed }));

  // Comparison key only, never a URL. JSON-encoded rather than comma-joined so a
  // value that itself contains a comma (customer names do) can't make two
  // different selections compare equal and leave `dirty` false — a menu visit
  // that then silently discarded the user's change.
  const norm = (v: Record<K, string[]>) =>
    JSON.stringify(
      (Object.keys(v) as K[]).sort().map((k) => [k, [...v[k]].sort()]),
    );
  const committedKey = norm(committed);
  const draftKey = norm(draft);
  const dirty = committedKey !== draftKey;

  // Every draft this menu has pushed, so an arriving server answer can be told
  // apart from a change that came from somewhere else. See the resync below for
  // what depends on that distinction. Bounded — only the last few matter, and a
  // menu open for an hour must not accumulate a key per tick.
  //
  // State, not a ref, for the same reason useDraftGroupByMenu's `expectedCommitted`
  // is: this has to be READ during render (in the resync just below), and React
  // forbids reading a ref there.
  const [pushedKeys, setPushedKeys] = useState<string[]>([]);

  // Adopt a new server answer. Replaces the old "remount under a key" contract,
  // for the reasons in the header note. Set-state-during-render is the supported
  // way to derive state from props — deliberately not an effect, which would
  // render one frame stale and trips react-hooks/set-state-in-effect.
  //
  // ── Why it must NOT adopt our own answer (2026-09-02) ─────────────────────
  //
  // It used to adopt every change of `committed`, including the echo of our own
  // push, and that silently threw away selections. Measured: five checkboxes
  // ticked 40ms apart produced ONE selected value and one request. The first
  // tick navigates on the leading edge; ticks two to five land in the draft
  // while that navigation is still rendering; the answer comes back describing
  // only the first tick, this resync overwrote the draft with it, and ticks two
  // to five were gone — checkbox and all. That is the "clicking an option
  // sometimes does not select" and "checkmarks out of sync with the applied
  // filter" in the report, and it got worse the faster you clicked.
  //
  // So: a `committed` we recognise as the echo of one of our own pushes is NOT
  // adopted — the draft is already at least as new as it, and may be newer. The
  // auto-apply effect below then sends whatever is still un-pushed, so the
  // fifth tick reaches the server on the trailing edge instead of vanishing.
  //
  // Anything we did NOT push is still adopted, unchanged: the Back button, a
  // loaded saved View, the "Show all" switch, another component's navigation.
  // Those are the cases this resync exists for.
  const [seenCommitted, setSeenCommitted] = useState(committedKey);
  if (seenCommitted !== committedKey) {
    setSeenCommitted(committedKey);
    if (shouldAdoptCommitted(committedKey, pushedKeys)) setDraft({ ...committed });
  }

  // Replace one param's values in the draft.
  function setValues(key: K, values: string[]) {
    setDraft((prev) => ({ ...prev, [key]: values }));
  }

  // Add/remove a single value from one param.
  function toggleValue(key: K, value: string) {
    setDraft((prev) => {
      const cur = prev[key] ?? [];
      return { ...prev, [key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
    });
  }

  // The push itself. Reads `draft` from the closure of whichever render
  // scheduled it, which is exactly right: the debounce is restarted on every
  // change, so the call that survives is always the newest one.
  // The query string most recently pushed, so the identical one is never pushed
  // twice in a row (§32.3: one action, one request). The leading-edge scheduling
  // below can otherwise ask twice for a single tick — the trailing timer fires
  // while the leading navigation is still rendering, `dirty` is still true because
  // `committed` has not caught up yet, and nothing else would notice that the URL
  // being built is the one already in flight.
  //
  // Only CONSECUTIVE repeats are refused, so ticking a box off and back on still
  // navigates both times: by then the recorded value is the intermediate one.
  const lastPushedRef = useRef<string | null>(null);

  function apply() {
    if (!dirty) return; // opened, looked, closed — no need to reload the grid
    // nextParams, not searchParams directly: inside a transition that hook
    // still reports the PRE-navigation query string, so a second change landing
    // while the first is still rendering would rebuild the URL without the
    // first one and silently revert it. That window is the normal case now that
    // every tick navigates. See lib/url-params.ts.
    const current = searchParams.toString();
    const qs = nextParams(current);
    buildParams(draft, qs);
    const q = qs.toString();
    if (lastPushedRef.current === q) return;
    lastPushedRef.current = q;
    // Recorded BEFORE the push, so the answer can never arrive before we know we
    // asked. Keyed the same way `committed` is normalised, since that is what it
    // will be compared against. Last 8 kept: enough to survive answers arriving
    // out of order, small enough to stay a constant.
    setPushedKeys((prev) => [...prev.slice(-7), draftKey]);
    notePendingParams(current, q); // before the push, so the next tick sees it
    startTransition(() => {
      router.push(q ? `${pathname}?${q}` : pathname, { scroll: false });
    });
  }

  // Leading-edge-then-trailing auto-apply.
  //
  // Keyed on draftKey rather than the draft object so a resync that produces an
  // equal value doesn't restart the clock. `dirty` is false on mount and false
  // again once a push commits, which is what keeps this from firing on either.
  // apply() closes over this render's draft and query string, and it is a new
  // function every render, so it can't go in the dependency list without
  // re-running on every unrelated re-render. The ref is the standard way out —
  // refreshed in its own effect rather than during render, which React forbids,
  // and declared FIRST so it is always up to date by the time this effect runs.
  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  });
  // When the last navigation was ISSUED. The window is measured from here, so a
  // deliberate tick after a pause is always instant and only a genuine burst is
  // collapsed.
  const lastAppliedAtRef = useRef(0);
  useEffect(() => {
    if (!dirty) return;
    const since = Date.now() - lastAppliedAtRef.current;
    const wait = applyDelayMs(since, pending, debounceMs);
    // Leading edge: nothing went out recently and nothing is in flight, so this
    // tick is the burst's first and there is nobody to wait for. This is the
    // single-selection case, and it is now as fast as the round-trip allows.
    if (wait === 0) {
      lastAppliedAtRef.current = Date.now();
      applyRef.current();
      return;
    }
    // Inside the window, or a navigation is still rendering: one trailing
    // navigation carries whatever the draft ends up being. Restarted by each
    // further tick (the cleanup), so five ticks in a row still cost one.
    const t = window.setTimeout(() => {
      lastAppliedAtRef.current = Date.now();
      applyRef.current();
    }, wait);
    return () => window.clearTimeout(t);
    // `pending` is deliberately a dependency: when a navigation finishes with the
    // draft still dirty, that is exactly the moment to send the change that
    // arrived during it. It cannot loop — apply() refuses a URL identical to the
    // one it last pushed, and a committed push clears `dirty`.
  }, [draftKey, dirty, debounceMs, pending]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      // Setting `open` fires onToggle, which flushes any pending change — one
      // path for every way of closing rather than one per trigger.
      const el = detailsRef.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    }
    // ── Escape closes (2026-09-02) ────────────────────────────────────────
    //
    // A <details> does not close on Escape by itself — it is a disclosure, not a
    // dialog — so these menus could only be dismissed by clicking, which is the
    // one dropdown behaviour every other menu in this app already has (see
    // JobSelect, which grew its own handler for the same reason).
    //
    // It goes through the same `open = false` path as an outside click, so
    // whatever is still on the debounce is flushed by onToggle rather than
    // silently dropped: Escape closes the menu, it does not undo the ticks.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const el = detailsRef.current;
      if (!el?.open) return;
      el.open = false;
      // Focus lands back on the button that opened it, so a keyboard user is
      // not dropped at the top of the document.
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
    setValues,
    toggleValue,
    dirty,
    // Bounded, not the raw transition flag (§35.5: "do not show `Up to date` while a
    // newer request is still pending", and its converse — do not show "Applying…"
    // forever). Every menu that spreads this renders a spinner from it, so a transition
    // that never settles would leave a permanent spinner in the toolbar exactly as
    // "Show all" got stuck. The watchdog reports busy only while the wait is credible.
    //
    // Note the menus are NOT disabled by this: a checkbox stays tickable throughout, so
    // a stuck navigation can never lock the filter panel. Only the indicator is gated.
    pending: menuBusy,
    detailsRef,
    // Spread onto the OUTER <details>.
    detailsProps: {
      onToggle: (e: React.SyntheticEvent<HTMLDetailsElement>) => {
        // These menus contain nested <details> for their groups. `toggle` doesn't
        // bubble per spec, but React's synthetic system can still deliver a
        // descendant's event here — so ignore anything that isn't this element
        // opening/closing.
        if (e.target !== e.currentTarget) return;
        // Closing flushes whatever is still on the debounce. Nothing waits for
        // this any more; it only means a fast close can't outrun the timer.
        if (!e.currentTarget.open) applyRef.current();
      },
    },
  };
}
