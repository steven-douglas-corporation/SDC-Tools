// ── Refund lines are negative spend (2026-08-31) ────────────────────────────
//
// An invoice line whose Part / Item description says "Refund" is money coming
// BACK. TotalETO records some of them as positive amounts, so they were adding
// to parts spend instead of subtracting from it — reported live as a $31,765
// "Refund" line reading +$31,765 on the Monthly ETC Parts Spent drill.
//
// This module is the one place that rule lives. It is deliberately tiny, pure
// and free of `server-only`, so it can be applied on BOTH sides of the parts
// pipeline and unit-tested without a database:
//
//   * `sqlRefundSigned()` builds the SQL CASE, used by sync-totaleto.ts's
//     AP_LINE_AMOUNT — the one canonical AP-line-amount expression, which every
//     job/month/lifetime aggregate in that file already routes through. Fixing
//     it there is what makes the monthly parts actuals, Parts Actual, the
//     procurement totals and Money Spent Month all agree without any of them
//     knowing this rule exists.
//   * `applyRefundSign()` does the same to an already-materialised line, for the
//     two line-level queries that build their totals in TypeScript rather than
//     in SQL (getJobPartsCost's PARTS_DETAIL_SQL has its own amount expression
//     and never touches AP_LINE_AMOUNT).
//
// ── Why applying it twice is safe, and why that matters ─────────────────────
//
// The two layers OVERLAP on purpose. The SQL rule can only read
// `APDD.APDocItemDesc`, while the line-level queries display a COALESCE that
// prefers the purchase-order or item-master description — so a line can show
// "Refund" while the AP line's own description says something else, or the
// reverse. Running both catches either case.
//
// That is only safe because the operation is `-abs(x)`, which is idempotent:
// applying it to an already-negative amount leaves it alone. A blind `* -1`
// would flip a genuine credit memo (already negative in the source) back to
// positive the second time it ran — which is exactly the double-negative this
// has to avoid.

/**
 * The word that marks a refund line. One constant, shared by the SQL and the
 * TypeScript halves, so the two can never disagree about what a refund is.
 */
export const REFUND_KEYWORD = "refund";

/**
 * Whether a Part / Item description marks the line as a refund.
 *
 * Case-insensitive CONTAINS, so "Refund", "REFUND", "Customer Refund" and
 * "Parts refund" all match. Null and blank never match.
 */
export function isRefundLabel(description: string | null | undefined): boolean {
  return (description ?? "").toLowerCase().includes(REFUND_KEYWORD);
}

/**
 * The signed amount for one line: negative when the description says refund,
 * unchanged otherwise.
 *
 * `-Math.abs()`, never `* -1` — see the header. A source amount that is already
 * negative stays negative rather than flipping back to positive.
 */
export function refundSignedAmount(description: string | null | undefined, amount: number): number {
  if (!Number.isFinite(amount)) return amount;
  if (!isRefundLabel(description)) return amount;
  const signed = -Math.abs(amount);
  // Normalise -0 back to 0. `-Math.abs(0)` is negative zero, and
  // Intl.NumberFormat renders that as "-$0.00" — a zero-value refund line would
  // display as a negative nothing. `signed === 0` is true for -0, so this only
  // ever catches that case.
  return signed === 0 ? 0 : signed;
}

/** The money fields on a parts line that this rule signs. */
type SignableLine = {
  description: string | null;
  totalPrice: number;
  invoicedAmount: number;
  actualAmount: number;
};

/**
 * A copy of `line` with its money AMOUNTS signed by the refund rule.
 *
 * Returns the same object when the line is not a refund, so the common path
 * allocates nothing.
 *
 * `quantity` and `unitPrice` are deliberately untouched. A unit price is a RATE,
 * not an amount — negating it would say the part costs minus-something each,
 * and on a line recorded as a negative QUANTITY against a positive rate it would
 * flip the row back to positive spend. The three fields below are the ones every
 * total in the app sums.
 */
export function applyRefundSign<T extends SignableLine>(line: T): T {
  if (!isRefundLabel(line.description)) return line;
  // Through refundSignedAmount, not a second `-Math.abs()` here — one definition
  // of the sign, including its -0 handling.
  const sign = (amount: number) => refundSignedAmount(line.description, amount);
  return {
    ...line,
    totalPrice: sign(line.totalPrice),
    invoicedAmount: sign(line.invoicedAmount),
    actualAmount: sign(line.actualAmount),
  };
}

/**
 * The SQL equivalent: wraps a money expression so a refund description forces it
 * negative.
 *
 * `LOWER(...) LIKE '%refund%'` rather than a bare LIKE. SQL Server's default
 * collation is case-insensitive and a bare LIKE would very probably work, but
 * "probably, depending on the server's collation" is not a good basis for the
 * sign of a money column — this is explicit and collation-independent.
 *
 * ISNULL on the description so a NULL never makes the whole CASE NULL.
 */
export function sqlRefundSigned(amountExpr: string, descriptionExpr: string): string {
  return `(CASE WHEN LOWER(ISNULL(${descriptionExpr}, '')) LIKE '%${REFUND_KEYWORD}%' THEN -ABS(${amountExpr}) ELSE (${amountExpr}) END)`;
}
