"""SQLite store for the share inventory.

One row per directory and one per file. A directory is the unit of work: it is
`pending` until its listing has been read and written in a single transaction,
which is what makes a crawl resumable after a dropped connection.

File paths are not stored; a file's path is its directory's path plus its name.
Timestamps are whole seconds since the Unix epoch, UTC.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS root (
    id        INTEGER PRIMARY KEY,
    path      TEXT NOT NULL UNIQUE,
    added_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dir (
    id          INTEGER PRIMARY KEY,
    root_id     INTEGER NOT NULL REFERENCES root(id),
    parent_id   INTEGER REFERENCES dir(id),
    path        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    depth       INTEGER NOT NULL,          -- 0 for the root itself
    mtime       INTEGER,
    ctime       INTEGER,                   -- creation time
    attributes  INTEGER,                   -- Windows file attribute bits
    status      TEXT NOT NULL DEFAULT 'pending',
                -- pending | done | denied | error | skipped
    error       TEXT,
    retried     INTEGER NOT NULL DEFAULT 0,
    scanned_at  INTEGER
);
CREATE INDEX IF NOT EXISTS dir_status ON dir(root_id, status);
CREATE INDEX IF NOT EXISTS dir_parent ON dir(parent_id);

CREATE TABLE IF NOT EXISTS file (
    id          INTEGER PRIMARY KEY,
    dir_id      INTEGER NOT NULL REFERENCES dir(id),
    name        TEXT NOT NULL,
    ext         TEXT NOT NULL,             -- lower case, with the dot; '' if none
    size        INTEGER NOT NULL,
    mtime       INTEGER,
    ctime       INTEGER,                   -- creation time
    atime       INTEGER,                   -- unreliable; recorded, not trusted
    attributes  INTEGER,
    UNIQUE (dir_id, name)
);
CREATE INDEX IF NOT EXISTS file_ext ON file(ext);
"""


def default_db_path() -> Path:
    """Outside the repo, so crawled data cannot be committed by accident."""
    base = os.environ.get("SDC_BRAIN_DATA")
    if base:
        return Path(base) / "inventory.db"
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "SDC-Brain" / "inventory.db"
    return Path.home() / ".sdc-brain" / "inventory.db"


def connect(path: str | os.PathLike[str]) -> sqlite3.Connection:
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn
