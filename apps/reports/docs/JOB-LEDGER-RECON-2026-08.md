# Job Ledger Reconciliation — 8/31/26 draft vs the Reports app

Reconciles the preliminary **"Job Ledger Report Template - 2026.08.31_draft.xlsx"** against
the Reports app (`apps/reports`) on the two axes the request named: **August 2026
activity** and **project total spend**.

- **Date run:** 2026-08-31
- **Reference:** the workbook's `Job Ledger Processed` sheet
- **App side:** `getPartsCostBookedByJob` (Money Spent Month) and `getPartsActualByJob`
  (Parts Actual) in `src/lib/sync-totaleto.ts`, plus stored `Job.costActualHistorical`
- **Verdict:** neither figure matches exactly. Both gaps are fully decomposed with no
  unexplained residual, and **only job 1106 is a genuine problem.**

| Axis | Ledger | App | Gap | |
|---|---|---|---|---|
| August 2026 activity | $854,306 | $937,136 | **+$82,830** | +9.7%, app higher |
| Project total spend | $15,885,215 | $15,587,247 | **−$297,968** | −1.9%, app lower |

Both gaps are measured over the **41 jobs the ledger covers**, not over each system's full
job set — see [§5.2](#52-the-grand-totals-are-not-comparable).

---

## 1. Method

The workbook carries a `***refresh pivot tables` note, so the pivot caches were not trusted.
The reference numbers were re-aggregated from the raw `Job Ledger Processed` rows using the
pivots' own two filters:

```
Export Group            = "Current Month"
Is Non-Shipping Revenue = FALSE
```

The extract is self-checking, and it checks out three ways:

| Check | Extract | Workbook | |
|---|---|---|---|
| All months, net DR/CR | $15,885,215.14 | $15,885,215.14 | to the cent |
| 2026-08, net DR/CR | $854,306.45 | $854,306.45 | to the cent |
| 2026-07, net DR/CR | $420,655.50 | — | matches the $420,656 pivot that DEVLOG §25 reconciled Money Spent Month to |

That third row matters: it establishes that **this ledger and the app's Money Spent Month
are the same lineage of measure**, so the gaps below are differences in scope and timing
rather than two unrelated numbers being compared.

### 1.1 What the ledger actually contains

Every line is procurement. There is no labor in this report at all — the journal mix is
overwhelmingly `PJ` (purchase journal).

| GL account | What it is | Lines | All-time net | 2026-08 net |
|---|---|---|---|---|
| `40000-000` | Parts cost | 12,719 | $15,297,110.22 | $788,670.54 |
| `50150-000` | Shipping | 1,694 | $381,045.78 | $28,916.31 |
| `50175-000` | Tariff | 158 | $199,744.26 | $30,257.42 |
| `50500-000` | VMI | 28 | $9,417.18 | $9,417.18 |
| `30000-000` | Shipping revenue | 1 | −$3,000.00 | −$3,000.00 |
| `10220-003`, `50220-000`, `50200-000` | Bank fees, tax | 7 | $897.70 | $45.00 |
| **Grand total** | | **14,607** | **$15,885,215.14** | **$854,306.45** |

---

## 2. August 2026 activity — +$82,830

Decomposed to zero residual:

| Component | Amount | Why |
|---|---|---|
| Ledger net | $854,306 | the pivot |
| Non-purchase-journal GL entries | +$30,436 | `CRJ` / `SJ` / `GENJ` lines the app's AP-based measure cannot see |
| = Ledger, purchase journal only | $884,742 | |
| AP lines posted after the 8/31 export | +$16,345 | timing — the app is live, the workbook is a snapshot |
| `DoNotExport` AP lines | +$36,049 | deliberately included in Money Spent Month |
| **= App Money Spent Month** | **$937,136** | |

`854,306 + 30,436 + 16,345 + 36,049 = 937,136` exactly.

### 2.1 Job 1148 is two-thirds of the gap

**+$63,530 on one job.** The ledger carries a `CRJ` line for **−$31,765.20**, described
*"Blackhawk Supply Refund - Refund 155669."* That is a cash-receipts refund, not an AP
credit memo, so no amount of AP querying will find it — the app's August figure for 1148 is
$69,281, which is exactly the ledger's **debit** column with the credit never applied.

Job 1125 has the same shape at smaller scale: a **−$3,000** `SJ` line, *"PANDUIT -
SHIPPING."*

This is the one **structural** finding in the whole reconciliation. See
[§4](#4-recommendation).

### 2.2 The `DoNotExport` component is known and deliberate

$36,049 of August AP sits on documents flagged `APDocDoNotExport`, which never post to the
general ledger — so they are correctly absent from the ledger, and knowingly present in the
app. `sync-totaleto.ts` states the reasoning directly: the GL-posted rule is applied to
Parts Actual but **not** to Money Spent Month, because doing so "would move July 2026 by
$13,672.97 on a $491,206.43 month across 21 jobs — a retroactive change to signed-off
numbers."

Not a bug. It is a business decision about which reference report the monthly measure should
follow, and it was flagged rather than silently changed.

### 2.3 Per-job, August

App column is Money Spent Month as the ETC grid shows it. Blank diff = agrees.

| Job | Ledger | App | Diff |
|---|---|---|---|
| 1101 | $8,901 | $8,901 | — |
| 1104 | $1,510 | $4,762 | +$3,252 |
| 1105 | $0 | $0 | — |
| 1106 | $869 | $869 | — |
| 1118 | $6,128 | $6,887 | +$760 |
| 1119 | $2,402 | $2,382 | −$20 |
| 1122 | $18,239 | $18,519 | +$280 |
| 1123 | $0 | $0 | — |
| 1125 | $1,080 | $4,080 | +$3,000 |
| 1127 | $159 | $159 | — |
| 1129 | $12,127 | $12,138 | +$10 |
| 1130 | $280,826 | $280,826 | — |
| 1131 | $11,293 | $12,920 | +$1,626 |
| 1132 | $991 | $991 | — |
| 1133 | $397 | $376 | −$21 |
| 1134 | $389 | $389 | — |
| 1135 | $6,644 | $6,644 | — |
| 1136 | $1,814 | $1,814 | — |
| 1137 | $5,322 | $5,313 | −$9 |
| 1138 | $3,357 | $3,357 | — |
| 1139 | $888 | $888 | — |
| 1140 | $198 | $198 | — |
| 1141 | $1,016 | $1,016 | — |
| 1142 | $177,846 | $178,570 | +$724 |
| 1143 | $5,793 | $7,963 | +$2,170 |
| 1144 | $0 | $0 | — |
| 1145 | $769 | $769 | — |
| 1146 | $4,138 | $4,138 | — |
| 1147 | $4,493 | $4,822 | +$329 |
| **1148** | **$37,516** | **$101,046** | **+$63,530** |
| 1149 | $1,036 | $1,036 | — |
| 1150 | $18,721 | $22,428 | +$3,707 |
| 1153 | $1,744 | $2,095 | +$351 |
| 1154 | $16,864 | $16,864 | — |
| 1156 | $8,264 | $8,264 | — |
| 1157 | $1,881 | $1,881 | — |
| 1158 | $37,000 | $37,915 | +$915 |
| 1159 | $6,141 | $6,179 | +$38 |
| 1160 | $108,768 | $110,362 | +$1,594 |
| 1161 | $26,324 | $26,596 | +$272 |
| 1162 | $32,457 | $32,779 | +$322 |
| **TOTAL** | **$854,306** | **$937,136** | **+$82,830** |

Note the direction: every diff over $100 is **positive** except three trivial negatives
(−$20, −$21, −$9). A one-sided spread like that is the signature of the app simply holding
*more* August activity than a snapshot taken during the month — timing, not error.

---

## 3. Project total spend — −$297,968

Compared like for like: the ledger's purchase journal plus its `Balance Fwd` opening
balances, against the app's full GL-posted AP history.

| | Amount |
|---|---|
| Ledger, purchase journal | $13,792,345 |
| Ledger, `Balance Fwd` opening balances | +$2,040,045 |
| = Ledger, comparable basis | $15,832,390 |
| App, GL-posted AP, all time | $15,587,247 |
| **Residual** | **−$245,143** |
| Non-purchase-journal GL activity (outside the basis) | $52,825 |

**The result is far better than the headline number suggests:**

- **31 of 41 jobs agree within $1,000. 14 agree to the dollar.**
- **Job 1106 alone is −$252,710 of the −$245,143 residual.**
- Excluding 1106, the other 40 jobs net to **+$7,567 on $12.0M — 0.06%.**

The app's stored `Job.costActualHistorical` equals its live TotalETO source on **every**
job, so nothing here is stale data. It is a basis question, not a sync question.

### 3.1 Job 1106 — the one item to escalate

| | Amount |
|---|---|
| Ledger | $3,830,223 |
| App | $3,576,599 |
| Gap | **−$253,624** |

Discounts and credits on this job are recorded fundamentally differently in the two systems.

**A Sage reconciling entry, double-counted.** TotalETO AP carries a line dated
**2025-09-30 for −$180,660.61**, described *"Reconciling with Sage as of 9.30.25."* That
entry exists to true TotalETO **up to** the general ledger. The ledger has already absorbed
the correction, so the app subtracts it a second time. This is $180,661 of the gap, and it
is the clearest single defect found anywhere in this reconciliation.

**Discounts booked in different amounts and different periods.**

| | TotalETO AP | Ledger |
|---|---|---|
| Discount lines | −$337,500 (2025-11-20), −$252,800 (2025-12-23) | −$323,004 (2025-05) |
| Total | −$590,300 | −$323,004 |

Two systems, $267,296 apart, six months apart. Combined with timing shifts elsewhere in the
job's history, that produces the observed net.

For completeness: a **−$675,000** line dated 2026-03-10 ("SOLAR SIMULATOR 6000B-100-002
WITH LED DRIVE") is flagged `DoNotExport` and is correctly excluded from *both* sides.

**This is an accounting-cleanup question on 1106.** It needs the person who posted the Sage
reconciling entry, not a change to the app's formula.

### 3.2 The `Balance Fwd` rows are not a double-count

The ledger's window opens at 2025-04 with $2,040,045 of `Balance Fwd` rows rolling up
everything prior. The app has no such rows — it rebuilds from AP back to inception, showing
$2,214,655 across 2025-01 through 2025-04 for the same jobs. Those two agree to within
$13,530 in aggregate, so the roll-up is a period-alignment artifact and nothing is being
counted twice. Only three jobs carry `Balance Fwd` at all: 1104 ($114,208), 1105 ($517,274),
1106 ($1,408,563).

### 3.3 Per-job, project total

Residual is app minus the comparable ledger basis (`PJ` + `Balance Fwd`). The last column is
GL activity outside that basis, which the app cannot see by construction.

| Job | Ledger `PJ` | `Balance Fwd` | Comparable basis | App AP | Residual | Other journals |
|---|---|---|---|---|---|---|
| 1101 | $731,689 | $0 | $731,689 | $729,613 | −$2,076 | $9,963 |
| 1104 | $649,950 | $114,208 | $764,157 | $767,952 | +$3,795 | $12,129 |
| 1105 | $31,689 | $517,274 | $548,963 | $550,362 | +$1,399 | $5,006 |
| **1106** | **$2,420,746** | **$1,408,563** | **$3,829,310** | **$3,576,599** | **−$252,710** | $914 |
| 1118 | $506,395 | $0 | $506,395 | $506,925 | +$530 | $7,716 |
| 1119 | $125,219 | $0 | $125,219 | $125,199 | −$20 | $2,576 |
| 1122 | $375,732 | $0 | $375,732 | $367,682 | −$8,050 | $14,128 |
| 1123 | $57,806 | $0 | $57,806 | $57,806 | — | $2,199 |
| 1125 | $151,245 | $0 | $151,245 | $151,245 | — | $930 |
| 1127 | $98,222 | $0 | $98,222 | $98,226 | +$5 | $1,223 |
| 1129 | $170,147 | $0 | $170,147 | $170,157 | +$10 | $2,278 |
| 1130 | $2,141,801 | $0 | $2,141,801 | $2,141,794 | −$6 | $3,573 |
| 1131 | $199,341 | $0 | $199,341 | $200,553 | +$1,212 | $693 |
| 1132 | $1,007 | $0 | $1,007 | $1,007 | — | — |
| 1133 | $50,504 | $0 | $50,504 | $50,484 | −$20 | $63 |
| 1134 | $47,722 | $0 | $47,722 | $47,722 | — | — |
| 1135 | $185,893 | $0 | $185,893 | $185,879 | −$14 | $1,023 |
| 1136 | $45,679 | $0 | $45,679 | $45,316 | −$363 | — |
| 1137 | $59,322 | $0 | $59,322 | $59,289 | −$33 | $689 |
| 1138 | $18,428 | $0 | $18,428 | $18,428 | — | $88 |
| 1139 | $37,001 | $0 | $37,001 | $36,331 | −$670 | $1,329 |
| 1140 | $14,445 | $0 | $14,445 | $14,445 | — | $2,702 |
| 1141 | $34,392 | $0 | $34,392 | $34,392 | — | — |
| 1142 | $1,540,344 | $0 | $1,540,344 | $1,542,826 | +$2,482 | $931 |
| 1143 | $1,119,403 | $0 | $1,119,403 | $1,121,450 | +$2,048 | — |
| 1144 | $32,297 | $0 | $32,297 | $32,297 | — | $598 |
| 1145 | $133,951 | $0 | $133,951 | $133,961 | +$10 | $1,769 |
| 1146 | $131,776 | $0 | $131,776 | $131,723 | −$52 | $109 |
| 1147 | $268,757 | $0 | $268,757 | $269,033 | +$277 | $906 |
| 1148 | $1,204,529 | $0 | $1,204,529 | $1,204,478 | −$51 | **−$29,713** |
| 1149 | $23,954 | $0 | $23,954 | $23,954 | — | — |
| 1150 | $95,967 | $0 | $95,967 | $99,656 | +$3,689 | $3,441 |
| 1153 | $33,159 | $0 | $33,159 | $33,507 | +$348 | $625 |
| 1154 | $19,357 | $0 | $19,357 | $19,357 | — | $796 |
| 1156 | $19,250 | $0 | $19,250 | $19,250 | — | $413 |
| 1157 | $770,027 | $0 | $770,027 | $770,027 | — | $76 |
| 1158 | $37,000 | $0 | $37,000 | $37,915 | +$915 | — |
| 1159 | $6,141 | $0 | $6,141 | $6,179 | +$38 | — |
| 1160 | $123,136 | $0 | $123,136 | $124,730 | +$1,594 | $3,059 |
| 1161 | $45,806 | $0 | $45,806 | $46,055 | +$249 | — |
| 1162 | $33,121 | $0 | $33,121 | $33,443 | +$322 | $594 |
| **TOTAL** | **$13,792,345** | **$2,040,045** | **$15,832,390** | **$15,587,247** | **−$245,143** | **$52,825** |

---

## 4. Recommendation

**One structural gap is worth a decision.** A refund or credit booked outside the purchase
journal — `CRJ`, `SJ`, `GENJ` — never reaches the app, because every parts-cost measure in
`sync-totaleto.ts` reads the AP tables. Job 1148 makes that a $31,765 error in a single
month, and it is $52,825 across the full history of these 41 jobs. Whether Money Spent Month
and Parts Actual should pick up non-AP journal activity is a business call about what the
measure means, not a bug to fix in passing.

**One job needs accounting, not engineering.** Job 1106's Sage reconciling entry of
−$180,660.61 is being applied twice — once in the ledger it was written to correct, once
again by the app reading it out of TotalETO AP. Someone who knows why that entry was posted
should decide how both systems ought to treat it.

**Two components need no action.** The $36,049 of `DoNotExport` lines and the $16,345 of
late postings are both already-understood, already-documented behavior.

---

## 5. Notes on the workbook template

### 5.1 Every transaction appears twice

`Job Ledger Processed` holds 28,123 rows: 14,824 tagged `Export Group = Current Month` and
13,299 tagged `Previous Month`. The same transactions are in both. The pivots are correct
only because they filter on `Export Group`; aggregating the sheet without that filter yields
**$30,960,390** — almost exactly double the true $15,885,215.

Worth a header note on the sheet, because the trap is invisible and the wrong answer looks
plausible.

### 5.2 The grand totals are not comparable

The app tracks a wider job set than this ledger: completed jobs, service jobs (`8000xxx`),
and overhead buckets such as `99999`. Its unrestricted August total is **$1,078,736** against
the ledger's **$854,306** — a $224,430 spread that is entirely job population, not
disagreement.

**Every comparison in this document is job by job, restricted to the 41 jobs the ledger
covers.** A total is only a total of something.

---

## 6. Reproducing this

The reference extract is deterministic from the workbook:

- Filter `Job Ledger Processed` to `Export Group = "Current Month"` and
  `Is Non-Shipping Revenue = FALSE`
- Sum `Net DR/CR`, grouped by `Job ID`, and by `Trx Year-Month` for the monthly view
- Validate against the two pivot grand totals before using it — if either fails, the
  extract is wrong, not the pivot

The app side comes from `getPartsCostBookedByJob(monthWindowUtc("2026-08"))` and
`getPartsActualByJob()`. `scripts/parts-actual-recon.ts` and
`scripts/parts-cost-projection-audit.ts` cover the same ground for other periods; the
ad-hoc scripts written for this pass were not kept, since the extract above is the only
input they needed.

## Related

- `DEVLOG.md` §25 — Money Spent Month reconciled to the July 2026 Total ETO pivot, which is
  where the $420,655.50 cross-check in [§1](#1-method) comes from
- `src/lib/sync-totaleto.ts` — the `DoNotExport` and Extra Costs scope rules, with their
  reasoning
