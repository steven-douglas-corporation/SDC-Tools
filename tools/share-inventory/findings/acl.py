"""Who can read a folder, from its Windows permissions.

The crawl shows what one account can reach. This shows who else can, which is
what the owner of a folder needs in order to fix it. It asks Windows for the
folder's access list with `icacls`; it does not open or list the folder.
"""

from __future__ import annotations

import re
import subprocess

# Groups that mean "more or less everybody".
BROAD = frozenset(
    {"everyone", "authenticated users", "domain users", "users", "interactive", "anonymous logon", "guests", "domain guests"}
)
_READ_RIGHTS = frozenset({"F", "M", "RX", "R", "GA", "GR", "GE"})
_ENTRY = re.compile(r"^(?P<who>.+?):(?P<flags>(?:\([^)]*\))+)\s*$")


def parse_icacls(output: str, path: str) -> list[tuple[str, str]]:
    """`(principal, rights)` for every entry that grants read access."""
    entries = []
    for line in output.splitlines():
        if line.startswith(path):
            line = line[len(path) :]
        line = line.strip()
        if not line or line.lower().startswith("successfully processed"):
            continue
        found = _ENTRY.match(line)
        if not found:
            continue
        flags = re.findall(r"\(([^)]*)\)", found["flags"])
        if "DENY" in flags or "N" in flags:
            continue
        rights = [right for flag in flags for right in flag.split(",") if right in _READ_RIGHTS]
        if rights:
            entries.append((found["who"].strip(), ",".join(rights)))
    return entries


def broad_principals(entries: list[tuple[str, str]]) -> list[str]:
    return [who for who, _ in entries if who.rsplit("\\", 1)[-1].lower() in BROAD]


def read_acl(path: str, *, timeout: float = 30) -> list[tuple[str, str]] | None:
    """The folder's read entries, or None if Windows would not say."""
    try:
        done = subprocess.run(["icacls", path], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    return parse_icacls(done.stdout, path)


def annotate(findings: list[dict], *, limit: int, read=read_acl) -> tuple[int, int]:
    """Fill `who_can_read` and `broad_access`, most severe first. Returns (read, failed)."""
    cache: dict[str, list[tuple[str, str]] | None] = {}
    failed = 0
    for finding in findings:
        path = finding["path"]
        if path not in cache:
            if len(cache) >= limit:
                continue
            cache[path] = read(path)
            if cache[path] is None:
                failed += 1
        entries = cache[path]
        if entries is None:
            finding["who_can_read"] = "(could not read permissions)"
            continue
        finding["who_can_read"] = "; ".join(f"{who} ({rights})" for who, rights in entries)
        finding["broad_access"] = "; ".join(broad_principals(entries))
    return len(cache) - failed, failed
