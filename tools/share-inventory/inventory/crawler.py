"""Resumable, metadata-only crawl of a directory tree.

Nothing is opened: every value recorded comes from the directory listing
itself. On Windows that listing already carries size, timestamps and
attributes, so a directory costs one round trip however many files it holds.

The crawl is a queue of directories kept in the database. Each directory is
read in full, then written and marked `done` in one transaction, so stopping at
any point (Ctrl+C, a dropped VPN) loses at most the batch in flight and the
next run carries on from the queue.
"""

from __future__ import annotations

import os
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

IS_WINDOWS = os.name == "nt"
SEP = "\\" if IS_WINDOWS else "/"
FILE_ATTRIBUTE_DIRECTORY = 0x10

# Windows error codes that mean "this path is gone", as opposed to "the
# network is gone" (53, 64, 67 and friends, some of which Python also raises
# as FileNotFoundError).
_WINERROR_NOT_FOUND = {2, 3}


def normalize_root(path: str) -> str:
    return os.path.normpath(os.path.abspath(path))


def extended(path: str) -> str:
    """The long-path form of a Windows path, so paths over 260 characters work."""
    if not IS_WINDOWS or path.startswith("\\\\?\\"):
        return path
    if path.startswith("\\\\"):
        return "\\\\?\\UNC\\" + path[2:]
    return "\\\\?\\" + path


def join(parent: str, name: str) -> str:
    return parent + name if parent.endswith(SEP) else parent + SEP + name


@dataclass
class Listing:
    # (name, ext, size, mtime, ctime, atime, attributes)
    files: list[tuple] = field(default_factory=list)
    # (name, mtime, ctime, attributes, skip_reason or None)
    dirs: list[tuple] = field(default_factory=list)


def _seconds(value: float | None) -> int | None:
    return None if value is None else int(value)


def scan_dir(path: str) -> Listing:
    """Read one directory. Raises OSError (PermissionError when access is denied)."""
    listing = Listing()
    with os.scandir(extended(path)) as entries:
        for entry in entries:
            try:
                st = entry.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue  # removed between the listing and the stat
            attributes = getattr(st, "st_file_attributes", 0)
            created = _seconds(getattr(st, "st_birthtime", st.st_ctime))
            modified = _seconds(st.st_mtime)
            is_link = entry.is_symlink() or entry.is_junction()
            is_dir = entry.is_dir(follow_symlinks=False) or bool(
                is_link and attributes & FILE_ATTRIBUTE_DIRECTORY
            )
            if is_dir:
                # Links are recorded but never followed: they can loop, and
                # their target is counted where it really lives.
                reason = "link (symlink or junction), not followed" if is_link else None
                listing.dirs.append((entry.name, modified, created, attributes, reason))
            else:
                listing.files.append(
                    (
                        entry.name,
                        os.path.splitext(entry.name)[1].lower(),
                        st.st_size,
                        modified,
                        created,
                        _seconds(st.st_atime),
                        attributes,
                    )
                )
    return listing


@dataclass
class Stats:
    dirs_done: int = 0
    files: int = 0
    denied: int = 0
    missing: int = 0
    errors: int = 0
    outages: int = 0
    stopped: str | None = None  # None when the queue was emptied


def _is_not_found(exc: OSError) -> bool:
    winerror = getattr(exc, "winerror", None)
    if winerror is not None:
        return winerror in _WINERROR_NOT_FOUND
    return isinstance(exc, (FileNotFoundError, NotADirectoryError))


def _ensure_root(conn: sqlite3.Connection, root: str) -> int:
    now = int(time.time())
    with conn:
        conn.execute("INSERT OR IGNORE INTO root (path, added_at) VALUES (?, ?)", (root, now))
        root_id = conn.execute("SELECT id FROM root WHERE path = ?", (root,)).fetchone()["id"]
        conn.execute(
            "INSERT OR IGNORE INTO dir (root_id, parent_id, path, name, depth) "
            "VALUES (?, NULL, ?, ?, 0)",
            (root_id, root, os.path.basename(root) or root),
        )
    return root_id


def _write_listing(conn: sqlite3.Connection, root_id: int, row: sqlite3.Row, listing: Listing) -> None:
    dir_id, path, depth = row["id"], row["path"], row["depth"]
    conn.execute("DELETE FROM file WHERE dir_id = ?", (dir_id,))
    conn.executemany(
        "INSERT OR REPLACE INTO file (dir_id, name, ext, size, mtime, ctime, atime, attributes) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [(dir_id, *f) for f in listing.files],
    )
    conn.executemany(
        "INSERT INTO dir (root_id, parent_id, path, name, depth, mtime, ctime, attributes, status, error) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (path) DO UPDATE SET "
        "mtime = excluded.mtime, ctime = excluded.ctime, attributes = excluded.attributes",
        [
            (
                root_id,
                dir_id,
                join(path, name),
                name,
                depth + 1,
                mtime,
                ctime,
                attributes,
                "skipped" if reason else "pending",
                reason,
            )
            for name, mtime, ctime, attributes, reason in listing.dirs
        ],
    )
    conn.execute(
        "UPDATE dir SET status = 'done', error = NULL, scanned_at = ? WHERE id = ?",
        (int(time.time()), dir_id),
    )


def _mark(conn: sqlite3.Connection, dir_id: int, status: str, exc: BaseException) -> None:
    conn.execute(
        "UPDATE dir SET status = ?, error = ?, scanned_at = ? WHERE id = ?",
        (status, f"{type(exc).__name__}: {exc}", int(time.time()), dir_id),
    )


def crawl(
    conn: sqlite3.Connection,
    root: str,
    *,
    workers: int = 8,
    rescan: bool = False,
    limit_dirs: int | None = None,
    max_outage_seconds: float = 1800,
    outage_poll_seconds: float = 15,
    scan: Callable[[str], Listing] = scan_dir,
    reachable: Callable[[], bool] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    progress: Callable[[Stats], None] | None = None,
) -> Stats:
    """Crawl `root`, or carry on a crawl of it that was interrupted.

    `rescan` puts every known directory back on the queue. `limit_dirs` stops
    after that many directories, leaving the rest queued.
    """
    root = normalize_root(root)
    if reachable is None:
        reachable = lambda: os.path.isdir(extended(root))  # noqa: E731

    stats = Stats()

    def wait_for_root() -> bool:
        stats.outages += 1
        waited = 0.0
        while waited < max_outage_seconds:
            sleep(outage_poll_seconds)
            waited += outage_poll_seconds
            if reachable():
                return True
        return False

    if not reachable() and not wait_for_root():
        stats.stopped = "root unreachable"
        return stats

    root_id = _ensure_root(conn, root)
    if rescan:
        with conn:
            conn.execute(
                "UPDATE dir SET status = 'pending', retried = 0 "
                "WHERE root_id = ? AND status != 'skipped'",
                (root_id,),
            )

    def attempt(row: sqlite3.Row) -> Listing | OSError:
        try:
            return scan(row["path"])
        except OSError as exc:
            return exc

    processed = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        while True:
            batch_size = workers * 4
            if limit_dirs is not None:
                batch_size = min(batch_size, limit_dirs - processed)
                if batch_size <= 0:
                    stats.stopped = "directory limit reached"
                    break
            batch = conn.execute(
                "SELECT id, path, depth FROM dir WHERE root_id = ? AND status = 'pending' "
                "ORDER BY id LIMIT ?",
                (root_id, batch_size),
            ).fetchall()
            if not batch:
                # A failure during a brief network blip looks like a real
                # error, so everything that failed gets one more go.
                with conn:
                    retry = conn.execute(
                        "UPDATE dir SET status = 'pending', retried = 1 "
                        "WHERE root_id = ? AND status IN ('error', 'missing') AND retried = 0",
                        (root_id,),
                    ).rowcount
                if retry:
                    continue
                break

            results = list(pool.map(attempt, batch))
            outage = False
            with conn:
                for row, result in zip(batch, results):
                    if isinstance(result, Listing):
                        _write_listing(conn, root_id, row, result)
                        stats.dirs_done += 1
                        stats.files += len(result.files)
                        processed += 1
                    elif isinstance(result, PermissionError):
                        _mark(conn, row["id"], "denied", result)
                        stats.denied += 1
                        processed += 1
                    elif outage or not reachable():
                        outage = True  # left pending for the next attempt
                    elif _is_not_found(result):
                        _mark(conn, row["id"], "missing", result)
                        stats.missing += 1
                        processed += 1
                    else:
                        _mark(conn, row["id"], "error", result)
                        stats.errors += 1
                        processed += 1
            if progress:
                progress(stats)
            if outage and not wait_for_root():
                stats.stopped = "network outage"
                break
    return stats
