import type { WorkKind } from "../service/queries";
import { HelpTip } from "./HelpTip";

// The "?" beside a Kind field: the kinds as a list from the top down, with one line on what
// each is for and what can go under what. The list comes from the kinds the database holds, so
// the picture cannot drift from the rule.

const WHAT_FOR: Record<string, string> = {
  epic: "A large goal that takes many weeks and is delivered in pieces.",
  feature: "One thing the result can do, or one piece of an Epic.",
  story: "A slice of a Feature that is useful by itself.",
  task: "A piece of work one person does. The default.",
  bug: "Something that was built and does not work as it should. Fixed by changing the thing itself.",
  issue: "A problem that is not a defect: a late supplier, a decision that is needed, missing access.",
  milestone: "A date that matters, with no work of its own.",
};

export function KindHelp({ kinds }: { kinds: WorkKind[] }) {
  const levels = [...new Set(kinds.map((k) => k.level))].sort((a, b) => a - b);
  const top = kinds.find((k) => k.level === levels[0])?.label ?? "The top kind";
  return (
    <HelpTip label="What the kinds mean">
      <span className="mb-2 block font-semibold">What can go under what</span>
      <span className="block space-y-1.5">
        {levels.map((level, i) => (
          // Each level is indented a little more than the one above, like the cards themselves.
          <span key={level} style={{ marginLeft: i * 14 }} className="block border-l-2 border-sdc-blue pl-2">
            {kinds
              .filter((k) => k.level === level)
              .map((k) => (
                <span key={k.key} className="block">
                  <strong>{k.label}</strong>
                  <span className="text-sdc-gray-600"> {WHAT_FOR[k.key] ?? ""}</span>
                </span>
              ))}
          </span>
        ))}
      </span>
      <span className="mt-2 block text-sdc-gray-600">
        A card can go under any card higher in this list, and levels can be skipped: a Story can go straight under an
        Epic. {top} is the top, so it goes under nothing. Nothing goes under the bottom level. A card with cards under
        it shows what they add up to and finishes when they do.
      </span>
    </HelpTip>
  );
}
