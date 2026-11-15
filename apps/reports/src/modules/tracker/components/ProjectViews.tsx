import Link from "next/link";

// The ways of looking at the same thing, as tabs. Shown on each of them, so every view is one
// click from the others: the list of projects and their timeline, or one project's board and
// its timeline.

function Tabs({
  label,
  tabs,
  current,
}: {
  label: string;
  tabs: { id: string; label: string; href: string }[];
  current: string;
}) {
  return (
    <nav aria-label={label} className="mb-3 flex gap-1 border-b border-sdc-border text-sm">
      {tabs.map((t) =>
        t.id === current ? (
          <span
            key={t.id}
            aria-current="page"
            className="-mb-px border-b-2 border-sdc-blue px-3 py-1.5 font-semibold text-sdc-navy"
          >
            {t.label}
          </span>
        ) : (
          <Link
            key={t.id}
            href={t.href}
            className="-mb-px border-b-2 border-transparent px-3 py-1.5 text-sdc-blue hover:underline"
          >
            {t.label}
          </Link>
        ),
      )}
    </nav>
  );
}

/** One project: its board and its timeline. */
export function ProjectViews({ projectKey, current }: { projectKey: string; current: "board" | "timeline" }) {
  return (
    <Tabs
      label="Views of this project"
      current={current}
      tabs={[
        { id: "board", label: "Board", href: `/tracker/${projectKey}` },
        { id: "timeline", label: "Timeline", href: `/tracker/${projectKey}/timeline` },
      ]}
    />
  );
}

/** All projects: the list and the timeline. */
export function PortfolioViews({ current }: { current: "list" | "timeline" }) {
  return (
    <Tabs
      label="Views of all projects"
      current={current}
      tabs={[
        { id: "list", label: "Projects", href: "/tracker" },
        { id: "timeline", label: "Timeline", href: "/tracker/timeline" },
      ]}
    />
  );
}
