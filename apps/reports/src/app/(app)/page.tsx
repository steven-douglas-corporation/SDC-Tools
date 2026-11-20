import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { PAGE_SHELL, card } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { EmptyState } from "@/components/ui/EmptyState";
import { permittedRoutePaths } from "@/lib/pane-permissions";
import { getSchedulerBaseUrlForRequest } from "@/lib/scheduler-link";
import { withSchedulerSso } from "@/lib/scheduler-sso";
import { toolsFor, type ToolId } from "@/lib/tools";

// The tools page: the site's bare address. One tile per tool the person has.
//
// Until 2026-11-19 this address was the Dashboard, which is now at /dashboard. Three things
// keep that move from being felt:
//
//   - A Dashboard link made before the move carries `m` (the month) or `tab`. It is sent on
//     to /dashboard with the same query, so bookmarks and old feedback links still open it.
//   - Someone with a single tool has nothing to choose between, so they go straight to it.
//     For a role with Reports alone that is the Dashboard, or the first report they hold:
//     the same place this address took them before.
//   - Saved tabs and split views that name "/" are read as the Dashboard (lib/split-view.ts).
//
// Every signed-in person may open this page. What it shows is decided by the same list the
// sidebar filters on, so a tile never leads to a page the role is refused.

const ICONS: Record<ToolId | "scheduler", React.ReactNode> = {
  reports: (
    <>
      <line x1="4" y1="20" x2="4" y2="11" />
      <line x1="10" y1="20" x2="10" y2="5" />
      <line x1="16" y1="20" x2="16" y2="14" />
      <line x1="22" y1="20" x2="22" y2="8" />
    </>
  ),
  tracker: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="10" rx="1" />
      <rect x="17" y="4" width="5" height="13" rx="1" />
    </>
  ),
  scheduler: (
    <>
      <line x1="4" y1="6" x2="14" y2="6" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="5" y1="18" x2="15" y2="18" />
    </>
  ),
};

function TileIcon({ of }: { of: ToolId | "scheduler" }) {
  return (
    <svg
      viewBox="0 0 26 24"
      width="26"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className="text-sdc-blue"
      aria-hidden="true"
    >
      {ICONS[of]}
    </svg>
  );
}

const TILE = `${card("p-5")} block hover:border-sdc-blue focus-visible:border-sdc-blue`;

export default async function ToolsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (params.m !== undefined || params.tab !== undefined) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) query.append(key, v);
    }
    redirect(`/dashboard?${query.toString()}`);
  }

  const session = await auth();
  const tools = toolsFor(permittedRoutePaths(session?.user?.role ?? "ALL"));
  if (tools.length === 1) redirect(tools[0]!.href);

  const schedulerUrl = withSchedulerSso(
    `${await getSchedulerBaseUrlForRequest()}/?view=projects`,
    session?.user?.email,
  );

  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">Your tools</PageTitle>
      <p className="mb-5 text-sm text-sdc-gray-600">Pick one to open it. Its menu appears in the sidebar.</p>
      {tools.length === 0 ? (
        <EmptyState
          title="Nothing is switched on for your account yet"
          message="Ask an administrator to give your role access to the pages you need."
        />
      ) : (
        <ul className="grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tools.map((t) => (
            <li key={t.id}>
              <Link href={t.href} className={TILE}>
                <TileIcon of={t.id} />
                <span className="mt-3 block text-base font-semibold text-sdc-navy">{t.label}</span>
                <span className="mt-0.5 block text-sm text-sdc-gray-600">{t.description}</span>
              </Link>
            </li>
          ))}
          {schedulerUrl && (
            <li>
              {/* A different app on another port, so a plain link in a new tab: the same
                  choice the sidebar's own Project Scheduler link makes outside the shell. */}
              <a href={schedulerUrl} target="_blank" rel="noopener noreferrer" className={TILE}>
                <TileIcon of="scheduler" />
                <span className="mt-3 block text-base font-semibold text-sdc-navy">Project Scheduler</span>
                <span className="mt-0.5 block text-sm text-sdc-gray-600">A separate app. Opens in a new tab.</span>
              </a>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
