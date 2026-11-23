"""Command line: `python -m inventory crawl <root>` and `python -m inventory status`."""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone

from . import crawler, db


def _when(seconds: int | None) -> str:
    if seconds is None:
        return "-"
    return datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%d")


def _size(n: int | None) -> str:
    value = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:,.1f} {unit}"
        value /= 1024
    return ""


def cmd_crawl(args: argparse.Namespace) -> int:
    conn = db.connect(args.db)
    started = time.monotonic()
    last = [started]

    def progress(stats: crawler.Stats) -> None:
        now = time.monotonic()
        if now - last[0] < 5:
            return
        last[0] = now
        pending = conn.execute("SELECT COUNT(*) FROM dir WHERE status = 'pending'").fetchone()[0]
        elapsed = now - started
        print(
            f"[{elapsed:6.0f}s] {stats.dirs_done:,} dirs, {stats.files:,} files "
            f"({stats.files / elapsed:,.0f}/s), {pending:,} queued, "
            f"{stats.denied} denied, {stats.errors} errors, {stats.outages} outages",
            flush=True,
        )

    print(f"Database: {args.db}")
    print(f"Root:     {crawler.normalize_root(args.root)}", flush=True)
    try:
        stats = crawler.crawl(
            conn,
            args.root,
            workers=args.workers,
            rescan=args.rescan,
            limit_dirs=args.limit_dirs,
            max_outage_seconds=args.max_outage_minutes * 60,
            progress=progress,
        )
    except KeyboardInterrupt:
        print("\nInterrupted. Run the same command again to carry on.")
        return 130

    elapsed = time.monotonic() - started
    print(
        f"This run: {stats.dirs_done:,} dirs, {stats.files:,} files in {elapsed:,.0f}s; "
        f"{stats.denied} denied, {stats.missing} missing, {stats.errors} errors, "
        f"{stats.outages} outages"
    )
    if stats.stopped:
        print(f"Stopped early: {stats.stopped}. Run the same command again to carry on.")
        return 2
    print("Queue empty: crawl complete.")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    conn = db.connect(args.db)
    roots = conn.execute("SELECT id, path FROM root ORDER BY path").fetchall()
    if not roots:
        print("Nothing crawled yet.")
        return 0
    for root in roots:
        print(root["path"])
        counts = {
            r["status"]: r["n"]
            for r in conn.execute(
                "SELECT status, COUNT(*) AS n FROM dir WHERE root_id = ? GROUP BY status",
                (root["id"],),
            )
        }
        print("  directories: " + ", ".join(f"{n:,} {s}" for s, n in sorted(counts.items())))
        totals = conn.execute(
            "SELECT COUNT(*) AS n, SUM(f.size) AS bytes, MIN(f.mtime) AS oldest, MAX(f.mtime) AS newest "
            "FROM file f JOIN dir d ON d.id = f.dir_id WHERE d.root_id = ?",
            (root["id"],),
        ).fetchone()
        print(
            f"  files: {totals['n']:,} ({_size(totals['bytes'])}), "
            f"modified {_when(totals['oldest'])} to {_when(totals['newest'])}"
        )
        print("  top extensions:")
        for r in conn.execute(
            "SELECT f.ext, COUNT(*) AS n, SUM(f.size) AS bytes FROM file f "
            "JOIN dir d ON d.id = f.dir_id WHERE d.root_id = ? "
            "GROUP BY f.ext ORDER BY n DESC LIMIT ?",
            (root["id"], args.top),
        ):
            print(f"    {r['ext'] or '(none)':<12} {r['n']:>10,}  {_size(r['bytes']):>12}")
    return 0


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(prog="inventory", description=__doc__)
    parser.add_argument("--db", default=str(db.default_db_path()), help="inventory database file")
    sub = parser.add_subparsers(dest="command", required=True)

    c = sub.add_parser("crawl", help="crawl a tree, or carry on an interrupted crawl of it")
    c.add_argument("root")
    c.add_argument("--workers", type=int, default=8, help="directories read at once (default 8)")
    c.add_argument("--rescan", action="store_true", help="re-read every directory already known")
    c.add_argument("--limit-dirs", type=int, help="stop after this many directories")
    c.add_argument(
        "--max-outage-minutes",
        type=float,
        default=30,
        help="how long to wait for a dropped connection before stopping (default 30)",
    )
    c.set_defaults(func=cmd_crawl)

    s = sub.add_parser("status", help="what has been crawled so far")
    s.add_argument("--top", type=int, default=15, help="extensions to list (default 15)")
    s.set_defaults(func=cmd_status)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
