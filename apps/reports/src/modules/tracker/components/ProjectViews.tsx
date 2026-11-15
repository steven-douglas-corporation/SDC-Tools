import Link from "next/link";

// The two ways of looking at one project. Shown on both, so each is one click from the other.

const VIEWS = [
  { id: "board", label: "Board", path: "" },
  { id: "timeline", label: "Timeline", path: "/timeline" },
] as const;

export function ProjectViews({ projectKey, current }: { projectKey: string; current: (typeof VIEWS)[number]["id"] }) {
  return (
    <nav aria-label="Views of this project" className="mb-3 flex gap-1 border-b border-sdc-border text-sm">
      {VIEWS.map((v) =>
        v.id === current ? (
          <span
            key={v.id}
            aria-current="page"
            className="-mb-px border-b-2 border-sdc-blue px-3 py-1.5 font-semibold text-sdc-navy"
          >
            {v.label}
          </span>
        ) : (
          <Link
            key={v.id}
            href={`/tracker/${projectKey}${v.path}`}
            className="-mb-px border-b-2 border-transparent px-3 py-1.5 text-sdc-blue hover:underline"
          >
            {v.label}
          </Link>
        ),
      )}
    </nav>
  );
}
