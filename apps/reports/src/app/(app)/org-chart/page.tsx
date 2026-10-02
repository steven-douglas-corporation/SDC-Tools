import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { OrgChart, PendingTeamChanges } from "@/components/OrgChart";
import { getOrgChart } from "@/lib/org-chart";
import { requirePagePermission } from "@/lib/require-permission";

// Who sits on which team, by reporting line (2026-10-02). Read-only: the teams
// are the proposals of lib/team-resolution.ts, and the panel up top lists what
// switching them on would change. Same audience as the Employees page.
export async function OrgChartView() {
  await requirePagePermission("employees:view");
  const chart = await getOrgChart();
  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">Org Chart</PageTitle>
      <p className="mb-5 max-w-4xl text-sm text-sdc-gray-600">
        Everyone sits on the team of their branch: the person in their reporting line who reports straight to Leadership.
        That person&apos;s Paylocity position family sets the team for the whole branch. Leadership (family 100) can sit on
        any team. Supervisors and position codes come from Paylocity every hour, families from the Position_Families file
        and its overrides. An <span className="font-semibold">i</span> beside a name explains anyone placed some other way.
      </p>
      {chart.ready && (
        <div className="mb-7">
          <PendingTeamChanges pending={chart.pending} />
        </div>
      )}
      <OrgChart chart={chart} />
    </div>
  );
}

// -- Route entry point -- the body is OrgChartView so split view can render it too
// (see the same note at the bottom of employees/page.tsx).
export default async function OrgChartPage() {
  return <OrgChartView />;
}
