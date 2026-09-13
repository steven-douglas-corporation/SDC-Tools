import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCustomerName,
  resolveCanonicalCustomer,
  canonicalCustomerKey,
  pickCanonicalName,
  customerAliasFindings,
  canonicalRegistry,
  detachedFromAccount,
} from "../src/lib/customer-canonical";
import { NO_CUSTOMER } from "../src/lib/job-filters";

// ── The canonical customer layer ────────────────────────────────────────────
//
// Two classes of test here, and the distinction matters:
//
//   * What must MERGE. Formatting variants, and the reviewed groups signed off
//     on 2026-08-31 (First Solar including its site records, SDC / Steven
//     Douglas Corp., Haemonetics).
//   * What must NOT merge. This half is the one that protects the data: it is
//     easy to write a normalizer that quietly folds First Solar India into First
//     Solar, and no chart would ever admit it had.
//
// Job-shaped fixtures, so the tests exercise the same function the chart and the
// drill-through call rather than a convenient inner one.

const job = (
  customer: string | null,
  extra: { companyId?: number | null; accountId?: string | null; manual?: boolean } = {},
) => ({
  customer,
  totEtoCompanyId: extra.companyId ?? null,
  totEtoAccountId: extra.accountId ?? null,
  customerManuallyEdited: extra.manual ?? false,
});

const id = (customer: string | null, extra: Parameters<typeof job>[1] = {}) =>
  canonicalCustomerKey(job(customer, extra)).canonicalCustomerId;

// ── Formatting-only normalization ───────────────────────────────────────────

test("whitespace, case, commas, periods and Inc/Corp spellings all normalize away", () => {
  const key = normalizeCustomerName("FIRST SOLAR, INC.");
  for (const variant of [
    "FIRST SOLAR INC.",
    "First Solar Inc.",
    "First Solar, Inc.",
    "  first solar ,  inc .  ",
    "First Solar Incorporated",
  ]) {
    assert.equal(normalizeCustomerName(variant), key, `${variant} should normalize onto ${key}`);
  }
});

test("Corp / Corp. / Corporation are one suffix", () => {
  const key = normalizeCustomerName("Steven Douglas Corp.");
  assert.equal(normalizeCustomerName("STEVEN DOUGLAS CORP"), key);
  assert.equal(normalizeCustomerName("Steven Douglas Corporation"), key);
});

test("LTD / Limited, LLC and L.L.C. normalize; a dotted abbreviation does not become separate letters", () => {
  assert.equal(normalizeCustomerName("Alcon Research, LTD"), normalizeCustomerName("Alcon Research Limited"));
  assert.equal(normalizeCustomerName("Bleep, L.L.C."), "BLEEP LLC");
});

test("a company suffix is only normalized at the END of the name", () => {
  // "CO" is a suffix in "Wooster Brush Co." and a word in its own right
  // elsewhere. Rewriting it mid-name is how a normalizer starts inventing
  // customers.
  assert.equal(normalizeCustomerName("The Wooster Brush Co."), "THE WOOSTER BRUSH CO");
  assert.equal(normalizeCustomerName("Company Bakery Ltd"), "COMPANY BAKERY LTD");
});

test("hyphens and ampersands are KEPT — they carry meaning", () => {
  // Dropping the hyphen would make the Oregon Road site normalize onto the
  // parent by NAME, which is precisely the over-merge that must only ever
  // happen on the strength of an account id.
  assert.notEqual(normalizeCustomerName("First Solar - Oregon Road Perrysburg"), normalizeCustomerName("First Solar"));
  assert.notEqual(normalizeCustomerName("Pratt & Whitney"), normalizeCustomerName("Pratt Whitney"));
});

test("a blank customer normalizes to the empty key, and resolves to the no-customer bucket", () => {
  for (const blank of [null, "", "   "]) {
    assert.equal(normalizeCustomerName(blank), "");
    const resolved = resolveCanonicalCustomer({ rawCustomerName: blank });
    assert.equal(resolved.canonicalCustomerId, "no-customer");
    assert.equal(resolved.canonicalCustomerName, NO_CUSTOMER);
  }
});

// ── What must merge ────────────────────────────────────────────────────────

test("all five First Solar spellings land on one canonical customer, by NAME alone", () => {
  // No account id on any of these, so this is the fallback path — the grouping
  // must hold even for a job TotalETO has never synced.
  const ids = new Set(
    ["FIRST SOLAR, INC.", "FIRST SOLAR INC.", "First Solar Inc.", "First Solar, Inc.", "First Solar"].map((n) =>
      id(n),
    ),
  );
  assert.equal(ids.size, 1, `expected one canonical customer, got ${[...ids].join(", ")}`);
  assert.equal([...ids][0], "first-solar");
});

test("the First Solar site records roll up — and do so on the strength of the ACCOUNT", () => {
  // The reviewed decision (2026-08-31): Oregon Road and NAT1 New Iberia are the
  // same reporting customer, evidenced by CAccCustomerID 'First Solar'.
  assert.equal(id("First Solar - Oregon Road Perrysburg", { companyId: 1754, accountId: "First Solar" }), "first-solar");
  assert.equal(
    id("NAT1 First Solar New Iberia Manufacturing", { companyId: 1783, accountId: "FIRST SOLAR" }),
    "first-solar",
  );
});

test("the account id is matched case-insensitively — TotalETO stores it both ways", () => {
  // Real values from tblCompany: #1616 carries 'FIRST SOLAR', #1618 'First Solar'.
  assert.equal(id("FIRST SOLAR, INC.", { companyId: 1616, accountId: "FIRST SOLAR" }), "first-solar");
  assert.equal(id("First Solar, Inc.", { companyId: 1618, accountId: "First Solar" }), "first-solar");
});

test("SDC and Steven Douglas Corp. are one customer", () => {
  assert.equal(id("SDC"), "steven-douglas");
  assert.equal(id("Steven Douglas Corp."), "steven-douglas");
  assert.equal(id("Steven Douglas Corporation"), "steven-douglas");
  assert.equal(id("Steven Douglas Corp.", { companyId: 1 }), "steven-douglas");
});

test("Haemonetics and Haemonetics Manufacturing, Inc. are one customer", () => {
  assert.equal(id("Haemonetics"), "haemonetics");
  assert.equal(id("Haemonetics Manufacturing, Inc.", { companyId: 1794 }), "haemonetics");
});

test("two spellings on one account merge with NO registry entry — the maintainable path", () => {
  // Nothing in the registry knows about Panduit. Both rows still land together,
  // because the account id does the work.
  const a = id("PANDUIT", { companyId: 1089, accountId: "Panduit" });
  const b = id("Panduit Corp.", { companyId: 1090, accountId: "PANDUIT" });
  assert.equal(a, b);
  assert.equal(a, "account:PANDUIT");
});

// ── What must NOT merge ────────────────────────────────────────────────────

test("First Solar's foreign entities stay separate — they are their own accounts", () => {
  const parent = id("FIRST SOLAR, INC.", { companyId: 1616, accountId: "FIRST SOLAR" });
  for (const [name, companyId, accountId] of [
    ["First Solar India", 1777, "First Solar India"],
    ["First Solar Sweden", 1634, "FIRST SOLAR SWEDEN"],
    ["FIRST SOLAR MALAYSIA SDN BHD.", 529, "FIRST SOLAR KLM"],
  ] as const) {
    assert.notEqual(id(name, { companyId, accountId }), parent, `${name} must not merge into First Solar, Inc.`);
  }
});

test("sharing a word is never a reason to merge", () => {
  const distinct = ["Schneider Electric USA", "Rockwell Automation", "Alcon Research, LTD", "Alcon Laboratories"];
  assert.equal(new Set(distinct.map((n) => id(n))).size, distinct.length);
});

test("a company detached from its billing account keeps its own bar", () => {
  // #1525 "USA Instruments, Inc" bills to the 'GE Healthcare' account. Following
  // that would retitle the bar to a name nobody associates with the job, and the
  // book carries a separate real GE Healthcare customer.
  const usaInstruments = id("USA Instruments, Inc", { companyId: 1525, accountId: "GE Healthcare" });
  const geHealthcare = id("GE Healthcare", { companyId: 999, accountId: "GE Healthcare" });
  assert.notEqual(usaInstruments, geHealthcare);
  assert.equal(usaInstruments, "name:USA INSTRUMENTS INC");
  assert.ok(detachedFromAccount().has(1525), "the exception must be declared in the config, not hidden in a branch");
});

test("a manually-edited customer is grouped by its name, not by the project's account", () => {
  // A manager who typed the Customer field has made a statement about it; the
  // account of whatever TotalETO project shares the job number must not
  // silently override it.
  assert.equal(
    id("First Solar Special Programs", { companyId: 1616, accountId: "FIRST SOLAR", manual: true }),
    "name:FIRST SOLAR SPECIAL PROGRAMS",
  );
  // A manual edit that spells a registry alias still lands in that group — the
  // manager and the registry agree, so there is nothing to override.
  assert.equal(id("First Solar", { companyId: 1616, accountId: "FIRST SOLAR", manual: true }), "first-solar");
});

// ── Traceability ───────────────────────────────────────────────────────────

test("every resolution records the evidence it used", () => {
  assert.equal(
    resolveCanonicalCustomer({ rawCustomerName: "FIRST SOLAR INC.", companyId: 528, accountId: "FIRST SOLAR" })
      .matchedBy,
    "account-registry",
  );
  assert.equal(resolveCanonicalCustomer({ rawCustomerName: "SDC" }).matchedBy, "alias");
  assert.equal(resolveCanonicalCustomer({ rawCustomerName: "Steven Douglas Corp.", companyId: 1 }).matchedBy, "company-registry");
  assert.equal(
    resolveCanonicalCustomer({ rawCustomerName: "Shimadzu", companyId: 1796, accountId: "Shimadzu Sci" }).matchedBy,
    "account",
  );
  assert.equal(resolveCanonicalCustomer({ rawCustomerName: "Bleep" }).matchedBy, "normalized");
});

test("the raw name is always carried through untouched", () => {
  const resolved = resolveCanonicalCustomer({ rawCustomerName: "  FIRST SOLAR, INC.  ", accountId: "FIRST SOLAR" });
  assert.equal(resolved.rawCustomerName, "FIRST SOLAR, INC.");
  assert.equal(resolved.canonicalCustomerName, "First Solar, Inc.");
  assert.equal(resolved.normalizedCustomerName, "FIRST SOLAR INC");
});

test("a registry entry names its own group; an unnamed group takes its dominant spelling", () => {
  assert.equal(canonicalCustomerKey(job("SDC")).registryName, "Steven Douglas Corp.");
  assert.equal(canonicalCustomerKey(job("Bleep")).registryName, null);
  assert.equal(
    pickCanonicalName([
      { name: "PANDUIT", count: 2 },
      { name: "Panduit Corp.", count: 5 },
    ]),
    "Panduit Corp.",
  );
});

test("pickCanonicalName breaks ties alphabetically, so a refresh cannot reshuffle a label", () => {
  const rows = [
    { name: "Bravo Inc.", count: 3 },
    { name: "Alpha Inc.", count: 3 },
  ];
  assert.equal(pickCanonicalName(rows), "Alpha Inc.");
  assert.equal(pickCanonicalName([...rows].reverse()), "Alpha Inc.", "input order must not matter");
});

test("resolution is pure — the same job always resolves the same way", () => {
  const j = job("FIRST SOLAR INC.", { companyId: 528, accountId: "FIRST SOLAR" });
  assert.deepEqual(canonicalCustomerKey(j), canonicalCustomerKey({ ...j }));
});

test("every registry entry has a note explaining why it exists", () => {
  // A mapping nobody can audit is a mapping nobody can safely change.
  for (const entry of canonicalRegistry()) {
    assert.ok(entry.note && entry.note.length > 40, `${entry.id} needs a real note`);
    assert.ok(entry.id && entry.name, `${entry.id} needs an id and a display name`);
  }
});

// ── The Data Quality finding ───────────────────────────────────────────────

test("aliasing is reported, not hidden — a group of one spelling is not a finding", () => {
  const jobs = [
    { jobId: "1123", ...job("FIRST SOLAR, INC.", { companyId: 1616, accountId: "FIRST SOLAR" }) },
    { jobId: "1105", ...job("FIRST SOLAR INC.", { companyId: 528, accountId: "FIRST SOLAR" }) },
    { jobId: "1127", ...job("First Solar", { companyId: 1667, accountId: "FIRST SOLAR" }) },
    { jobId: "1150", ...job("Centrus Energy", { companyId: 1747 }) },
  ];
  const found = customerAliasFindings(jobs);
  assert.equal(found.groups.length, 1, "only the multi-spelling customer is a finding");
  const fs = found.groups[0];
  assert.equal(fs.canonicalCustomerName, "First Solar, Inc.");
  assert.equal(fs.jobCount, 3, "the finding's job count must equal the jobs behind it");
  assert.equal(fs.storedNames.length, 3);
  assert.equal(
    fs.storedNames.reduce((s, n) => s + n.jobCount, 0),
    fs.jobCount,
    "per-name counts must sum to the group total",
  );
  assert.match(fs.evidence, /accounting customer account/);
});

test("merges resting on a human decision rather than a source id are called out", () => {
  const reviewed = customerAliasFindings([]).reviewedWithoutSourceEvidence.map((r) => r.canonicalCustomerName);
  // These two have no accountIds in the registry — nothing in the source links
  // their names, so they must be visible as judgement calls.
  assert.ok(reviewed.includes("Steven Douglas Corp."));
  assert.ok(reviewed.includes("Haemonetics Manufacturing, Inc."));
  assert.ok(!reviewed.includes("First Solar, Inc."), "First Solar IS evidenced by an account id");
});

test("blank customers are not reported as an aliasing problem", () => {
  // "No customer set" is its own thing. Folding it in here would make every
  // job with an empty Customer field look like a naming inconsistency.
  const found = customerAliasFindings([
    { jobId: "1", ...job(null) },
    { jobId: "2", ...job("  ") },
  ]);
  assert.equal(found.groups.length, 0);
});
