"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BuildReadinessDrawer } from "@/components/build-readiness/BuildReadinessDrawer";
import { previewPositionFamilyOverride, savePositionFamilyOverride, type OverrideMove } from "@/lib/position-family-override-actions";
import type { FamilyChoice } from "@/lib/position-families-parse";

// ── Set a position code's families (2026-10-28) ─────────────────────────────
//
// Data Management's editor for the PositionFamilyOverride table, which replaced
// the hand-edited overrides file. Two steps, because teams follow families and
// one code can move a whole branch: pick the families, then Review shows who
// would change team (the server runs the team rule on the edited rows), and
// only then Save. Removing an override is the same flow with no families.

export type OverrideEdit = {
  /** Empty for a new override: the code is typed in. */
  positionCode: string;
  title: string | null;
  families: string[];
  /** Open with nothing ticked, i.e. ready to remove it ("Use Paylocity's"). */
  remove?: boolean;
};

const INPUT = "h-9 w-full rounded-lg border border-sdc-border bg-white px-2.5 text-sm text-sdc-navy outline-none focus:border-sdc-blue";
const LABEL = "text-xs font-semibold uppercase tracking-wide text-sdc-muted";
const PRIMARY = "h-9 rounded-lg bg-sdc-blue px-3.5 text-sm font-semibold text-white motion-interactive hover:brightness-95 disabled:opacity-60";
const SECONDARY = "h-9 rounded-lg border border-sdc-border bg-white px-3.5 text-sm font-semibold text-sdc-navy motion-interactive hover:bg-sdc-gray-50 disabled:opacity-60";

function Moves({ moves }: { moves: OverrideMove[] }) {
  const shown = moves.filter((m) => m.shown);
  const hidden = moves.length - shown.length;
  if (!moves.length) return <p className="text-sm text-sdc-gray-600">Nobody changes team.</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold text-sdc-navy">
        {moves.length} {moves.length === 1 ? "person changes" : "people change"} team:
      </p>
      {shown.length > 0 && (
        <div className="max-h-72 overflow-auto rounded-lg border border-sdc-border">
          <table className="w-full text-left text-xs">
            <tbody className="divide-y divide-sdc-border-soft">
              {shown.map((m, i) => (
                <tr key={`${m.name}-${i}`}>
                  <td className="px-3 py-1.5 font-medium text-sdc-navy">{m.name}</td>
                  <td className="px-3 py-1.5 text-sdc-gray-600">
                    {m.from} → {m.to}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hidden > 0 && (
        <p className="text-xs text-sdc-muted">
          {hidden} of them {hidden === 1 ? "is" : "are"} hidden on the Employees page.
        </p>
      )}
    </div>
  );
}

export function PositionFamilyOverrideDrawer({
  edit,
  choices,
  onClose,
}: {
  edit: OverrideEdit;
  choices: FamilyChoice[];
  onClose: () => void;
}) {
  const router = useRouter();
  const isNew = !edit.positionCode;
  const [code, setCode] = useState(edit.positionCode);
  const [title, setTitle] = useState(edit.title ?? "");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(edit.remove ? [] : edit.families));
  const [moves, setMoves] = useState<OverrideMove[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const families = [...selected];
  const removing = families.length === 0;

  function toggle(c: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  function review() {
    setError(null);
    startTransition(async () => {
      const result = await previewPositionFamilyOverride(code, families, title || null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMoves(result.moves);
    });
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await savePositionFamilyOverride(code, families, title || null);
      if (!result.ok) {
        setError(result.error);
        setMoves(null);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  const heading = isNew ? "New override" : `Position code ${edit.positionCode}`;

  return (
    <BuildReadinessDrawer
      title={heading}
      subtitle={edit.title ?? undefined}
      breadcrumb={["Position families", heading]}
      onBreadcrumbClick={() => {}}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 p-4">
        {moves === null ? (
          <>
            {isNew && (
              <>
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>Position code</span>
                  <input value={code} onChange={(e) => setCode(e.target.value)} className={INPUT} placeholder="As Paylocity has it, e.g. ME SR" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>Title</span>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} placeholder="Optional" />
                </label>
              </>
            )}
            <fieldset className="flex flex-col gap-1">
              <legend className={`${LABEL} mb-1`}>Families</legend>
              <p className="mb-1 text-xs text-sdc-gray-600">
                These replace Paylocity&apos;s families for this code. With more than one, Service (500) decides the team,
                otherwise the lowest number. Leave all unticked to use Paylocity&apos;s again.
              </p>
              <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {choices.map((f) => (
                  <label key={f.code} className="flex items-center gap-2 text-sm text-sdc-navy">
                    <input type="checkbox" checked={selected.has(f.code)} onChange={() => toggle(f.code)} />
                    <span>
                      <span className="tabular-nums text-sdc-gray-600">{f.code}</span> {f.name}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {error && <p className="text-sm text-sdc-red-text">{error}</p>}
            <div className="flex justify-end">
              <button type="button" disabled={pending || (isNew && !code.trim())} onClick={review} className={PRIMARY}>
                {pending ? "Checking…" : "Review"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-sdc-gray-600">
              {removing
                ? `Remove the override for ${code.trim()}, so Paylocity's families apply again.`
                : `Set ${code.trim()} to ${choices
                    .filter((f) => selected.has(f.code))
                    .map((f) => `${f.code} ${f.name}`)
                    .join(", ")}.`}{" "}
              Teams are updated as soon as you save.
            </p>
            <Moves moves={moves} />
            {error && <p className="text-sm text-sdc-red-text">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" disabled={pending} onClick={() => setMoves(null)} className={SECONDARY}>
                Back
              </button>
              <button type="button" disabled={pending} onClick={save} className={PRIMARY}>
                {pending ? "Saving…" : removing ? "Remove override" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </BuildReadinessDrawer>
  );
}
