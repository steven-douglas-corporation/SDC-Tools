// The Projects grid's "Weeks to Delivery": how many weeks lie between a job's Start Date and
// its Quoted Delivery date.
//
// Only the Quoted Delivery DATE is stored (Job.quotedDeliveryDate). The weeks are derived here,
// by the server render and by the live recalculation in the browser alike, so the figure shown
// while somebody types is the figure shown after a reload — and can never drift from the dates.
//
// Whole days are counted in UTC on the ISO day: the grid's dates are DATE-only values (stored at
// midnight UTC, rendered as yyyy-mm-dd), and local-time maths would be off by a day across a
// daylight-saving change.

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = ISO_DAY.exec(iso);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : Math.round(t / 86_400_000);
}

/**
 * Weeks from start to delivery, to one decimal (16 days → 2.3). Null when either date is
 * missing or invalid. NEGATIVE when delivery is before start — shown as such rather than
 * hidden, because that is a data-entry slip somebody should see.
 */
export function deliveryWeeks(startIso: string | null | undefined, deliveryIso: string | null | undefined): number | null {
  const a = dayNumber(startIso);
  const b = dayNumber(deliveryIso);
  if (a === null || b === null) return null;
  return Math.round(((b - a) / 7) * 10) / 10;
}

/** "16" or "16.4" — no trailing ".0"; blank when there is nothing to show. */
export function formatWeeks(weeks: number | null): string {
  if (weeks === null) return "";
  return Number.isInteger(weeks) ? String(weeks) : weeks.toFixed(1);
}
