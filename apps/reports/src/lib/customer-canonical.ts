// ── The one definition of "who the customer is" (2026-08-31) ────────────────
//
// The Dashboard's "Active Jobs by Customer" chart used to group on the stored
// customer string EXACTLY as typed, and said so in a comment: no fuzzy merging,
// because a spelling rule invented on the dashboard would be a second
// definition of the customer living in one chart. That reasoning was right about
// WHERE the rule may live and wrong about whether one is needed — the book
// carried First Solar as seven different customers (12 + 5 + 2 + 1 + 1 spelling
// variants, plus two site records), so the chart's top bar understated the
// largest customer by more than half.
//
// This module is that one definition, deliberately NOT in a dashboard file:
// nothing here imports prisma, server-only, or any component, so the Projects
// page, an export, or the next chart can all resolve a customer the same way.
//
// ── Why this is not string matching ─────────────────────────────────────────
//
// The primary key is a STABLE SOURCE IDENTIFIER, not a name. TotalETO's
// tblCompany carries CAccCustomerID — the accounting customer ACCOUNT — and it
// already answers the question the names cannot: "FIRST SOLAR INC." (#528),
// "FIRST SOLAR, INC." (#1616), "First Solar, Inc." (#1618), "First Solar Inc."
// (#1625), "First Solar" (#1667), "First Solar - Oregon Road Perrysburg"
// (#1754) and "NAT1 First Solar New Iberia Manufacturing" (#1783) are all
// account "First Solar", while "First Solar India", "First Solar Sweden" and
// "FIRST SOLAR MALAYSIA SDN BHD." are their own accounts and must stay their own
// bars. No name rule could have drawn that line; the account already had.
//
// (tblCompany.CCompanyParent looks like the field for this and is not: it is set
// on exactly ONE row of the whole table. vwProjects.CompanyID alone is no help
// either — TotalETO itself holds five duplicate First Solar company records.)
//
// Name handling is therefore the FALLBACK, for jobs TotalETO has never seen (8
// of 59 active jobs today: the internal 4000/7000/10000-series, Bleep,
// Haemonetics, Johnson Matthey) and for the window before a sync has run.
//
// ── Resolution priority ─────────────────────────────────────────────────────
//
//   1. CANONICAL registry hit on the accounting account id  (stable source id)
//   2. CANONICAL registry hit on the TotalETO CompanyID      (stable source id)
//   3. CANONICAL registry hit on a normalized name alias     (reviewed mapping)
//   4. The accounting account id on its own                  (stable source id)
//   5. The normalized name on its own                        (formatting only)
//   6. NO_CUSTOMER
//
// Step 4 is what makes this maintainable rather than a growing list: a customer
// that acquires a second spelling in TotalETO tomorrow merges with no code
// change at all, because both spellings hang off one account. The registry only
// has to carry what an account id cannot express.
//
// Step 5 collapses formatting ONLY. It will never merge two names because they
// share a word — "First Solar - Oregon Road Perrysburg" and "First Solar, Inc."
// have different normalized names and are joined by their ACCOUNT, so if
// accounting ever splits that site off, this app splits it back out on the next
// sync instead of quietly keeping a merge nobody can trace.

import { NO_CUSTOMER } from "@/lib/job-filters";

/** What we know about one job's customer, from the job row. */
export type CustomerIdentitySource = {
  /** Job.customer, exactly as stored. */
  rawCustomerName: string | null;
  /** Job.totEtoCompanyId — tblCompany.CompanyID, captured by syncFromTotalEto. */
  companyId?: number | null;
  /** Job.totEtoAccountId — tblCompany.CAccCustomerID, the accounting customer account. */
  accountId?: string | null;
  /** Job.customerManuallyEdited — a manager typed this customer on the Projects tab. */
  customerManuallyEdited?: boolean | null;
};

/** How a job reached its canonical customer. Carried through to Data Quality so a merge is always traceable. */
export type CanonicalMatch = "account-registry" | "company-registry" | "alias" | "account" | "normalized" | "none";

export type CanonicalCustomer = {
  /** The customer string exactly as stored on the job. */
  rawCustomerName: string;
  /** Formatting-only normalization of the raw name — upper-cased, so it is a MATCH KEY, not a label. */
  normalizedCustomerName: string;
  /** What the graph groups by. Stable across refreshes for a given (account, company, name). */
  canonicalCustomerId: string;
  /**
   * Best label known from this row alone. For a registry hit this is the
   * reviewed display name and is final; otherwise it is the raw spelling and
   * the aggregation layer picks the group's label — see pickCanonicalName.
   */
  canonicalCustomerName: string;
  matchedBy: CanonicalMatch;
};

// ── Formatting-only normalization ───────────────────────────────────────────
//
// Everything here is a difference in how a name was TYPED, never a claim about
// who the customer is.

/**
 * Company-suffix spellings that mean the same thing, normalized to one token.
 * Applied to TRAILING tokens only, which is what keeps them unambiguous — "CO"
 * is a suffix in "Wooster Brush Co." and a word in "CO2 Systems", and only the
 * position tells them apart.
 */
const SUFFIX_FORMS = new Map<string, string>([
  ["INC", "INC"],
  ["INCORPORATED", "INC"],
  ["CORP", "CORP"],
  ["CORPORATION", "CORP"],
  ["CO", "CO"],
  ["COMPANY", "CO"],
  ["LTD", "LTD"],
  ["LIMITED", "LTD"],
  ["LLC", "LLC"],
  ["LP", "LP"],
  ["LLP", "LLP"],
  ["PLC", "PLC"],
  ["GMBH", "GMBH"],
  ["AB", "AB"],
  ["SA", "SA"],
  ["NV", "NV"],
  ["BV", "BV"],
  ["PTY", "PTY"],
]);

/**
 * The formatting-only match key for a customer name.
 *
 * Trims, collapses runs of whitespace, upper-cases, drops commas and the
 * periods inside abbreviations ("INC." -> "INC", "L.L.C." -> "LLC"), and
 * normalizes trailing company-suffix spellings via SUFFIX_FORMS.
 *
 * Deliberately conservative about what else it touches: hyphens and ampersands
 * are KEPT (they distinguish "First Solar - Oregon Road Perrysburg" from
 * "First Solar", and "Pratt & Whitney" is not "Pratt Whitney"), and no word
 * inside the name is abbreviated or expanded. Returns "" for a blank name.
 */
export function normalizeCustomerName(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return "";

  const flattened = trimmed
    .toUpperCase()
    // Commas and periods in these names are punctuation-as-formatting only:
    // "FIRST SOLAR, INC." and "FIRST SOLAR INC" are one name typed two ways.
    // Dropping the period rather than replacing it with a space is what makes
    // "L.L.C." land on "LLC" instead of "L L C".
    .replace(/[.,]/g, "")
    // Curly quotes/apostrophes and the unicode dashes people paste in from
    // Word, folded onto their ASCII forms before anything compares them.
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  // Trailing suffix tokens only. Loops so "Inc., Ltd." style tails normalize
  // fully, and stops at the first token that is not a suffix so a real word is
  // never rewritten.
  const tokens = flattened.split(" ");
  for (let i = tokens.length - 1; i >= 1; i--) {
    const mapped = SUFFIX_FORMS.get(tokens[i]);
    if (!mapped) break;
    tokens[i] = mapped;
  }
  return tokens.join(" ");
}

/** The formatting-only match key for an accounting account id. Case and spacing only — the id itself is never rewritten. */
function normalizeAccountId(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

// ── The reviewed registry ───────────────────────────────────────────────────
//
// The ONE place a business-specific mapping may live. Every entry below was
// checked against the job book and TotalETO on 2026-08-31 and signed off; an
// entry is a statement that these really are one reporting customer, not a
// guess that two names look similar.
//
// `accountIds` and `companyIds` are the evidence. `aliases` (normalized names)
// exist so the grouping still holds for jobs TotalETO has no project for, and
// so it holds before the first sync writes the account columns.

type CanonicalEntry = {
  /** Stable, human-readable, and never regenerated — this is what the chart groups by and the drill filters on. */
  id: string;
  /** The label the chart shows. */
  name: string;
  /** tblCompany.CAccCustomerID values (compared case-insensitively) that belong to this customer. */
  accountIds?: string[];
  /** tblCompany.CompanyID values that belong to this customer. */
  companyIds?: number[];
  /** normalizeCustomerName() outputs that belong to this customer. */
  aliases?: string[];
  /** Why this entry exists, for whoever maintains it next. */
  note: string;
};

const CANONICAL: CanonicalEntry[] = [
  {
    id: "first-solar",
    name: "First Solar, Inc.",
    // The account id does the real work: it covers all five spelling variants
    // AND the two site records, and it excludes First Solar India / Sweden /
    // Malaysia / France / Vietnam, which are separate accounts.
    accountIds: ["FIRST SOLAR"],
    // Belt and braces for the spellings a sync-less job could carry. The SITE
    // names are here too, because rolling them up was an explicit reviewed
    // decision (2026-08-31) — not something to leave depending on whether the
    // TotalETO sync has run. If accounting ever splits a site into its own
    // account, remove it here as well or the split will not show up.
    aliases: [
      "FIRST SOLAR",
      "FIRST SOLAR INC",
      "FIRST SOLAR - OREGON ROAD PERRYSBURG",
      "NAT1 FIRST SOLAR NEW IBERIA MANUFACTURING",
      "PGT4 FIRST SOLAR PERRYSBURG MANUFACTURING",
      "PGTW5 FIRST SOLAR PERRYSBURG",
      "DRT1 FIRST SOLAR DECATUR MANUFACTURING",
      "FIRST SOLAR (BLANK)",
    ],
    note:
      "TotalETO holds 5 duplicate company records for the US parent (#528, #1616, #1618, #1619, #1625) plus per-site records " +
      "(#1754 Oregon Road, #1783 NAT1 New Iberia, #1760 PGT4, #1773 PGTW5, #1790 DRT1). All carry CAccCustomerID 'First Solar'. " +
      "India (#1777), Sweden (#1634), Malaysia (#529), France (#527) and Vietnam (#532) have their OWN accounts and are NOT here.",
  },
  {
    id: "steven-douglas",
    name: "Steven Douglas Corp.",
    // No accounting account on either side — TotalETO #1 has CAccCustomerID
    // NULL, and the "SDC" jobs (4000, 7000, 10000-series) have no TotalETO
    // project at all. This is exactly the case an alias map is for.
    companyIds: [1],
    aliases: ["SDC", "STEVEN DOUGLAS CORP"],
    note:
      "SDC = Steven Douglas Corporation, our own internal work. job-filters.ts's isSdcCustomer() already treats both " +
      "spellings as one company for the non-billable rule, so this entry agrees with a rule that predates it rather than " +
      "inventing one. #1705 'Steven Douglas Corp. Expense Reports' is deliberately NOT included — it is not project work.",
  },
  {
    id: "haemonetics",
    name: "Haemonetics Manufacturing, Inc.",
    companyIds: [1794],
    aliases: ["HAEMONETICS", "HAEMONETICS MANUFACTURING INC"],
    note:
      "Reviewed and combined 2026-08-31 by request. There is NO account-id evidence: #1794 has CAccCustomerID NULL and job " +
      "1163 ('Haemonetics') has no TotalETO project, so this is a human decision recorded here rather than something the " +
      "data proves. Also still reported on the Data Quality tab so the source names can be standardized.",
  },
];

/**
 * Company records whose accounting account must NOT be used for grouping.
 *
 * CAccCustomerID is a BILLING account, and once in a while the billing account
 * is not the customer a manager would recognize on a chart. #1525 "USA
 * Instruments, Inc" bills to account "GE Healthcare": following it would retitle
 * that bar "GE Healthcare", which is true of the invoice and useless on a chart
 * about who the work is for — and the book separately carries a real
 * "GE Healthcare" customer.
 *
 * Listed here rather than special-cased in the resolver so the exception is
 * visible, reviewable, and reversible in one line. Such a job falls through to
 * the name rules and keeps its own bar; data-quality.ts reports the parent
 * relationship so the link is not lost.
 */
const DETACHED_FROM_ACCOUNT = new Map<number, string>([
  [1525, "USA Instruments, Inc bills to the 'GE Healthcare' account; the bar keeps the name the job is known by."],
]);

// Lookup indexes, built once. Keyed on normalized forms so the registry above
// can be written the way a person would read it.
const BY_ACCOUNT = new Map<string, CanonicalEntry>();
const BY_COMPANY = new Map<number, CanonicalEntry>();
const BY_ALIAS = new Map<string, CanonicalEntry>();
for (const entry of CANONICAL) {
  for (const a of entry.accountIds ?? []) BY_ACCOUNT.set(normalizeAccountId(a), entry);
  for (const c of entry.companyIds ?? []) BY_COMPANY.set(c, entry);
  for (const n of entry.aliases ?? []) BY_ALIAS.set(normalizeCustomerName(n), entry);
  // The entry's own display name is always an alias of itself, so the registry
  // never has to repeat it in `aliases`.
  BY_ALIAS.set(normalizeCustomerName(entry.name), entry);
}

/** The registry, for the Data Quality tab and for tests that assert what is merged. */
export function canonicalRegistry(): readonly CanonicalEntry[] {
  return CANONICAL;
}

/** Company records deliberately excluded from account-based grouping, with the reason. */
export function detachedFromAccount(): ReadonlyMap<number, string> {
  return DETACHED_FROM_ACCOUNT;
}

/**
 * Resolve one job's customer to its canonical customer.
 *
 * Pure and total: same input, same output, every time — which is what makes
 * "a refresh must not change canonical assignments unpredictably" a property of
 * the code rather than a hope. The only inputs are the stored job fields, so an
 * assignment can only move when the underlying job or the registry moves.
 */
export function resolveCanonicalCustomer(source: CustomerIdentitySource): CanonicalCustomer {
  const rawCustomerName = (source.rawCustomerName ?? "").trim();
  const normalizedCustomerName = normalizeCustomerName(rawCustomerName);

  if (normalizedCustomerName === "") {
    return {
      rawCustomerName: NO_CUSTOMER,
      normalizedCustomerName: "",
      canonicalCustomerId: "no-customer",
      canonicalCustomerName: NO_CUSTOMER,
      matchedBy: "none",
    };
  }

  const companyId = source.companyId ?? null;
  // A manager who typed this customer by hand on the Projects tab has made an
  // explicit statement about it, and it must not be silently overridden by the
  // account of whatever TotalETO project shares the job number. Such a job is
  // grouped by its name instead. (No active job is in this state today; the
  // branch exists so the manual-override contract Job.customerManuallyEdited
  // already carries for the sync also holds here.)
  const manualOverride = source.customerManuallyEdited === true;
  const detached = companyId != null && DETACHED_FROM_ACCOUNT.has(companyId);
  const accountKey = manualOverride || detached ? "" : normalizeAccountId(source.accountId);

  const hit = (entry: CanonicalEntry, matchedBy: CanonicalMatch): CanonicalCustomer => ({
    rawCustomerName,
    normalizedCustomerName,
    canonicalCustomerId: entry.id,
    canonicalCustomerName: entry.name,
    matchedBy,
  });

  // 1. Stable source identifier, reviewed.
  if (accountKey !== "") {
    const entry = BY_ACCOUNT.get(accountKey);
    if (entry) return hit(entry, "account-registry");
  }
  // 2. Stable source identifier, reviewed.
  if (companyId != null && !manualOverride) {
    const entry = BY_COMPANY.get(companyId);
    if (entry) return hit(entry, "company-registry");
  }
  // 3. Reviewed alias mapping.
  const aliasEntry = BY_ALIAS.get(normalizedCustomerName);
  if (aliasEntry) return hit(aliasEntry, "alias");
  // 4. Stable source identifier, unreviewed — two spellings on one account
  //    merge with no code change. The label is settled by pickCanonicalName.
  if (accountKey !== "") {
    return {
      rawCustomerName,
      normalizedCustomerName,
      canonicalCustomerId: `account:${accountKey}`,
      canonicalCustomerName: rawCustomerName,
      matchedBy: "account",
    };
  }
  // 5. Formatting only. Anything this does not merge stays its own customer.
  return {
    rawCustomerName,
    normalizedCustomerName,
    canonicalCustomerId: `name:${normalizedCustomerName}`,
    canonicalCustomerName: rawCustomerName,
    matchedBy: "normalized",
  };
}

// ── The grouping key, in the shape the job rows actually have ────────────
//
// resolveCanonicalCustomer() above answers "who is this job's customer" for one
// row. This is the thin wrapper the CHART and the DRILL-THROUGH both call, and
// the reason it exists is the invariant those two have to hold: a bar that says
// 24 must open a table of 24. They can only be guaranteed to agree for as long
// as they narrow with the same function, so there is exactly one of it.

/** What a caller needs to group and label a job, and nothing else. */
export type CanonicalCustomerKey = {
  canonicalCustomerId: string;
  /**
   * The reviewed display name, when this group came from the registry — that
   * label is final. Null when the group was formed by a bare account id or by
   * formatting alone, in which case the caller names it with pickCanonicalName
   * over the spellings it actually collected.
   */
  registryName: string | null;
  matchedBy: CanonicalMatch;
};

/** The Job columns customer identity is resolved from. A subset, so any `select` carrying these fits. */
export type CanonicalCustomerJob = {
  customer: string | null;
  totEtoCompanyId?: number | null;
  totEtoAccountId?: string | null;
  customerManuallyEdited?: boolean | null;
};

/**
 * The canonical customer key for one job row. THE function to group active jobs
 * by — see the note above on why there must be only one.
 */
export function canonicalCustomerKey(job: CanonicalCustomerJob): CanonicalCustomerKey {
  const resolved = resolveCanonicalCustomer({
    rawCustomerName: job.customer,
    companyId: job.totEtoCompanyId ?? null,
    accountId: job.totEtoAccountId ?? null,
    customerManuallyEdited: job.customerManuallyEdited ?? false,
  });
  // "none" is the no-customer bucket, whose label (NO_CUSTOMER) is as fixed as
  // any registry entry's — both sides must spell that bucket identically or it
  // opens an empty table.
  const named =
    resolved.matchedBy === "account-registry" ||
    resolved.matchedBy === "company-registry" ||
    resolved.matchedBy === "alias" ||
    resolved.matchedBy === "none";
  return {
    canonicalCustomerId: resolved.canonicalCustomerId,
    registryName: named ? resolved.canonicalCustomerName : null,
    matchedBy: resolved.matchedBy,
  };
}

/**
 * The label for a canonical group that the registry does not name.
 *
 * Steps 4 and 5 above group without knowing what to call the group, because a
 * per-row resolver cannot see the other rows. This picks the most-used raw
 * spelling, breaking ties alphabetically — deterministic, so the same job book
 * always produces the same label and a refresh cannot reshuffle the chart's
 * legend. A registry hit never reaches here; its name is already final.
 */
export function pickCanonicalName(rawNames: { name: string; count: number }[]): string {
  const best = [...rawNames].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))[0];
  return best?.name ?? NO_CUSTOMER;
}


// ── Keeping the naming problem visible (2026-08-31) ─────────────────────
//
// Grouping fixes the chart. It does NOT fix the data — the Customer field on the
// Projects page still holds seven spellings of First Solar — and a fix that
// makes a problem invisible is how the problem becomes permanent. This is what
// the Data Quality tab reports so the source can eventually be standardized.

export type CustomerAliasGroup = {
  canonicalCustomerId: string;
  canonicalCustomerName: string;
  /** Total jobs across every spelling, any status. */
  jobCount: number;
  /** Each stored spelling, with its job count and a couple of example job numbers. */
  storedNames: { name: string; jobCount: number; exampleJobIds: string[] }[];
  /**
   * The strongest piece of evidence behind the merge, in words. "the accounting
   * customer account 'FIRST SOLAR'" is a fact about the source; "a reviewed
   * decision" is not, and the difference is the first thing anyone auditing a
   * combined total needs to know.
   */
  evidence: string;
};

type AliasFindingJob = CanonicalCustomerJob & { jobId: string };

/** Human words for what a match was based on. Used verbatim on the Data Quality tab. */
function evidenceFor(matchedBy: CanonicalMatch, accountId: string | null): string {
  switch (matchedBy) {
    case "account-registry":
      return `the accounting customer account${accountId ? ` "${accountId}"` : ""} (TotalETO tblCompany.CAccCustomerID), reviewed`;
    case "account":
      return `the accounting customer account${accountId ? ` "${accountId}"` : ""} (TotalETO tblCompany.CAccCustomerID)`;
    case "company-registry":
      return "the TotalETO company record, reviewed";
    case "alias":
      return "a reviewed alias mapping — no source identifier links these names";
    case "normalized":
      return "formatting only (spacing, case, commas, periods, company suffix)";
    case "none":
      return "no customer on file";
  }
}

/**
 * Canonical customers whose jobs are stored under more than one name, plus the
 * two lists a reader needs to judge them: merges that rest on a human decision
 * rather than a source identifier, and the company records deliberately excluded
 * from their accounting account.
 *
 * Takes the job rows rather than reading them, so this stays free of prisma and
 * testable with fixtures.
 */
export function customerAliasFindings(jobs: AliasFindingJob[]): {
  groups: CustomerAliasGroup[];
  storedNames: number;
  reviewedWithoutSourceEvidence: { canonicalCustomerName: string; note: string }[];
  detachedFromAccount: { companyId: number; reason: string }[];
} {
  // EXAMPLE_IDS is a sample for the finding's table; jobCount is counted
  // separately and in full, so the two can never be confused for each other.
  const EXAMPLE_IDS = 3;

  type Bucket = {
    key: CanonicalCustomerKey;
    accountId: string | null;
    names: Map<string, { jobCount: number; exampleJobIds: string[] }>;
  };
  const groups = new Map<string, Bucket>();

  // One pass. Every job lands in exactly one bucket under exactly one stored
  // name, so the per-name counts sum to the bucket's total by construction.
  for (const job of jobs) {
    const key = canonicalCustomerKey(job);
    // "No customer set" is its own finding elsewhere, not an aliasing problem.
    if (key.matchedBy === "none") continue;
    const raw = (job.customer ?? "").trim();
    if (raw === "") continue;

    let bucket = groups.get(key.canonicalCustomerId);
    if (!bucket) {
      bucket = { key, accountId: (job.totEtoAccountId ?? "").trim() || null, names: new Map() };
      groups.set(key.canonicalCustomerId, bucket);
    }
    // The account id is recorded from whichever row first carried one, so a
    // group whose other rows predate the TotalETO sync still names its evidence.
    if (bucket.accountId === null) bucket.accountId = (job.totEtoAccountId ?? "").trim() || null;

    const seen = bucket.names.get(raw) ?? { jobCount: 0, exampleJobIds: [] };
    seen.jobCount += 1;
    if (seen.exampleJobIds.length < EXAMPLE_IDS) seen.exampleJobIds.push(job.jobId);
    bucket.names.set(raw, seen);
  }

  const withCounts: CustomerAliasGroup[] = [];
  for (const [canonicalCustomerId, bucket] of groups) {
    // Only a group that actually combines names is a finding — a customer stored
    // one consistent way is not a data-quality problem.
    if (bucket.names.size < 2) continue;
    const storedNames = [...bucket.names.entries()]
      .map(([name, v]) => ({ name, jobCount: v.jobCount, exampleJobIds: v.exampleJobIds }))
      .sort((a, b) => b.jobCount - a.jobCount || a.name.localeCompare(b.name));

    withCounts.push({
      canonicalCustomerId,
      canonicalCustomerName:
        bucket.key.registryName ??
        pickCanonicalName(storedNames.map((n) => ({ name: n.name, count: n.jobCount }))),
      jobCount: storedNames.reduce((sum, n) => sum + n.jobCount, 0),
      storedNames,
      evidence: evidenceFor(bucket.key.matchedBy, bucket.accountId),
    });
  }

  withCounts.sort((a, b) => b.jobCount - a.jobCount || a.canonicalCustomerName.localeCompare(b.canonicalCustomerName));

  return {
    groups: withCounts,
    storedNames: withCounts.reduce((s, g) => s + g.storedNames.length, 0),
    // An entry with no accountIds is one nothing in the source links together.
    reviewedWithoutSourceEvidence: CANONICAL.filter((e) => (e.accountIds ?? []).length === 0).map((e) => ({
      canonicalCustomerName: e.name,
      note: e.note,
    })),
    detachedFromAccount: [...DETACHED_FROM_ACCOUNT.entries()].map(([companyId, reason]) => ({ companyId, reason })),
  };
}
