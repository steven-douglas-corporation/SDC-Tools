import { card } from "@/components/ui/classnames";

// Placeholders for the two Job Details sections that stream in behind the hours
// charts (Parts Cost, Procurement) — both read live from TotalETO, so they are the
// slow part of the page and no longer hold the rest of it back.
//
// No client hooks, so the server page and the client dashboard can both use them as
// Suspense fallbacks. Opacity-only pulse via the shared `motion-skeleton`, and the
// shapes follow the real cards so the swap moves nothing (the same reasoning as
// app/(app)/loading.tsx). No reveal delay here: these appear in a page that is
// already on screen, where a bare gap would read as missing data rather than loading.

function Block({ className }: { className: string }) {
  return <div className={`motion-skeleton rounded bg-sdc-border-soft ${className}`} />;
}

/** The Parts Cost card's slot: a title line and a couple of bars, filling the row height. */
export function PartsCostSkeleton() {
  return (
    <div className={`${card("p-4")} flex h-full min-h-72 flex-col`} aria-busy="true" role="presentation">
      <span className="sr-only" aria-live="polite">
        Loading Parts Cost…
      </span>
      <Block className="mb-4 h-3 w-20" />
      <div className="mt-auto flex items-end justify-center gap-4">
        <Block className="h-40 w-5" />
        <Block className="h-28 w-5" />
      </div>
      <Block className="mt-4 h-2.5 w-full" />
    </div>
  );
}

/** Procurement's body (its heading renders at once): a tab strip and a few rows. */
export function ProcurementSkeleton() {
  return (
    <div className={card("p-4")} aria-busy="true" role="presentation">
      <span className="sr-only" aria-live="polite">
        Loading Procurement…
      </span>
      <div className="mb-4 flex gap-2">
        <Block className="h-8 w-28" />
        <Block className="h-8 w-24" />
      </div>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-sdc-border-soft py-2.5 last:border-b-0">
          <Block className="h-2.5 w-8" />
          <Block className="h-2.5 w-48" />
          <Block className="h-2.5 w-16" />
          <Block className="ml-auto h-2.5 w-20" />
        </div>
      ))}
    </div>
  );
}
