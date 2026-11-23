"""Command line: `python -m mining jobs` reads the inventory and writes CSV reports."""

from __future__ import annotations

import argparse
import sqlite3
import sys
from collections import Counter
from pathlib import Path

from inventory import db

from . import jobs


def cmd_jobs(args: argparse.Namespace) -> int:
    conn = sqlite3.connect(f"file:{Path(args.db).as_posix()}?mode=ro", uri=True)
    try:
        result = jobs.analyse(conn, args.root)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()

    out_dir = Path(args.out) if args.out else Path(args.db).parent / "reports"
    written = jobs.write_reports(result, out_dir)

    rows = result["jobs"]
    kinds = Counter(j["kind"] for j in rows)
    numbered = [j for j in rows if j["kind"] == "job"]
    sources = Counter(j["customer_source"] or "unresolved" for j in numbered)
    pending = result["dir_statuses"].get("pending", 0)

    print(result["root"])
    if pending:
        print(f"  NOTE: crawl incomplete, {pending:,} directories still queued; totals will grow")
    print("  top-level folders: " + ", ".join(f"{n} {k}" for k, n in kinds.most_common()))
    if numbered:
        print(f"  job numbers: {numbered[0]['number']} to {numbered[-1]['number']}")
    print("  customer found by: " + ", ".join(f"{n} {s}" for s, n in sources.most_common()))
    print(f"  distinct customers: {len(result['customers'])}")
    print(f"  files: {sum(j['files'] for j in rows):,}, {sum(j['gb'] for j in rows):,.0f} GB")

    print("\n  top customers (folders, job range):")
    for c in result["customers"][: args.top]:
        print(f"    {c['customer']:<28} {c['folders']:>4}   {c['first_job']}-{c['last_job']}")
    print("\n  most common job sub-folders (jobs, job range):")
    for f in result["folders"][: args.top]:
        print(f"    {f['folder']:<36} {f['jobs']:>4}   {f['first_job']}-{f['last_job']}")
    print("\n  most common description terms (jobs, job range):")
    for t in [t for t in result["terms"] if t["words"] == 1][: args.top]:
        print(f"    {t['term']:<20} {t['jobs']:>4}   {t['first_job']}-{t['last_job']}")

    print("\nReports:")
    for path in written:
        print(f"  {path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(prog="mining", description=__doc__)
    parser.add_argument("--db", default=str(db.default_db_path()), help="inventory database file")
    sub = parser.add_subparsers(dest="command", required=True)

    j = sub.add_parser("jobs", help="jobs, customers and folder conventions of a job share")
    j.add_argument("--root", help="crawled root to analyse (needed if more than one is crawled)")
    j.add_argument("--out", help="folder for the CSV reports (default: 'reports' beside the database)")
    j.add_argument("--top", type=int, default=20, help="rows to print per list (default 20)")
    j.set_defaults(func=cmd_jobs)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
