"""Read job numbers, customers and descriptions out of job folder names.

Everything here produces candidates for a person to confirm, so each customer
carries how it was arrived at:

- `delimited`: the name spells it out, as in `1151_Acme_Widget Assembler`.
- `known`: the name starts with a customer already seen in delimited form,
  as in `512 Acme Widget Spares` or `1145_Acme, Widget Loader`.
- `inferred`: the leading word or words recur across several folders, as in
  the older `430 Globex Drive Upgrade` style, where nothing marks the boundary.

Names that fit none of these keep `customer = None` and are listed for review.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass

_TEMPLATE = re.compile(r"\bTEMPLATE\b", re.I)
_BUCKET = re.compile(r"^(?P<year>20\d\d)[ _]+(?P<rest>(?:spares|service|parts cost)\b.*)$", re.I)
_PLACEHOLDER = re.compile(r"^x{3,4}[ _]*(?:(?P<num>\d{3,4})(?!\d))?[ _]*(?P<rest>.*)$", re.I)
_NUMBERED = re.compile(r"^(?P<num>\d{3,4})(?P<suffix>[A-Za-z])?(?![0-9A-Za-z])[ _-]*(?P<rest>.*)$")
_QUANTITY = (
    re.compile(r"\bqty\.?\s*\(?\s*(\d+)\s*\)?", re.I),
    re.compile(r"\(\s*x\s*(\d+)\s*\)", re.I),
    re.compile(r"\bx\s*(\d+)\s*$", re.I),
)


@dataclass
class JobName:
    raw: str
    kind: str  # job | bucket | placeholder | template | other
    number: int | None = None
    customer: str | None = None
    customer_source: str | None = None  # delimited | known | inferred
    description: str = ""
    quantity: int | None = None


def customer_key(name: str) -> str:
    """Spelling-insensitive identity: `ACME ELECTRIC` and `Acme-Electric` share one."""
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def _quantity(text: str) -> int | None:
    for pattern in _QUANTITY:
        found = pattern.search(text)
        if found:
            return int(found.group(1))
    return None


def _split_delimited(rest: str) -> tuple[str | None, str]:
    if "_" in rest:
        customer, description = (part.strip() for part in rest.split("_", 1))
        if customer and description:
            return customer, description.strip("_ ")
    return None, rest.strip()


def parse(name: str) -> JobName:
    """Classify one folder name. Customers that need context are left for `resolve_customers`."""
    raw = name
    name = name.strip()
    if _TEMPLATE.search(name):
        return JobName(raw, "template", description=name)

    bucket = _BUCKET.match(name)
    if bucket:
        return JobName(raw, "bucket", number=int(bucket["year"]), description=bucket["rest"].strip())

    placeholder = _PLACEHOLDER.match(name)
    if placeholder:
        kind, number, rest = "placeholder", placeholder["num"], placeholder["rest"]
    else:
        numbered = _NUMBERED.match(name)
        if not numbered:
            return JobName(raw, "other", description=name)
        kind, number, rest = "job", numbered["num"], numbered["rest"]

    customer, description = _split_delimited(rest)
    return JobName(
        raw,
        kind,
        number=int(number) if number else None,
        customer=customer,
        customer_source="delimited" if customer else None,
        description=description,
        quantity=_quantity(rest),
    )


def _starts_with_words(text: str, prefix: str) -> bool:
    if not text.lower().startswith(prefix.lower()):
        return False
    following = text[len(prefix) : len(prefix) + 1]
    return not following.isalnum()


def _strip_customer(text: str, length: int) -> str:
    return text[length:].lstrip(" ,_-")


def resolve_customers(jobs: list[JobName], *, min_repeats: int = 2) -> None:
    """Fill in customers that only make sense with the other names in view."""
    spellings: dict[str, Counter[str]] = defaultdict(Counter)
    for job in jobs:
        if job.customer:
            spellings[customer_key(job.customer)][job.customer] += 1
    known = sorted((c.most_common(1)[0][0] for c in spellings.values()), key=len, reverse=True)

    unresolved = [j for j in jobs if j.kind in ("job", "placeholder") and not j.customer and j.description]
    for job in unresolved:
        for customer in known:
            if _starts_with_words(job.description, customer):
                rest = _strip_customer(job.description, len(customer))
                if rest:
                    job.customer, job.customer_source, job.description = customer, "known", rest
                break

    # What is left has no delimiter. A leading word that recurs is taken as a
    # customer; a second word joins it when it nearly always follows.
    unresolved = [j for j in unresolved if not j.customer]
    first: Counter[str] = Counter()
    pair: Counter[tuple[str, str]] = Counter()
    for job in unresolved:
        words = job.description.split()
        if len(words) >= 2:
            first[words[0].lower()] += 1
        if len(words) >= 3:
            pair[(words[0].lower(), words[1].lower())] += 1
    for job in unresolved:
        words = job.description.split()
        if len(words) < 2 or first[words[0].lower()] < min_repeats:
            continue
        take = 1
        if len(words) >= 3:
            together = pair[(words[0].lower(), words[1].lower())]
            if together >= min_repeats and together >= 0.8 * first[words[0].lower()]:
                take = 2
        job.customer = " ".join(words[:take])
        job.customer_source = "inferred"
        job.description = " ".join(words[take:])


_WORD = re.compile(r"[A-Za-z][A-Za-z0-9&'-]*")
_FILLER = frozenset("a an and as at by for from in into of on or the to with".split())


def description_terms(jobs: list[JobName]) -> list[dict]:
    """Words and word pairs used in job descriptions, with the job numbers they span."""
    seen: dict[tuple[str, ...], dict] = {}
    for job in jobs:
        if job.kind != "job" or job.number is None:
            continue
        words = _WORD.findall(job.description)
        grams = [(w,) for w in words] + list(zip(words, words[1:]))
        for key, spelled in {tuple(w.lower() for w in g): g for g in grams}.items():
            if len(key) == 1 and (len(key[0]) < 2 or key[0] in _FILLER):
                continue
            if key[0] in _FILLER or key[-1] in _FILLER:
                continue  # a pair that starts or ends on a filler word is not a term
            entry = seen.setdefault(
                key, {"spellings": Counter(), "jobs": 0, "first_job": job.number, "last_job": job.number}
            )
            entry["spellings"][" ".join(spelled)] += 1
            entry["jobs"] += 1
            entry["first_job"] = min(entry["first_job"], job.number)
            entry["last_job"] = max(entry["last_job"], job.number)
    terms = [
        {
            "term": entry["spellings"].most_common(1)[0][0],
            "words": len(key),
            "jobs": entry["jobs"],
            "first_job": entry["first_job"],
            "last_job": entry["last_job"],
        }
        for key, entry in seen.items()
    ]
    terms.sort(key=lambda t: (-t["jobs"], t["term"].lower()))
    return terms
