import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { EmptyState } from "@/components/ui/EmptyState";
import { requirePagePermission } from "@/lib/require-permission";
import { trackerConfigured, trackerDb } from "@/modules/tracker/db";
import { getSchemaStatus, schemaBehindDetail } from "@/modules/tracker/service/schema-status";

// Wraps every tracker page. Its one job: when the app has been deployed ahead of its database,
// say so here instead of letting each page fail on whichever column it happens to need. The
// pages are not rendered in that case, so nothing is saved against a half-updated database.
export default async function TrackerLayout({ children }: { children: React.ReactNode }) {
  // Not set up at all is a different message, and the pages give it themselves.
  if (!trackerConfigured()) return children;
  await requirePagePermission("tracker:view");

  const status = await getSchemaStatus(trackerDb);
  if (status.current) return children;

  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-4">Internal Projects</PageTitle>
      <EmptyState
        tone="warning"
        title="The Internal Projects is waiting on a database update"
        message={`The app was updated and its database was not, so the tracker is switched off until it is. Nothing is lost, and nothing is wrong with your account. ${schemaBehindDetail(status)}`}
      />
    </div>
  );
}
