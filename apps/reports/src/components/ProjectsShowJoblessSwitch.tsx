"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { BTN_H_STANDARD } from "@/components/ui/classnames";
import { JOBLESS_PARAM, isJoblessShown } from "@/lib/quoted-display-prefs";

// "No Job ID" — shows or hides the Projects grid's No Job ID footer row.
//
// Works exactly like ProjectsShowActualsSwitch, which has the reasoning: both
// versions are already in the server's markup, so the switch toggles one class
// (`hide-jobless`) on the table and replaceStates the URL, with no server render.
// The Total is rendered twice, with and without the No Job ID hours, and the same
// class decides which one shows (globals.css), so hiding the row takes its hours
// out of the Total too, and the Total then reads as partial.
export function ProjectsShowJoblessSwitch() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [on, setOn] = useState(() => isJoblessShown(searchParams));

  // Adopt a change from elsewhere (a saved view, Back, a hand-edited URL).
  const fromUrl = isJoblessShown(searchParams);
  const [seenUrl, setSeenUrl] = useState(fromUrl);
  if (seenUrl !== fromUrl) {
    setSeenUrl(fromUrl);
    setOn(fromUrl);
  }

  useEffect(() => {
    const table = document.querySelector<HTMLElement>('table[data-grid="projects"]');
    if (!table) return;
    table.classList.toggle("hide-jobless", !on);
  }, [on]);

  const flip = useCallback(() => {
    const next = !on;
    setOn(next);
    // Shown is the default, so only the OFF state is written.
    const qs = new URLSearchParams(searchParams.toString());
    if (next) qs.delete(JOBLESS_PARAM);
    else qs.set(JOBLESS_PARAM, "0");
    const q = qs.toString();
    window.history.replaceState(null, "", q ? `${pathname}?${q}` : pathname);
  }, [on, pathname, searchParams]);

  return (
    <button
      type="button"
      onClick={flip}
      aria-pressed={on}
      title={
        on
          ? "Showing the No Job ID row (punches with no usable job number) and counting it in the Total — click to hide it"
          : "Show the No Job ID row (punches with no usable job number) and count it in the Total"
      }
      className={`flex ${BTN_H_STANDARD} shrink-0 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium motion-interactive ${
        on ? "border-sdc-blue bg-sdc-blue-light text-sdc-blue-dark" : "border-sdc-border bg-white text-sdc-navy hover:bg-sdc-blue-light"
      }`}
    >
      <span
        aria-hidden
        className={`relative h-3.5 w-6 shrink-0 rounded-full motion-interactive ${on ? "bg-sdc-blue" : "bg-sdc-gray-100"}`}
      >
        <span
          className={`motion-interactive absolute top-0.5 left-0.5 h-2.5 w-2.5 rounded-full bg-white shadow ${
            on ? "translate-x-[10px]" : "translate-x-0"
          }`}
        />
      </span>
      <span>No Job ID</span>
    </button>
  );
}
