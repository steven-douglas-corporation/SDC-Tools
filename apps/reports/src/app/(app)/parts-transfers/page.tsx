import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { PartsTransfersGrid } from "@/components/PartsTransfersGrid";
import { requirePagePermission } from "@/lib/require-permission";
import { getTransferReview, type TransferReview } from "@/lib/sync-totaleto";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default async function PartsTransfersPage() {
  await requirePagePermission("projects:view");
  let review: TransferReview | null = null;
  try {
    review = await getTransferReview();
  } catch (e) {
    console.error("PartsTransfersPage: getTransferReview failed:", e);
  }

  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">Parts Transfers</PageTitle>
      <p className="mb-2 max-w-4xl text-sm text-sdc-gray-600">
        Total ETO can&apos;t move an invoice to another job, so a parts transfer is booked as two inventory pulls: one
        leaving a job and one arriving on another. The app only moves the cost when the two pulls clearly match: same
        item, same quantity, within 14 days, costs of the same order, and the arriving pull not on a PO.
      </p>
      {review == null ? (
        <p role="status" className="rounded-md border border-sdc-red-text/30 bg-sdc-red-bg px-3 py-2 text-sm text-sdc-red-text">
          Couldn&apos;t read the inventory pulls from Total ETO. Try again shortly.
        </p>
      ) : (
        <>
          <p className="mb-4 max-w-4xl text-sm text-sdc-gray-600">
            <span className="font-semibold text-sdc-navy">Needs review</span> lists pulls since {review.since} that look
            like half of a transfer but were <span className="font-semibold">not</span> applied, with the rule that
            stopped each one. If it really is a transfer, correct the booking in Total ETO and it will be picked up on
            the next load. {review.ordinaryCount.toLocaleString()} other unmatched pull
            {review.ordinaryCount === 1 ? "" : "s"} ({usd(review.ordinaryAmount)}) have no counterpart on any other job
            and are treated as ordinary stock issues and returns.
          </p>
          <PartsTransfersGrid needsReview={review.needsReview} applied={review.applied} />
        </>
      )}
    </div>
  );
}
