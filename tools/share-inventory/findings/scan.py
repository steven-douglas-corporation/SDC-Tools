"""Flag files and folders whose names suggest sensitive material.

Reads the inventory database only. Nothing on the shares is opened, and no
file's contents are ever read: a finding is a path, the rule that matched, and
how much sits there.

To keep the report readable:

- a flagged folder stands for everything in it, so nothing beneath it is
  reported again in the same category;
- matching files are grouped by the folder they are in;
- third-party code folders (`node_modules` and the like) are skipped.
"""

from __future__ import annotations

import csv
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from .rules import (
    CODE_EXTENSIONS,
    PERSONAL_ROOTS,
    PERSONAL_RULE,
    PREFILTER,
    RULES,
    SEVERITY_ORDER,
    VENDORED_DIRS,
    Rule,
)

FIELDS = [
    "severity", "category", "rule", "share", "kind", "path", "example",
    "files", "mb", "newest", "who_can_read", "broad_access",
]


def _date(seconds: int | None) -> str:
    if seconds is None:
        return ""
    try:
        return datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%d")
    except (OverflowError, OSError, ValueError):
        return ""


def _share(root_path: str) -> str:
    return root_path.replace("/", "\\").rstrip("\\").rsplit("\\", 1)[-1]


def scan(conn: sqlite3.Connection, rules: tuple[Rule, ...] = RULES) -> list[dict]:
    conn.row_factory = sqlite3.Row
    share_of = {r["id"]: _share(r["path"]) for r in conn.execute("SELECT id, path FROM root")}

    # Directories, parents before children.
    dirs = conn.execute(
        "SELECT id, root_id, parent_id, depth, name, path, status FROM dir ORDER BY depth"
    ).fetchall()

    # What each directory holds, itself and everything beneath it.
    files_in: dict[int, int] = defaultdict(int)
    bytes_in: dict[int, int] = defaultdict(int)
    newest_in: dict[int, int] = {}
    for row in conn.execute("SELECT dir_id, COUNT(*) AS n, SUM(size) AS b, MAX(mtime) AS m FROM file GROUP BY dir_id"):
        files_in[row["dir_id"]] = row["n"]
        bytes_in[row["dir_id"]] = row["b"] or 0
        if row["m"] is not None:
            newest_in[row["dir_id"]] = row["m"]
    for d in reversed(dirs):
        parent = d["parent_id"]
        if parent is None:
            continue
        files_in[parent] += files_in[d["id"]]
        bytes_in[parent] += bytes_in[d["id"]]
        mine = newest_in.get(d["id"])
        if mine is not None and mine > newest_in.get(parent, -(2**62)):
            newest_in[parent] = mine

    dir_rules = [r for r in rules if not r.files_only]
    vendored: dict[int, bool] = {}
    covered: dict[int, frozenset[str]] = {}  # categories already flagged at or above a directory
    path_of: dict[int, str] = {}
    root_of: dict[int, int] = {}
    findings: list[dict] = []

    def add(rule: Rule, kind: str, dir_id: int, example: str, files: int, size: int, newest: int | None) -> None:
        findings.append(
            {
                "severity": rule.severity,
                "category": rule.category,
                "rule": rule.id,
                "share": share_of[root_of[dir_id]],
                "kind": kind,
                "path": path_of[dir_id],
                "example": example,
                "files": files,
                "mb": round(size / 1024**2, 1),
                "newest": _date(newest),
                "who_can_read": "",
                "broad_access": "",
            }
        )

    for d in dirs:
        dir_id, parent = d["id"], d["parent_id"]
        path_of[dir_id] = d["path"]
        root_of[dir_id] = d["root_id"]
        inherited = covered.get(parent, frozenset()) if parent is not None else frozenset()
        vendored[dir_id] = (parent is not None and vendored[parent]) or d["name"].lower() in VENDORED_DIRS
        if d["depth"] == 0 or vendored[dir_id]:
            covered[dir_id] = inherited
            continue

        mine = set()
        if d["depth"] == 1 and d["status"] == "done" and share_of[d["root_id"]].lower() in PERSONAL_ROOTS:
            add(PERSONAL_RULE, "personal folder", dir_id, "", files_in[dir_id], bytes_in[dir_id], newest_in.get(dir_id))
        if PREFILTER.search(d["name"]):
            for rule in dir_rules:
                if rule.category in inherited or rule.category in mine:
                    continue
                if rule.pattern.search(d["name"]):
                    mine.add(rule.category)
                    add(rule, "folder", dir_id, "", files_in[dir_id], bytes_in[dir_id], newest_in.get(dir_id))
        covered[dir_id] = inherited | mine if mine else inherited

    # Files, grouped by the folder they sit in.
    groups: dict[tuple[int, str], dict] = {}
    by_id = {rule.id: rule for rule in rules}
    for row in conn.execute("SELECT dir_id, name, ext, size, mtime FROM file"):
        name = row["name"]
        if not PREFILTER.search(name):
            continue
        dir_id = row["dir_id"]
        if vendored.get(dir_id, False):
            continue
        is_code = row["ext"] in CODE_EXTENSIONS
        here = covered.get(dir_id, frozenset())
        for rule in rules:
            if rule.category in here or (is_code and not rule.code_ok):
                continue
            if not rule.pattern.search(name):
                continue
            group = groups.setdefault((dir_id, rule.id), {"n": 0, "bytes": 0, "newest": None, "example": name})
            group["n"] += 1
            group["bytes"] += row["size"]
            if row["mtime"] is not None and (group["newest"] is None or row["mtime"] > group["newest"]):
                group["newest"] = row["mtime"]
    for (dir_id, rule_id), group in groups.items():
        add(by_id[rule_id], "files", dir_id, group["example"], group["n"], group["bytes"], group["newest"])

    findings.sort(key=lambda f: (SEVERITY_ORDER[f["severity"]], f["category"], f["share"], f["path"].lower(), f["rule"]))
    return findings


def write_report(findings: list[dict], path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(findings)
    return path
