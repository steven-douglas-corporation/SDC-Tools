import { normPn } from "@/lib/parts-cost-window-attribution";

// Why a purchase-order line has no BOM row — determined per line, not asserted.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// The Parts List is the BOM, and a job also buys things no BOM row carries. Those
// dollars were reported as one lump ("$88,643 on 90 part numbers with no BOM row")
// with a guessed parenthetical listing what they might be. Measured on job 1101 that
// lump is 471 PO lines, and the guess was materially wrong: the largest single
// bucket is not freight but SERVICES and fees against a part-numbered charge code
// (anodizing, plating, tooling, purchase-order fees), and four lines were not
// non-BOM at all — they are a BOM part whose number is punctuated differently
// upstream, a join failure worth $635 that the summary was quietly absorbing.
//
// So the reason is computed for each line and shown on the row. A bucket named
// "unknown" is a real answer and appears as one; a bucket named after a guess is not.
//
// ── Order matters ───────────────────────────────────────────────────────────
//
// Join failures are tested FIRST. A line that a corrected join would attach to a BOM
// part is a defect to fix, not a category to file it under — labelling it "freight"
// because its description happens to mention shipping would bury exactly the thing
// worth finding.

export type MatchReason =
  | "matched"
  | "join-punctuation"
  | "join-suffix"
  | "join-leading-zero"
  | "blank-part-number"
  | "freight"
  | "tariff"
  | "service"
  | "fee"
  | "misc-purchase"
  | "credit"
  | "no-purchase"
  | "non-bom";

/** Short badge text for the row. */
export const MATCH_REASON_LABEL: Record<MatchReason, string> = {
  matched: "BOM",
  "join-punctuation": "JOIN FIX",
  "join-suffix": "JOIN FIX",
  "join-leading-zero": "JOIN FIX",
  "blank-part-number": "NO PART NO",
  freight: "FREIGHT",
  tariff: "TARIFF",
  service: "SERVICE",
  fee: "FEE",
  "misc-purchase": "MISC",
  credit: "CREDIT",
  "no-purchase": "NOT BOUGHT",
  "non-bom": "NON-BOM",
};

/** The full sentence, for the row's tooltip and the reason column. */
export const MATCH_REASON_TEXT: Record<MatchReason, string> = {
  matched: "Matched to a BOM row",
  "join-punctuation": "Same part as a BOM row, punctuated differently upstream — matched by the corrected join",
  "join-suffix": "A BOM part carrying a job suffix upstream — matched by the corrected join",
  "join-leading-zero": "Same part as a BOM row, with leading zeros upstream — matched by the corrected join",
  "blank-part-number": "The purchase line carries no part number (expense reimbursement, credit-card purchase)",
  freight: "Freight or shipping charge — not a BOM part",
  tariff: "Tariff, duty or customs charge — not a BOM part",
  service: "An outside process or service booked against the job (plating, anodizing, heat treat, machining)",
  fee: "A supplier or purchase-order fee",
  "misc-purchase": "Miscellaneous or credit-card purchase",
  credit: "A credit, discount or negative adjustment",
  "no-purchase":
    "A BOM part with no purchase line yet — its cost here is the BOM estimate (unit price x qty), not money spent",
  "non-bom": "A purchased item with no row in the current BOM — a superseded revision, or bought outside the BOM",
};

// ── Looser keys, for testing whether a line is really a join failure ────────
//
// Each strips one class of upstream difference. They are only ever used to RECOVER
// a match, never to create one where the part numbers genuinely differ: a key is
// accepted only when it lands on a BOM part number that already exists.
/** "092-A-020^1101-FA-000" -> "092-A-020" — the job-suffix form seen on in-house parts. */
export const stripJobSuffix = (key: string) => key.split("^")[0];
/** Punctuation and spacing only: "MASTN20-325" -> "MASTN20325". */
export const stripPunctuation = (key: string) => key.replace(/[^A-Z0-9]/g, "");
export const stripLeadingZeros = (key: string) => key.replace(/^0+/, "");

/**
 * Every alternate key a BOM part number should also be findable under, so a lookup
 * built from these can recover a differently-punctuated upstream line.
 *
 * Deliberately NOT a fuzzy match: every entry is a deterministic transform of the
 * BOM's own part number, so a recovered line is one whose number IS the BOM part's,
 * written differently — never a different part that happens to look similar.
 */
export function alternateKeys(pn: string): { key: string; reason: MatchReason }[] {
  const base = normPn(pn);
  if (!base) return [];
  const out: { key: string; reason: MatchReason }[] = [];
  const suffix = stripJobSuffix(base);
  if (suffix && suffix !== base) out.push({ key: suffix, reason: "join-suffix" });
  const punct = stripPunctuation(base);
  if (punct && punct !== base) out.push({ key: punct, reason: "join-punctuation" });
  const zeros = stripLeadingZeros(punct);
  if (zeros && zeros !== punct) out.push({ key: zeros, reason: "join-leading-zero" });
  return out;
}

/** The same transforms applied to a purchase line's number, to look it up. */
export function lookupKeys(partNumber: string | null): { key: string; reason: MatchReason }[] {
  const base = normPn(partNumber);
  if (!base) return [];
  return [{ key: base, reason: "matched" }, ...alternateKeys(base)];
}

// Keyword tests run over part number AND description together — on job 1101 the
// charge is as often identified by the part-number field ("TARIFF", "Shipping",
// "FEE") as by the description.
const RULES: { reason: MatchReason; test: RegExp }[] = [
  { reason: "freight", test: /\bFREIGHT|SHIPPING|\bSHIP\b|DELIVERY|COURIER/ },
  { reason: "tariff", test: /TARIFF|\bDUTY\b|CUSTOMS|BROKERAGE/ },
  {
    reason: "service",
    test: /ANODIZ|PLATING|POWDER ?COAT|PAINT|HEAT ?TREAT|BLACK ?OXIDE|PASSIVAT|WELD(ING)?\b|MACHINING|GRIND(ING)?\b|LASER|WATERJET|OUTSIDE PROCESS/,
  },
  { reason: "fee", test: /\bFEE\b|SURCHARGE|MINIMUM ?(ORDER|CHARGE)|SETUP ?CHARGE|RESTOCK/ },
  { reason: "misc-purchase", test: /\bMISC|CREDIT ?CARD|\bCC\b|REIMBURS|EXPENSE|\bVMI\b/ },
  { reason: "credit", test: /DISCOUNT|CREDIT|REFUND|ADJUSTMENT|RETURN/ },
];

/**
 * Why this line has no BOM row. `recovered` is the reason a corrected join found a
 * BOM part for it, if one did — checked before any keyword, because a fixable join
 * is a defect and must not be filed away under a category.
 */
export function classifyUnmatched(
  partNumber: string | null,
  description: string | null,
  amount: number,
  recovered: MatchReason | null,
): MatchReason {
  if (recovered) return recovered;
  if (!normPn(partNumber)) return "blank-part-number";
  const text = `${partNumber ?? ""} ${description ?? ""}`.toUpperCase();
  for (const rule of RULES) if (rule.test.test(text)) return rule.reason;
  // A negative that matched no keyword is still a credit — the sign is the fact.
  if (amount < 0) return "credit";
  return "non-bom";
}
