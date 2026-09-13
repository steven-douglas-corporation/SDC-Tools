"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { nextParams } from "@/lib/url-params";

// Clicking toggles asc/desc if already sorting by this key, otherwise
// switches to this key ascending. Preserves other params (e.g. `cols`).
//
// A LINK, not a button, even though it only changes the query string. These
// headers sit inside the Projects grid's <form>, which Edit Mode locks with a
// <fieldset disabled> — that cascades to every form control inside it, so as a
// button this would have stopped sorting the moment the grid went read-only,
// which is precisely when people are reading and most want to re-sort. An
// anchor isn't a form control and is untouched by it. Middle-click and
// open-in-new-tab start working too, which they should have all along for
// something that is, after all, just a different URL.
export function SortButton({
  sortKey,
  label,
  currentSort,
  currentDir,
}: {
  sortKey: string;
  label: string;
  currentSort: string;
  currentDir: "asc" | "desc";
}) {
  const searchParams = useSearchParams();
  const active = currentSort === sortKey;

  const nextDir = active && currentDir === "asc" ? "desc" : "asc";
  // Reads the in-flight params but deliberately does NOT record one: this is a
  // <Link> whose href is built at render, and the user may never click it.
  // Recording here would claim a navigation that hasn't happened. Reading is
  // still worth it — click Sort while a filter is committing and the sort
  // carries that filter forward instead of reverting it. See lib/url-params.ts.
  const qs = nextParams(searchParams.toString());
  qs.set("sort", sortKey);
  qs.set("dir", nextDir);
  // Two of these labels carry a literal newline ("Start\nDate") so they wrap in
  // a narrow column — flatten it for the accessible name.
  const flatLabel = label.replace(/\s+/g, " ");

  return (
    <Link
      href={`/quoted?${qs.toString()}`}
      scroll={false}
      aria-label={`Sort by ${flatLabel}, ${nextDir}ending`}
      className={`inline-flex items-center gap-1 whitespace-pre-line text-center leading-tight hover:text-sdc-navy ${active ? "text-sdc-navy" : ""}`}
    >
      {label}
      <svg
        viewBox="0 0 16 16"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className={`shrink-0 motion-interactive ${active ? "opacity-100" : "opacity-30"} ${
          active && currentDir === "desc" ? "rotate-180" : ""
        }`}
      >
        <path d="M4 9 L8 5 L12 9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}
