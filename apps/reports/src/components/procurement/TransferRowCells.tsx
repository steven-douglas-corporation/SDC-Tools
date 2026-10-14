import { usd } from "@/components/ui/format";
import type { TransferRow } from "@/lib/parts-list-transfer-rows";
import type { ColKey } from "@/components/procurement/PoDetailPanel";
import { NO_DESTINATION } from "@/lib/parts-transfer-netting";

// One "parts moved between jobs" row of the Parts List, laid across the table's OWN visible
// columns so each figure sits under the header that names it — the same arrangement as
// PartRowCells and PartPoSubRowCells. Only the columns a transfer has a value for are filled
// (Part No, Desc, Invoiced date, Total $, Invoiced $, Left to Invoice, Status); everything
// else stays blank rather than printing a dash that reads as "missing data". The same values
// feed the export (transferExportValue), so the screen and the file cannot disagree.
//
// It is NOT a part row: no status tint from a BOM state, no expand control, no PO history.
// See lib/parts-list-transfer-rows.ts for why it is a pinned row and not a rewritten one.

const money = "whitespace-nowrap font-mono text-note font-semibold tabular-nums";

export function TransferRowCells({
  row,
  cols,
}: {
  row: TransferRow;
  cols: { key: ColKey; label: string; align?: "right"; title?: string }[];
}) {
  const cell = (key: ColKey) => {
    switch (key) {
      case "pn":
        return (
          <span className="block truncate font-mono text-note font-bold text-sdc-blue-dark" title={row.otherJob === NO_DESTINATION ? "Removed — no matching arrival" : `Job ${row.otherJob}`}>
            TRANSFER
          </span>
        );
      case "desc":
        return (
          <span className="block truncate text-note text-sdc-gray-600" title={row.description}>
            {row.description}
          </span>
        );
      case "invoiceddate":
        return <span className="block truncate text-note text-sdc-gray-600">{row.lastDay || ""}</span>;
      case "total":
      case "invoiced":
        return (
          <span
            className={`${money} text-sdc-navy`}
            title={
              row.hiddenParts > 0
                ? "Inventory pulls, not a purchase line - what is left after the fully moved parts hidden above. With the rows above it equals the whole transfer in the Parts Cost card"
                : "Inventory pulls, not a purchase line. Included in the Parts Cost card's Purchased and Invoiced"
            }
          >
            {usd(key === "total" ? row.total : row.invoiced)}
          </span>
        );
      case "leftspend":
        return (
          <span
            className={`${money} ${row.left !== 0 ? "text-sdc-navy" : "text-sdc-muted"}`}
            title={row.left !== 0 ? "The open PO balance of the fully moved parts hidden above" : undefined}
          >
            {usd(row.left)}
          </span>
        );
      case "status":
        return <span className="text-note font-bold text-sdc-blue-dark">TRANSFER</span>;
      default:
        return null;
    }
  };
  return (
    <>
      {cols.map((c) => (
        <td
          key={c.key}
          className={`overflow-hidden whitespace-nowrap border-b border-r border-sdc-border-soft px-2 py-1 align-middle ${c.align === "right" ? "text-right" : ""}`}
        >
          {cell(c.key)}
        </td>
      ))}
    </>
  );
}
