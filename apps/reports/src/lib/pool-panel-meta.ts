// The four department pools, in the sheet's print order (§48).
//
// Lifted out of etc/page.tsx because the Standard Fees card is no longer rendered only by
// that page: lib/standard-fees-card.ts builds the same rows for the client-side reveal,
// and a page cannot export a helper to a server module. Two copies of this list would be
// two copies that eventually disagree about which pools exist or what order they print
// in — and the card and the grid columns sit next to each other, so a divergence would be
// visible immediately and confusing.
//
// These ARE the four sections the ETC grid deliberately excludes and the Standard Fees
// pools plan company-wide instead (see the standard-pool notes) — the list is a business
// fact, not a display preference.
export const POOL_PANEL_META = [
  { category: "ENGINEERING_PM", group: "Engineering", dept: "PM" },
  { category: "ENGINEERING_WARRANTY", group: "Engineering", dept: "Warranty" },
  { category: "SHOP_MANUFACTURING", group: "Shop", dept: "Mfg" },
  { category: "SHOP_WARRANTY", group: "Shop", dept: "Warranty" },
] as const;
