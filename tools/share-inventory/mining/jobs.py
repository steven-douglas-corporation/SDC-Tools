"""Roll a crawled job share up into jobs, customers and folder conventions.

Reads the inventory database only. Each top-level folder of the root is one
row: what its name says (job number, customer, description) and what its
contents say (size, when it was active, how it is laid out inside).
"""

from __future__ import annotations

import csv
import difflib
import re
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from . import names

# A job's own number, or the template's XXXX, in front of a sub-folder name.
_FOLDER_PREFIX = re.compile(r"^\s*(?:\d{3,4}[A-Za-z]?|x{3,4})(?![0-9A-Za-z])[ _-]*", re.I)


def _date(seconds: int | None) -> str:
    if seconds is None:
        return ""
    try:
        return datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%d")
    except (OverflowError, OSError, ValueError):
        return ""


def folder_label(name: str) -> str:
    """`1151 Mechanical` and `XXXX Mechanical` are the same folder: `Mechanical`."""
    return _FOLDER_PREFIX.sub("", name).strip() or name.strip()


def _active_from(by_year: Counter[int], share: float = 0.05) -> int | None:
    """The first year by which `share` of the files existed.

    The oldest file in a job is usually a vendor download or a part copied in
    from an earlier job, so the minimum on its own says little.
    """
    total = sum(by_year.values())
    running = 0
    for year in sorted(by_year):
        running += by_year[year]
        if running >= share * total:
            return year
    return None


def analyse(conn: sqlite3.Connection, root: str | None = None) -> dict:
    conn.row_factory = sqlite3.Row
    if root is None:
        roots = conn.execute("SELECT id, path FROM root").fetchall()
        if len(roots) != 1:
            raise ValueError("more than one root is crawled; say which with --root")
        root_row = roots[0]
    else:
        root_row = conn.execute("SELECT id, path FROM root WHERE path = ?", (root,)).fetchone()
        if root_row is None:
            raise ValueError(f"not crawled: {root}")
    root_id = root_row["id"]

    # Each directory's top-level ancestor, parents before children.
    top_of: dict[int, int] = {}
    top_name: dict[int, str] = {}
    children: dict[int, list[str]] = defaultdict(list)
    unfinished: Counter[int] = Counter()
    statuses: Counter[str] = Counter()
    for row in conn.execute(
        "SELECT id, parent_id, depth, name, status FROM dir WHERE root_id = ? AND depth >= 1 ORDER BY depth",
        (root_id,),
    ):
        statuses[row["status"]] += 1
        if row["depth"] == 1:
            top_of[row["id"]] = row["id"]
            top_name[row["id"]] = row["name"]
        else:
            top = top_of.get(row["parent_id"])
            if top is None:
                continue
            top_of[row["id"]] = top
            if row["depth"] == 2:
                children[top].append(row["name"])
        if row["status"] in ("pending", "error"):
            unfinished[top_of[row["id"]]] += 1

    totals: dict[int, dict] = defaultdict(
        lambda: {"files": 0, "bytes": 0, "last": None, "oldest": None, "years": Counter(), "copied": 0}
    )
    for row in conn.execute(
        "SELECT f.dir_id, CAST(strftime('%Y', f.mtime, 'unixepoch') AS INTEGER) AS year, "
        "COUNT(*) AS n, SUM(f.size) AS bytes, MIN(f.mtime) AS oldest, MAX(f.mtime) AS newest, "
        "SUM(f.ctime > f.mtime + 60) AS copied "
        "FROM file f JOIN dir d ON d.id = f.dir_id WHERE d.root_id = ? GROUP BY f.dir_id, year",
        (root_id,),
    ):
        top = top_of.get(row["dir_id"])
        if top is None:
            continue
        t = totals[top]
        t["files"] += row["n"]
        t["bytes"] += row["bytes"] or 0
        t["copied"] += row["copied"] or 0
        if row["year"] is not None:
            t["years"][row["year"]] += row["n"]
        if row["newest"] is not None and (t["last"] is None or row["newest"] > t["last"]):
            t["last"] = row["newest"]
        if row["oldest"] is not None and (t["oldest"] is None or row["oldest"] < t["oldest"]):
            t["oldest"] = row["oldest"]

    parsed = {top: names.parse(name) for top, name in top_name.items()}
    names.resolve_customers(list(parsed.values()))

    jobs = []
    for top, job in parsed.items():
        t = totals[top]
        jobs.append(
            {
                "folder": job.raw,
                "kind": job.kind,
                "number": job.number,
                "customer": job.customer or "",
                "customer_source": job.customer_source or "",
                "description": job.description,
                "quantity": job.quantity or "",
                "files": t["files"],
                "gb": round(t["bytes"] / 1024**3, 2),
                "active_from": _active_from(t["years"]) or "",
                "last_modified": _date(t["last"]),
                "oldest_file": _date(t["oldest"]),
                "copied_files": t["copied"],
                "subfolders": len(children[top]),
                "unfinished_dirs": unfinished[top],
            }
        )
    jobs.sort(key=lambda j: (j["kind"] != "job", j["number"] if j["number"] is not None else 10**9, j["folder"].lower()))

    return {
        "root": root_row["path"],
        "dir_statuses": dict(statuses),
        "jobs": jobs,
        "customers": _customers(jobs),
        "folders": _folder_vocabulary(parsed, children, totals),
        "terms": names.description_terms(list(parsed.values())),
    }


def _customers(jobs: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for job in jobs:
        if job["customer"]:
            groups[names.customer_key(job["customer"])].append(job)

    customers = []
    for key, members in groups.items():
        spellings = Counter(j["customer"] for j in members)
        numbers = [j["number"] for j in members if j["kind"] == "job" and j["number"] is not None]
        years_from = [j["active_from"] for j in members if j["active_from"]]
        last = max((j["last_modified"] for j in members if j["last_modified"]), default="")
        customers.append(
            {
                "customer": spellings.most_common(1)[0][0],
                "key": key,
                "folders": len(members),
                "first_job": min(numbers, default=""),
                "last_job": max(numbers, default=""),
                "active_from": min(years_from, default=""),
                "last_modified": last,
                "how_identified": ", ".join(sorted({j["customer_source"] for j in members})),
                "other_spellings": "; ".join(s for s, _ in spellings.most_common()[1:]),
                "possible_parent": "",
                "similar_to": "",
            }
        )

    by_name = sorted(customers, key=lambda c: len(c["customer"]), reverse=True)
    all_keys = [c["key"] for c in customers]
    name_of = {c["key"]: c["customer"] for c in customers}
    for customer in customers:
        # `Acme Mexico` under `Acme`: a site or division, for a person to judge.
        for other in by_name:
            if other is not customer and customer["customer"].lower().startswith(other["customer"].lower() + " "):
                customer["possible_parent"] = other["customer"]
                break
        # Near-identical spellings that are probably one customer.
        close = difflib.get_close_matches(customer["key"], all_keys, n=4, cutoff=0.85)
        customer["similar_to"] = "; ".join(name_of[k] for k in close if k != customer["key"])
    customers.sort(key=lambda c: (-c["folders"], c["customer"].lower()))
    for customer in customers:
        del customer["key"]
    return customers


def _folder_vocabulary(parsed: dict, children: dict, totals: dict) -> list[dict]:
    """Which sub-folder names job folders use, and over what span of jobs."""
    seen: dict[str, dict] = {}
    for top, job in parsed.items():
        if job.kind != "job" or job.number is None:
            continue
        for label in {folder_label(child) for child in children[top]}:
            entry = seen.setdefault(
                label.lower(),
                {"spellings": Counter(), "jobs": 0, "first_job": job.number, "last_job": job.number},
            )
            entry["spellings"][label] += 1
            entry["jobs"] += 1
            entry["first_job"] = min(entry["first_job"], job.number)
            entry["last_job"] = max(entry["last_job"], job.number)
    folders = [
        {
            "folder": entry["spellings"].most_common(1)[0][0],
            "jobs": entry["jobs"],
            "first_job": entry["first_job"],
            "last_job": entry["last_job"],
        }
        for entry in seen.values()
    ]
    folders.sort(key=lambda f: (-f["jobs"], f["folder"].lower()))
    return folders


def write_reports(result: dict, out_dir: Path, *, min_term_jobs: int = 3) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    tables = {
        "jobs.csv": result["jobs"],
        "customers.csv": result["customers"],
        "job_subfolders.csv": result["folders"],
        "description_terms.csv": [t for t in result["terms"] if t["jobs"] >= min_term_jobs],
    }
    written = []
    for filename, rows in tables.items():
        path = out_dir / filename
        with open(path, "w", newline="", encoding="utf-8-sig") as handle:
            if rows:
                writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
                writer.writeheader()
                writer.writerows(rows)
        written.append(path)
    return written
