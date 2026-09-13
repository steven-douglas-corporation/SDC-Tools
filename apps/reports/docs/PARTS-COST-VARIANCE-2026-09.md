# Parts Cost Variance — the eight largest-difference jobs

Explains why **Parts Cost Actual** in the Reports app disagrees with the comparison column
in the reported spreadsheet, across the eight jobs with the largest differences. Also
answers a separate question: the invoiced total on **PO 103046**, which is charged against
jobs 1130, 1142 and 1143.

- **Date run:** 2026-09-03
- **App side:** `getPartsCostForJobs` in `src/lib/sync-totaleto.ts`, at line level —
  ~6,000 PO lines across the eight jobs
- **Fields compared:** `actualAmount` (GL-posted) against `invoicedAmount` (billed);
  see that file's own note on `GL_POSTED_AP`
- **Verdict:** not a data error. **One accounting rule, one refund, and one timing lag.**
  Six of the eight are the rule; 1148 is the refund; 1158 is the lag.

> ### ⚠️ Corrected 2026-09-04 — read §2.1 before acting on this document
>
> This report explained the variance as billings that **never reach the ledger**. That
> premise is wrong, and §6's "policy question for Dan" has been answered by accounting.
> Some flagged documents are already paid and already on the ledger; others are
> corrections that must never count. The figures below are all still accurate — the
> *interpretation* of what `APDocDoNotExport` means was not. §2.1 carries the correction
> and what shipped because of it.

| | Meaning | App field |
|---|---|---|
| **Posted** | The AP document exports to the general ledger | `actualAmount` |
| **Billed** | Everything invoiced, including documents flagged never to export | `invoicedAmount` |

The spreadsheet's first column is **posted**. The comparison column is **billed**. The gap
between them is the flagged documents.

---

## 1. The eight jobs

`Billed − posted` is measured live from the parts pipeline. Where it matches the reported
gap, the accounting rule fully accounts for the variance.

| Job | Project | Your gap | Billed − posted | Explains it? | Cause |
|---|---|---:|---:|---|---|
| 1106 | SDC Clip-iT 1.1 QTY (8) | $253,668 | $253,667 | **exact** | Unposted billings |
| 1122 | CAFI | $22,458 | $22,778 | within $320 | Unposted billings |
| 1148 | BISCUIT QTY 10 | −$28,988 | −$29,040 | within $52 | **Supplier refund** |
| 1118 | AIR Loop Assembly | $8,125 | $10,873 | partial | Unposted billings |
| 1150 | USEC Heat Shield Spiral Machine | $9,688 | $11,474 | partial | Unposted billings |
| 1101 | Coil Staker | $12,039 | $20,523 | partial | Unposted billings |
| 1104 | Andi 1 & Andi 2 Replacement Line | $12,347 | $46,307 | partial | Unposted billings |
| 1158 | T-066 Assembly Machine | −$18,945 | $8 | **no** | **Month cutoff** |

### 1.1 Why four rows are only a partial match

They are explained in kind but not to the dollar, and the reason is that the **spreadsheet
itself has moved on**. Its Parts Cost Actual no longer equals the app's:

| Job | Spreadsheet | App now | Drift |
|---|---:|---:|---:|
| 1118 | $508,075 | $509,160 | $1,085 |
| 1150 | $101,162 | $101,299 | $137 |
| 1158 | $79,212 | $80,482 | $1,270 |

The two columns were captured at slightly different moments. The residuals on those rows are
that drift, **not a fourth cause** — worth stating so nobody goes looking for one.

---

## 2. Cause 1 — billings that never reach the ledger

**Affects 6 of the 8 jobs.**

The app counts a line as actual cost only when its AP document posts to the general ledger.
Documents flagged never-to-export are billed but not posted, so they land in the comparison
column and not in the app's. Three suppliers account for nearly all of it:

| Supplier as it appears | What it is |
|---|---|
| `Steven Douglas Corp.` | SDC's own internal expense billings — 38 lines on 1101, 117 on 1104 |
| `SDC Credit Card (Approved)` | Company card purchases, booked monthly |
| `Steven Douglas Corp. Expense` | Expense reimbursements charged to the job |

Every one of these lines shows a billed amount against **$0.00 posted**.

Job 1106 is the cleanest case — 10 lines, $253,667.23, matching the reported gap to the
dollar.

### 2.1 Correction — the flag does not mean "never reaches the ledger"

**Added 2026-09-04.** The heading of this section is wrong, and so is the sentence
"Documents flagged never-to-export are billed but not posted." Lisa in accounting:

> Our norm is to enter all purchasing activity for jobs into ETO and then export it from
> ETO and import into Sage for payments. However there are times when items are entered
> into Sage first but need to be reflected in ETO — these are then reflected as do not
> export and **have been paid**.

`APDocDoNotExport` means *"do not export this to Sage **again**"*, not *"this never posts"*.

**Verified, not taken on trust.** All six of job 1101's flagged SDC Credit Card charges
appear in the August job ledger draft as `GENJ` journal rows (referenced `07.31 WESBANCO
CC` and so on), reconciling **to the cent** — three matched directly, three are split on
the ledger side into freight and food-expense components:

| ETO line | Job ledger (GENJ) | |
|---|---|---|
| 12.25 CC $2,874.57 | $2,357.61 freight + $516.96 | ✓ |
| 01.26 CC $2,660.35 | $2,492.67 freight + $167.68 food | ✓ |
| 04.26 CC $1,244.51 | $1,077.34 freight + $167.17 food | ✓ |

Counted from both ends across the whole ledger: **$75,068.36** of CC journal postings on 31
jobs, against **$76,508.61** of flagged CC lines in ETO. Same money.

#### But it is not "stop excluding flagged documents"

That was the obvious next move and it would have been badly wrong. Checking all 33 jobs
with flagged spend against the ledger: only **6 reconcile to the cent**, 3 more within $50,
and **$296,091 has no ledger counterpart at all**.

Job 1106 is why. Its $253,667 is not purchases — it is five accounting corrections:

| Description | Supplier | Amount |
|---|---|---:|
| SOLAR SIMULATOR 6000B-100-002 | Innovations in Optics | −$675,000.00 |
| DISCOUNT Correction | Innovations in Optics | $337,500.00 |
| DISCOUNT Correction | Innovations in Optics | $252,800.00 |
| **Adjustment to match Sage** | Steven Douglas Corp. | $209,625.00 |
| EXCESS MATERIALS RELATED TO PO | Innovations in Optics | $128,090.00 |

The PO number on the fourth is literally `1106 correction`, and elsewhere in the data there
is a vendor named `Reconciling With Sage - SDC`. These exist **only to make ETO agree with
Sage**, which is exactly why they have no ledger counterpart — the ledger already holds the
figure they correct toward. Counting them as spend would double-count it.

Note also: §1 reports job 1106's gap as $928,667 in some earlier summaries. That was the
gross of the positive lines; the **net is $253,667**, after the −$675,000 reversal above.

#### So the flag is overloaded, across at least three meanings

| What it is | Amount | Counts as spent? |
|---|---:|---|
| Sage-first purchases — SDC Credit Card, 158 lines | $112,630 | **Yes**, as of 2026-09-04 |
| Employee expense reimbursements — 59 lines | $44,524 | **Yes**, as of 2026-09-04 |
| ETO→Sage reconciling adjustments | ~$253,600 | **No** — would double-count |
| Internal SDC billings (`Steven Douglas Corp.`) | $430,729 | **Not yet** — no ledger match found |

#### 2.2 Job 1101's Extra Payables, reconciled line for line

**Added 2026-09-04**, from ETO's own material-costs report for the job. The app's
extra-cost lines total **$29,100.81** across 17 rows — matching that report exactly.

Applying the same ledger test the card charges passed, the expense reimbursements pass
it too. All three in-period lines reconcile to the cent as `GENJ` *Payroll* postings,
one of them split across two employees on a single day exactly as the card charges split
into freight and food components:

```
2026-02-20   $57.64   Employee reimbursements - Shaffer
2026-05-29   $40.00   Employee reimbursements - Klingensmith  } $61.02
2026-05-29   $21.02   Employee reimbursements - Siegfried     }
2026-07-24   $10.49   Employee reimbursements - Novotney
            $129.15 = 57.64 + 61.02 + 10.49
```

(The fourth, $22.02, is dated 2026-09-04 — after this ledger draft — so its absence is
the draft's period, not evidence against it.)

**One line on job 1101 is still excluded: $480.00**, the flagged
`Reconciling with Sage - Factory Automation PO 51206` entry, which has no ledger
counterpart. Correct.

And it exposes something the flag alone cannot explain: job 1101 carries **three**
`Reconciling With Sage - SDC` entries, and only that one is flagged. The other two —
$9,430.05 and $4.34 — are unflagged and have therefore counted as spend all along. The
flag is applied inconsistently *within a single vendor on a single job*, which is the
sharpest remaining question for accounting.

#### What shipped

`GL_POSTED_AP` in `src/lib/sync-totaleto.ts` now counts a flagged document as posted when
its vendor is on an explicit allow-list (`SAGE_FIRST_VENDORS`), which holds `SDC Credit
Card` alone — the only category verified against the ledger. August's Left to Invoice fell
from $2,138,248 to **$2,048,239**.

Three things worth knowing about that change:

- **The first attempt changed nothing.** The monthly card charges are **Extra Costs, not PO
  lines**, and that branch had the flag test spelled out by hand instead of calling the
  shared predicate — so narrowing the predicate never reached the branch that decides them.
  There is now one definition and four call sites, with a test asserting `APDocDoNotExport`
  appears exactly once in the file.
- **The vendor is matched exactly, never by pattern.** `CName LIKE '%credit card%'` would
  also catch `onlinecomponents.com  CREDIT CARD` (CompanyID 1071), a real outside supplier —
  invisible today because none of its 8 documents are flagged, and wrong the first time one
  is.
- **The allow-list is audited.** `scripts/audit-sage-first-vendors.ts` lists every vendor
  billing on flagged documents with its counted/excluded status, so a new Sage-first
  arrangement surfaces instead of quietly keeping today's behaviour.

**Open with accounting:** how to tell a Sage-first purchase from a reconciling adjustment
without matching on vendor names. Until that is answered, `Steven Douglas Corp.` internal
billings, `Steven Douglas Corp. Expense Reports` and `Reconciling With Sage - SDC` stay
excluded — the safe direction, since it understates rather than overstates.

**Lines where billed exceeds posted, by job:**

| Job | Lines | Net billed − posted |
|---|---:|---:|
| 1104 | 117 | $46,307.23 |
| 1122 | 58 | $22,778.19 |
| 1118 | 47 | $10,873.29 |
| 1101 | 38 | $20,522.72 |
| 1106 | 10 | $253,667.23 |
| 1150 | 9 | $11,474.29 |
| 1148 | 6 | −$29,039.76 |
| 1158 | — | $7.50 |

Note 1106 reaches the largest amount on the fewest lines: these are a handful of very large
credit-card-booked documents, not a long tail.

---

## 3. Cause 2 — a supplier refund, also unposted

> **Not a separate cause (2026-09-04).** Mechanically this *is* §2 — a document flagged
> `APDocDoNotExport` — that happens to be negative, which is the only reason 1148 breaks
> the direction of every other row. Kept as its own section because the sign is worth
> calling out, but there are **two** causes in this report, not three: the accounting rule
> and the timing lag. Nobody should go looking for a third mechanism here.

**Affects job 1148 only**, and it is the only large negative in the set.

One document explains it: a **BlackHawk Supply refund of −$31,765.20**, billed but never
posted. Two further BlackHawk credits sit in the same state:

| PO | Supplier | Description | Total | Posted |
|---|---|---|---:|---:|
| Refund | BlackHawk Supply | Refund | −$31,765.20 | $0.00 |
| 105137 | BlackHawk Supply | Temperature and Humidity | −$23,104.80 | $0.00 |
| 105137 | BlackHawk Supply | Modbus compatible USB | −$8,660.40 | $0.00 |

Because the refund is in the comparison column and not in the app's, that column reads
**lower** — which is why 1148 breaks the direction of every other row.

---

## 4. Cause 3 — a month that had not landed yet

**Affects job 1158 only.** It has essentially no unposted billings — $7.50 — so its variance
is a date boundary rather than the accounting rule.

The job only began invoicing recently. All of its posted spend falls in two months:

| Invoice month | GL-posted |
|---|---:|
| 2026-08 | $59,345.12 |
| 2026-09 | $21,136.61 |
| **Total** | **$80,481.73** |

The comparison column reads **$60,267**, which is within about **$900 of the August-only
total**. That is what a source which had not yet picked up September would show.

---

## 5. PO 103046

Charged across three jobs, and **fully invoiced** — nothing outstanding, and no unposted
portion.

**Supplier:** G2V Optics Inc · **13 lines** · Suntile Gen 2 KLM+ units, SMU IV test systems,
shipping

| Job | Lines | Purchased | Invoiced (posted) | Left to invoice |
|---|---:|---:|---:|---:|
| 1130 | 5 | $1,554,100.00 | $1,554,100.00 | $0.00 |
| 1142 | 4 | $1,249,925.00 | $1,249,925.00 | $0.00 |
| 1143 | 4 | $796,475.00 | $796,475.00 | $0.00 |
| **Total** | **13** | **$3,600,500.00** | **$3,600,500.00** | **$0.00** |

Billed and posted are identical on every line, so none of this PO is affected by the rule in
§2.

### 5.1 Looking a PO up in the app

The Parts List search on **Job Hour Details → Procurement** does match PO numbers — its
haystack includes `poNumber` (see `JobProcurement.tsx`) — so typing `103046` finds the lines.

But **that view is one job at a time.** The Procurement drawer is deliberately single-job (a
BOM tree is per job), so a PO spanning three jobs takes three lookups and manual addition.
There is no cross-job PO search in the app today.

**Built 2026-09-04.** `lib/po-across-jobs.ts` reports purchased / invoiced / left to
invoice per job with a total, for any PO. It runs on the ordinary parts pipeline
(`getPartsCostForJobs`) rather than its own query, so its figures are the Parts List's
by construction. Verified against this PO — it reproduces §5's table exactly.

```
npx tsx -r ./scripts/shim-server-only.cjs scripts/po-lookup.ts 103046
```

```
PO 103046 - 3 job(s)   ** spans jobs **

  JOB    LINES        PURCHASED         INVOICED    LEFT TO INV  SUPPLIER
  1130       5    $1,554,100.00    $1,554,100.00          $0.00  G2V OPTICS INC
  1142       4    $1,249,925.00    $1,249,925.00          $0.00  G2V OPTICS INC
  1143       4      $796,475.00      $796,475.00          $0.00  G2V OPTICS INC
  TOTAL     13    $3,600,500.00    $3,600,500.00          $0.00
```

**Still to do:** an in-app surface. The capability and its tests are in place; the
Procurement drawer is single-job by design, so where a cross-job panel belongs is a UI
question that wanted browser verification this change could not perform.

---

## 6. The decision — answered 2026-09-04

**Original question:** should SDC's own expense billings and credit-card charges count as
parts actual? It was framed here as a policy question for Dan, on the premise that these
documents "do not post to the job ledger that these figures get checked against."

**That premise was false**, and the question was really two questions:

| | Answer | Basis |
|---|---|---|
| **Credit-card charges** | **Yes — count them.** Shipped. | They post to the GL through Sage and appear on the job ledger as `GENJ` rows. Verified to the cent on job 1101 and corroborated in aggregate ($75,068 ledger vs $76,509 ETO). |
| **Internal billings / expense reports** | **Still open** | No ledger counterpart found. Needs accounting to say how they are posted, if at all. |
| **Reconciling adjustments** | **No — never count them.** | They exist to make ETO match Sage. Counting them double-counts the figure they correct toward. |

The closing observation still stands and is now the load-bearing one: *whichever way it is
answered, both columns should be defined the same way, or this variance reappears every
month.* The allow-list plus `scripts/audit-sage-first-vendors.ts` is what keeps that from
drifting silently — see §2.1.

---

## 7. Reproducing this

Every figure above comes from `getPartsCostForJobs` at line level. The two sums that matter:

```ts
const posted = lines.reduce((a, l) => a + l.actualAmount, 0);   // Parts Cost Actual
const billed = lines.reduce((a, l) => a + l.invoicedAmount, 0); // the comparison column
```

`billed − posted` is the variance. The lines contributing to it are those where the two
differ:

```ts
lines.filter((l) => Math.abs(l.invoicedAmount - l.actualAmount) > 0.005)
```

For the 1158 timing finding, group `actualAmount` by `l.invoicedDate.slice(0, 7)`.

See also [JOB-LEDGER-RECON-2026-08.md](./JOB-LEDGER-RECON-2026-08.md), which reconciles the
same app figures against the August job ledger draft and reaches job 1106 by a different
route.
