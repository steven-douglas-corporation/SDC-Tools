import Link from "next/link";

// The two ways of looking at one project, as tabs: its board and its timeline. Shown on both,
// so each is one click from the other.
//
// The list of all projects and the timeline of all projects had tabs of this kind too. They
// are items in the tracker's sidebar menu now, so the tabs went.

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
