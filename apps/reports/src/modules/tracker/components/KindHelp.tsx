import type { WorkKind } from "../service/queries";

// The "?" beside a Kind field. It opens a small picture of the kinds as a ladder, top to bottom,
// with one line on what each is for and the one rule that matters: a card sits only under a
// card on a higher rung.
//
// It is a <details> element, so it opens and closes with no script and works from the keyboard.
// The rungs come from the kinds the database holds, so the picture cannot drift from the rule.

const WHAT_FOR: Record<string, string> = {
  epic: "A large goal that takes many weeks and is delivered in pieces.",
  feature: "One thing the result can do, or one piece of an Epic.",
  story: "A slice of a Feature that is useful by itself.",
  task: "A piece of work one person does. The default.",
  bug: "Something that is built and does not work as it should.",
  issue: "A problem or open question that needs someone to act.",
  milestone: "A date that matters, with no work of its own.",
};

export function KindHelp({ kinds }: { kinds: WorkKind[] }) {
  const levels = [...new Set(kinds.map((k) => k.level))].sort((a, b) => a - b);
  return (
    <details className="relative inline-block normal-case tracking-normal">
      <summary
        aria-label="What the kinds mean"
        title="What the kinds mean"
        className="flex h-4 w-4 cursor-pointer list-none items-center justify-center rounded-full border border-sdc-gray-400 text-micro font-bold text-sdc-gray-600 hover:border-sdc-blue hover:text-sdc-blue [&::-webkit-details-marker]:hidden"
      >
        ?
      </summary>
      <div className="absolute left-0 top-6 z-20 w-80 rounded-lg border border-sdc-border bg-white p-3 text-xs font-normal text-sdc-navy shadow-lg">
        <p className="mb-2 font-semibold">A card sits only under a card on a higher rung.</p>
        <ol className="space-y-1.5">
          {levels.map((level, i) => (
            // Each rung is indented a little more than the one above, like the cards under each other.
            <li key={level} style={{ marginLeft: i * 14 }} className="border-l-2 border-sdc-blue pl-2">
              {kinds
                .filter((k) => k.level === level)
                .map((k) => (
                  <p key={k.key} className="leading-snug">
                    <strong>{k.label}</strong>
                    <span className="text-sdc-gray-600"> {WHAT_FOR[k.key] ?? ""}</span>
                  </p>
                ))}
            </li>
          ))}
        </ol>
        <p className="mt-2 text-sdc-gray-600">
          Rungs can be skipped: a Story can sit straight under an Epic. Nothing sits under the bottom rung. A card with
          cards under it shows what they add up to and finishes when they do.
        </p>
      </div>
    </details>
  );
}
