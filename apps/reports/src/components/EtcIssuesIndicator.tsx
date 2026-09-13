"use client";

import { useEffect, useRef, useState } from "react";
import { requestKpiDrill } from "@/lib/etc-drill-request";
// The rules live in lib/etc-issues.ts, NOT here. The ETC page is a Server Component and
// builds the list during the SERVER render, which cannot call a function exported from a
// "use client" module — it arrives as a client reference. See the note in that file.
import type { EtcIssue } from "@/lib/etc-issues";

// Re-exported as a TYPE only, which is erased at compile time and so does not drag the
// client boundary along with it.
export type { EtcIssue };

// ── One compact indicator, instead of four full-width banners (§44) ─────────
//
// The Monthly ETC page carried up to four stacked banners and a paragraph above the
// table — on a bad day roughly a third of a laptop screen before a single number was
// visible. Two of them (undefined hours, off-grid hours) restated KPI blocks that were
// already on the page WITH drill-throughs; the page comments admitted as much
// ("Same rows the amber banner below is built from, so the card and the banner state
// one number rather than two that could drift").
//
// So the banners are gone and this is what replaces them: a small button carrying a
// count, which opens the list. Nothing is lost — every issue still appears, and the two
// that have a drill-through now OPEN it rather than describing it in prose.
//
// ── What still deserves to be loud ──────────────────────────────────────────
//
// A sync FAILURE is not the same kind of thing as a data-quality finding. Undefined
// hours mean somebody typed a bad job number and the page is otherwise trustworthy; a
// failed hours sync means every figure below may be stale, which is a reason not to
// submit the month. That difference is carried by the button's colour and wording, not
// by giving one of them a banner back — a red "2 data issues" is still one line.

export function EtcIssuesIndicator({ issues }: { issues: EtcIssue[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Nothing wrong: render NOTHING. An "0 issues" chip is permanent furniture that says
  // the same thing every day, which is how people stop reading a control.
  if (issues.length === 0) return null;

  const critical = issues.some((i) => i.severity === "critical");

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={issues.map((i) => i.title).join(" · ")}
        className={`inline-flex h-[1.9rem] items-center gap-1.5 rounded-md border px-2 text-label font-semibold motion-interactive ${
          critical
            ? "border-sdc-red bg-sdc-red-bg text-sdc-red-text hover:bg-sdc-red-bg/70"
            : "border-sdc-yellow bg-sdc-yellow-bg text-sdc-yellow-text hover:bg-sdc-yellow-bg/70"
        }`}
      >
        {/* Not colour alone: the glyph and the word "issue" both carry it. */}
        <span aria-hidden>{critical ? "!" : "•"}</span>
        {issues.length} data {issues.length === 1 ? "issue" : "issues"}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Data issues"
          className="motion-menu-panel absolute left-0 top-full z-30 mt-1 w-96 rounded-lg border border-sdc-border bg-white p-2 shadow-lg"
        >
          <ul className="grid gap-1">
            {issues.map((issue, i) => {
              const clickable = issue.drill != null;
              const Row = clickable ? "button" : "div";
              return (
                <li key={i}>
                  <Row
                    {...(clickable
                      ? {
                          type: "button" as const,
                          onClick: () => {
                            requestKpiDrill(issue.drill!);
                            setOpen(false);
                          },
                        }
                      : {})}
                    className={`w-full rounded-md border px-2.5 py-2 text-left ${
                      issue.severity === "critical" ? "border-sdc-red-border bg-sdc-red-bg/50" : "border-sdc-border bg-sdc-gray-50"
                    } ${clickable ? "motion-interactive hover:border-sdc-blue hover:bg-sdc-blue-light" : ""}`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-semibold text-sdc-navy">{issue.title}</span>
                      {clickable && <span className="shrink-0 text-label font-medium text-sdc-blue-dark">Detail →</span>}
                    </span>
                    <span className="mt-0.5 block text-note leading-relaxed text-sdc-gray-600">{issue.detail}</span>
                    {issue.fix && <span className="mt-0.5 block text-note leading-relaxed text-sdc-muted">{issue.fix}</span>}
                  </Row>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
