import { PageTitle } from "@/components/ui/Typography";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { requirePagePermission } from "@/lib/require-permission";
import { loadOpenPos } from "@/lib/open-pos";
import { OpenPosClient } from "@/components/open-pos/OpenPosClient";
import { auth } from "@/lib/auth";
import { getSchedulerBaseUrlForRequest } from "@/lib/scheduler-link";
import { withSchedulerSso } from "@/lib/scheduler-sso";

// "Open POs" — every purchase order that still owes an invoice, today, across the
// Active and HeadStart jobs. For procurement / supply chain: which POs are late, what is
// still to arrive, what has arrived and is waiting on the supplier's bill, and how much
// each job has committed but not yet been invoiced for.
//
// The figures are the Parts List's, by construction (lib/open-pos-rules.ts): same lines,
// same per-line Left to Invoice. Today only; no as-of date (yet).
export async function OpenPosView() {
  await requirePagePermission("open-pos:view");
  const [result, session] = await Promise.all([loadOpenPos(), auth()]);
  // Chasing lives in the Scheduler's Vendor POs page (?view=vendor-pos), the buyers' worklist.
  // Same SSO hand-off the sidebar's Scheduler link uses.
  const schedulerVendorPosUrl = withSchedulerSso(`${await getSchedulerBaseUrlForRequest()}/?view=vendor-pos`, session?.user?.email);

  return (
    <div className={PAGE_SHELL}>
      <div className="flex flex-col gap-4">
        <PageTitle>Open POs</PageTitle>
        <p className="-mt-2 text-note text-sdc-gray-400">
          Purchase orders still owing an invoice, as of today, across every Active and HeadStart project. Money from Total
          ETO, the same figures as Job Details &gt; Procurement.
        </p>
        {result.ok ? (
          <OpenPosClient data={result.data} schedulerVendorPosUrl={schedulerVendorPosUrl} />
        ) : (
          <div className="rounded-xl border border-sdc-border bg-white p-5 text-sm text-sdc-navy">{result.error}</div>
        )}
      </div>
    </div>
  );
}

// -- Route entry point --
//
// The body lives in `OpenPosView` so both this route and the split view can render it
// (see build-readiness/page.tsx's note). No searchParams yet: the filters are client-side.
export default async function OpenPosPage() {
  return <OpenPosView />;
}
