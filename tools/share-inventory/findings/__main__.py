"""Command line: `python -m findings scan` flags sensitive-looking names in the inventory."""

from __future__ import annotations

import argparse
import sqlite3
import sys
from collections import Counter
from pathlib import Path

from inventory import db

from . import acl, scan
from .rules import HIGH, LOW, MEDIUM, SEVERITY_ORDER


def cmd_scan(args: argparse.Namespace) -> int:
    conn = sqlite3.connect(f"file:{Path(args.db).as_posix()}?mode=ro", uri=True)
    try:
        findings = scan.scan(conn)
    finally:
        conn.close()
    findings = [f for f in findings if SEVERITY_ORDER[f["severity"]] <= SEVERITY_ORDER[args.min_severity]]

    if args.acl:
        read, failed = acl.annotate(findings, limit=args.acl_limit)
        print(f"Permissions read for {read:,} folders ({failed:,} could not be read, limit {args.acl_limit:,}).")

    out = Path(args.out) if args.out else Path(args.db).parent / "reports" / "findings.csv"
    scan.write_report(findings, out)

    print(f"{len(findings):,} findings. These are names that deserve a look, not confirmed exposures.\n")
    by = Counter((f["category"], f["severity"]) for f in findings)
    print(f"  {'category':<18}{HIGH:>7}{MEDIUM:>8}{LOW:>7}")
    for category in sorted({c for c, _ in by}):
        print(f"  {category:<18}{by[category, HIGH]:>7}{by[category, MEDIUM]:>8}{by[category, LOW]:>7}")
    print()
    shares = Counter(f["share"] for f in findings)
    high = Counter(f["share"] for f in findings if f["severity"] == HIGH)
    print(f"  {'share':<26}{'all':>7}{HIGH:>7}")
    for share, n in shares.most_common():
        print(f"  {share:<26}{n:>7}{high[share]:>7}")
    print()
    rules = Counter((f["severity"], f["rule"]) for f in findings)
    print("  by rule:")
    for (severity, rule), n in sorted(rules.items(), key=lambda kv: (SEVERITY_ORDER[kv[0][0]], -kv[1])):
        print(f"    {severity:<7} {rule:<26}{n:>6}")
    if args.acl:
        broad = sum(1 for f in findings if f["broad_access"])
        print(f"\n  {broad:,} findings are readable by a group that means nearly everyone.")
    print(f"\nReport: {out}")
    return 0


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(prog="findings", description=__doc__)
    parser.add_argument("--db", default=str(db.default_db_path()), help="inventory database file")
    sub = parser.add_subparsers(dest="command", required=True)

    s = sub.add_parser("scan", help="flag sensitive-looking file and folder names")
    s.add_argument("--out", help="CSV to write (default: reports/findings.csv beside the database)")
    s.add_argument("--min-severity", choices=[HIGH, MEDIUM, LOW], default=LOW, help="leave out anything milder")
    s.add_argument("--acl", action="store_true", help="also ask Windows who can read each flagged folder (needs the shares)")
    s.add_argument("--acl-limit", type=int, default=300, help="most folders to ask about (default 300)")
    s.set_defaults(func=cmd_scan)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
