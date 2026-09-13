"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  LONG_TASK_MS,
  MAX_RECORDS,
  budgetFor,
  formatRecord,
  isOverBudget,
  pushRecord,
  safeControlLabel,
  type InteractionRecord,
} from "@/lib/interaction-metrics";

// ── The instrument (§38.14) ─────────────────────────────────────────────────
//
// §38 asked for the app to stop feeling unresponsive, and the only reason the actual
// cause was found — a 4,347ms hydration block on Monthly ETC, against 159ms on a
// Projects page with the same number of inputs — is that it was measured rather than
// guessed at. Six plausible suspects had been read and cleared first. (DEVLOG §22.)
//
// This keeps that measurement available without a profiler, so the next report of "it
// felt slow" starts from a number.
//
// ── On by default in development; opt-in in production ──────────────────────
//
// It counts fetches by wrapping window.fetch, and nothing that wraps a data path should
// be switched on for everyone by default. In production it stays dormant until somebody
// asks for it with ?perf=1 (remembered for the tab), so a manager reporting a slow
// afternoon can turn it on and read the log out of the console without a deploy.
//
// ── What it does NOT do ─────────────────────────────────────────────────────
//
// It sends nothing anywhere. There is no endpoint, no beacon and no analytics: the
// records live in a bounded in-memory ring (MAX_RECORDS) on window.__sdcInteractions,
// and the labels are structural only — never a cell's value (see safeControlLabel).
// §38.14's "do not expose sensitive information in client logs" is not a warning about
// this app's telemetry, it is a warning about its grids, which are full of live
// commercial figures.

const FLAG_KEY = "sdc-perf-metrics";

function enabled(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  try {
    if (new URLSearchParams(window.location.search).get("perf") === "1") {
      window.sessionStorage.setItem(FLAG_KEY, "1");
      return true;
    }
    return window.sessionStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

type MetricsWindow = Window & {
  __sdcInteractions?: InteractionRecord[];
  __sdcFetchPatched?: boolean;
  __sdcInFlight?: number;
};

export function InteractionMetrics() {
  // Read through a hook rather than location.pathname at event time: a record has to say
  // which PAGE was slow, and by the time a late long task is reported the URL may have
  // moved on. This is the route React thinks is current, which is the honest answer.
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === "undefined" || !enabled()) return;
    const w = window as MetricsWindow;
    const records: InteractionRecord[] = (w.__sdcInteractions ??= []);
    const dev = process.env.NODE_ENV !== "production";

    // ── In-flight request count (§38.14) ──────────────────────────────────────
    //
    // "A slow interaction with six requests outstanding is a different bug from a slow
    // one on its own." Patched once per page-load and never unpatched: unpatching would
    // have to restore whatever wrapper came after this one, and getting that wrong
    // breaks every fetch in the app. The wrapper adds two integer operations and passes
    // everything — arguments, resolution, rejection — through untouched.
    if (!w.__sdcFetchPatched) {
      w.__sdcFetchPatched = true;
      w.__sdcInFlight = 0;
      const original = window.fetch.bind(window);
      window.fetch = (...args: Parameters<typeof fetch>) => {
        w.__sdcInFlight = (w.__sdcInFlight ?? 0) + 1;
        // finally, not then: a rejected request must decrement too, or the count drifts
        // upward for the life of the tab and every later record reads as congested
        // (§38.12's rule, applied to the instrument itself).
        return original(...args).finally(() => {
          w.__sdcInFlight = Math.max(0, (w.__sdcInFlight ?? 1) - 1);
        });
      };
    }

    const record = (r: InteractionRecord) => {
      pushRecord(records, r);
      if (dev) console.warn(formatRecord(r));
    };

    const observers: PerformanceObserver[] = [];
    const observe = (type: string, cb: PerformanceObserverCallback, extra: Record<string, unknown> = {}) => {
      try {
        const o = new PerformanceObserver(cb);
        o.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
        observers.push(o);
      } catch {
        // An unsupported entry type must not break the app it is measuring.
      }
    };

    // Interaction to Next Paint, per event: the browser's own measure of "I clicked and
    // nothing happened", which is exactly the complaint §38 opens with.
    observe(
      "event",
      (list) => {
        for (const entry of list.getEntries()) {
          const e = entry as PerformanceEventTiming;
          const duration = Math.round(e.duration);
          const action = e.name;
          // A control that opens a disclosure gets §38.13's looser 150ms — declared by
          // the element, so the budget follows the interaction rather than a guess here.
          const target = e.target as (Element & { getAttribute(name: string): string | null }) | null;
          const isDisclosure = target?.getAttribute?.("aria-expanded") != null;
          if (!isOverBudget(action, duration, isDisclosure)) continue;
          record({
            page: pathname,
            control: safeControlLabel(target),
            action,
            durationMs: duration,
            processingMs: Math.round(e.processingEnd - e.processingStart),
            budgetMs: budgetFor(action, isDisclosure),
            overBudget: true,
            activeRequests: w.__sdcInFlight ?? 0,
          });
        }
      },
      { durationThreshold: 16 },
    );

    // Long tasks: §38.16 #15 — "no normal interaction creates a long main-thread block".
    // Recorded without a control, because a long task has no target; what it has is a
    // duration and a page, which is what made the §38 cause findable.
    observe("longtask", (list) => {
      for (const e of list.getEntries()) {
        const duration = Math.round(e.duration);
        if (duration <= LONG_TASK_MS) continue;
        record({
          page: pathname,
          control: "main-thread",
          action: "longtask",
          durationMs: duration,
          processingMs: duration,
          budgetMs: LONG_TASK_MS,
          overBudget: true,
          activeRequests: w.__sdcInFlight ?? 0,
        });
      }
    });

    // Layout shifts, so a "the page jumped under my cursor" report has a figure too.
    observe("layout-shift", (list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
        if (e.hadRecentInput || e.value < 0.1) continue;
        record({
          page: pathname,
          control: "viewport",
          action: "layout-shift",
          durationMs: Math.round(e.value * 1000) / 1000,
          processingMs: 0,
          budgetMs: 100,
          overBudget: true,
          activeRequests: w.__sdcInFlight ?? 0,
        });
      }
    });

    if (dev) {
      console.info(
        `[interaction] measuring — window.__sdcInteractions holds the last ${MAX_RECORDS} over-budget interactions`,
      );
    }

    return () => {
      for (const o of observers) o.disconnect();
    };
  }, [pathname]);

  return null;
}
