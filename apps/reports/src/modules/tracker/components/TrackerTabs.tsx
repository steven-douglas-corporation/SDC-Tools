import Link from "next/link";

// The sub-navigation for Internal Projects: Projects, Timeline, People and time as tabs across
// the top of the three portfolio pages, rather than three separate items in the sidebar. Each
// of these is its own route, so a tab is a Link, not a client-side panel switch; the page that
// renders this passes its own `active`, so no pathname reading is needed and this stays a server
// component. The per-project pages (/tracker/<key>/…) have their own tabs and do not show these.

const TABS = [
  { id: "projects", href: "/tracker", label: "Projects" },
  { id: "timeline", href: "/tracker/timeline", label: "Timeline" },
  { id: "people", href: "/tracker/people", label: "People and time" },
] as const;

export type TrackerTab = (typeof TABS)[number]["id"];

export function TrackerTabs({ active }: { active: TrackerTab }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1 border-b border-sdc-border" role="tablist">
      {TABS.map((t) => {
        const on = t.id === active;
        return (
          <Link
            key={t.id}
            href={t.href}
            role="tab"
            aria-selected={on}
            aria-current={on ? "page" : undefined}
            className={`relative -mb-px border-b-2 px-4 py-2.5 text-sm font-semibold motion-interactive ${
              on
                ? "border-sdc-blue text-sdc-blue-dark"
                : "border-transparent text-sdc-muted hover:border-sdc-border hover:text-sdc-navy"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
