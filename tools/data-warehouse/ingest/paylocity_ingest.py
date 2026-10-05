"""Paylocity SFTP -> DataWarehouse ingest.

One run, in order:
  1. Download: every file on the SFTP server that hasn't been seen before is
     copied to <root>/incoming, checked (local size matches, and the remote file
     didn't change while it was read), hashed, and recorded in
     "Integration"."SourceFile".
  2. Remote delete (when sftp.delete_after_download is on): a file is removed
     from the SFTP server only once its local copy has passed those checks and
     been recorded, and only if it still hasn't changed on the server.
  3. Load: each spreadsheet in incoming is loaded into "RawPaylocity"."FileRow",
     one JSON row per spreadsheet row. Files that aren't spreadsheets (the PDFs)
     are marked skipped; a file whose exact content was already loaded (Paylocity
     renames yesterday's file with a timestamp, so the same bytes arrive twice)
     is marked duplicate.
  4. Archive: loaded, skipped and duplicate files move from incoming to
     <root>/archive/<yyyy>/<mm>/<folder>/.
  5. Refresh: "Integration"."RefreshWarehouse"() loads the dimensions and facts
     from the staging views, all or nothing.
  6. Purge: archived files past the retention setting are deleted from disk.
     Their rows stay in the database; "Integration"."SourceFile" keeps the record.

A file that fails to load stays in incoming and is retried on the next run. The
run exits non-zero if anything failed, so the scheduled task shows as failed.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import logging
import os
import posixpath
import re
import shutil
import stat
import sys
import tomllib
from pathlib import Path, PurePosixPath
from typing import Iterable, Iterator, NamedTuple

SOURCE = "paylocity"
JOB_NAME = "paylocity_ingest"
KEYRING_SERVICE = "datawarehouse-paylocity-sftp"
DATABASE_KEYRING_SERVICE = "datawarehouse-postgres"
SPREADSHEETS = {".xlsx", ".xlsm", ".xls"}
DEFAULT_SETTINGS = Path(__file__).with_name("settings.toml")

# Paylocity keeps the previous copy as <name>_MM-DD-YY_HH-MM-SS.<ext>; a few
# reports carry a run-time suffix instead (TEMP_LABOR_230038.xls).
VERSION_SUFFIX = re.compile(r"_(\d{2}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}|\d{6})$")

log = logging.getLogger(JOB_NAME)


# ── Files and spreadsheets ──────────────────────────────────────────────────

class RemoteFile(NamedTuple):
    path: str               # full SFTP path, e.g. /employees/Employee_Information.xlsx
    size: int
    modified: dt.datetime   # UTC, whole seconds


def report_key(file_name: str) -> str:
    """The report a file is a version of: Employee_Information_10-04-26_05-00-54.xlsx -> employee_information."""
    stem = VERSION_SUFFIX.sub("", PurePosixPath(file_name).stem.strip()).strip()
    return re.sub(r"[^a-z0-9]+", "_", stem.lower()).strip("_")


def remote_folder(remote_path: str) -> Path:
    """The file's SFTP folder as a relative local path ("" for the root)."""
    return Path(*PurePosixPath(remote_path).parent.parts[1:])


def header_names(cells: list) -> list[str]:
    names: list[str] = []
    seen: dict[str, int] = {}
    for i, value in enumerate(cells, 1):
        name = str(value).strip() if value not in (None, "") else f"column_{i}"
        seen[name] = seen.get(name, 0) + 1
        names.append(name if seen[name] == 1 else f"{name}_{seen[name]}")
    return names


def _json_value(value):
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    return value


def sheet_rows(rows: Iterable[Iterable], header_row: int = 1) -> Iterator[tuple[int, str, str]]:
    """(sheet_row, row_kind, row_json) for every non-blank row of a sheet.

    Rows above the header row are 'preamble' and the header row is 'header',
    both stored as JSON arrays exactly as they appear. Rows below are 'data',
    stored as objects keyed by header name with blank cells left out, so a
    column Paylocity moves or adds doesn't shift any other column's values.
    """
    names: list[str] = []
    for n, cells in enumerate(rows, 1):
        values = [_json_value(c) for c in cells]
        while values and values[-1] in (None, ""):
            values.pop()
        if not values:
            continue
        if n < header_row:
            kind, payload = "preamble", values
        elif n == header_row:
            names = header_names(values)
            kind, payload = "header", values
        else:
            kind = "data"
            payload = {(names[i] if i < len(names) else f"column_{i + 1}"): v
                       for i, v in enumerate(values) if v not in (None, "")}
        yield n, kind, json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str)


def read_workbook(path: Path) -> Iterator[tuple[str, Iterable]]:
    """(sheet_name, rows) for every sheet; consume each sheet's rows before the next."""
    if path.suffix.lower() == ".xls":
        import xlrd
        book = xlrd.open_workbook(str(path))
        for sheet in book.sheets():
            yield sheet.name, (_xls_row(book, sheet, r) for r in range(sheet.nrows))
        return
    import openpyxl
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        for sheet in book.worksheets:
            sheet.reset_dimensions()  # don't trust the file's stored used-range
            yield sheet.title, sheet.iter_rows(values_only=True)
    finally:
        book.close()


def _xls_row(book, sheet, r: int) -> list:
    import xlrd
    row = []
    for cell in sheet.row(r):
        if cell.ctype == xlrd.XL_CELL_DATE:
            row.append(xlrd.xldate_as_datetime(cell.value, book.datemode))
        elif cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
            row.append(None)
        else:
            row.append(cell.value)
    return row


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ── SFTP ────────────────────────────────────────────────────────────────────

def _utc(timestamp: float) -> dt.datetime:
    return dt.datetime.fromtimestamp(int(timestamp), dt.timezone.utc).replace(tzinfo=None)


def sftp_password(username: str) -> str:
    if os.environ.get("SFTP_PASSWORD"):
        return os.environ["SFTP_PASSWORD"]
    import keyring
    password = keyring.get_password(KEYRING_SERVICE, username)
    if not password:
        raise RuntimeError(
            f"No SFTP password stored. As the account that runs the job, run:\n"
            f"  python -m keyring set {KEYRING_SERVICE} {username}\n"
            f"or set SFTP_PASSWORD for a one-off run.")
    return password


def database_password(user: str) -> str:
    if os.environ.get("PGPASSWORD"):
        return os.environ["PGPASSWORD"]
    import keyring
    password = keyring.get_password(DATABASE_KEYRING_SERVICE, user)
    if not password:
        raise RuntimeError(
            f"No database password stored for {user}. As the account that runs the job, run:\n"
            f"  python -m keyring set {DATABASE_KEYRING_SERVICE} {user}\n"
            f"or set PGPASSWORD for a one-off run.")
    return password


def connect_sftp(cfg: dict):
    import paramiko
    transport = paramiko.Transport((cfg["host"], int(cfg.get("port", 22))))
    transport.start_client(timeout=30)
    # Check the server's identity before the password goes anywhere.
    key = transport.get_remote_server_key()
    if key.fingerprint != cfg["host_key"]:
        transport.close()
        raise RuntimeError(f"SFTP host key {key.fingerprint} does not match settings.toml "
                           f"({cfg['host_key']}); refusing to log in.")
    transport.auth_password(cfg["username"], sftp_password(cfg["username"]))
    return transport, paramiko.SFTPClient.from_transport(transport)


def list_remote(sftp, root: str = "/") -> list[RemoteFile]:
    files: list[RemoteFile] = []
    folders = [root]
    while folders:
        folder = folders.pop()
        for entry in sftp.listdir_attr(folder):
            path = posixpath.join(folder, entry.filename)
            if stat.S_ISDIR(entry.st_mode or 0):
                folders.append(path)
            else:
                files.append(RemoteFile(path, entry.st_size, _utc(entry.st_mtime)))
    return sorted(files, key=lambda f: (f.modified, f.path))


def remote_unchanged(sftp, remote: RemoteFile) -> bool:
    try:
        now = sftp.stat(remote.path)
    except FileNotFoundError:
        return False
    return now.st_size == remote.size and _utc(now.st_mtime) == remote.modified


def download(sftp, remote: RemoteFile, incoming: Path) -> tuple[Path, str]:
    """Copy one file into incoming and check it; returns (local path, sha256)."""
    name = PurePosixPath(remote.path).name
    target = incoming / remote_folder(remote.path) / f"{remote.modified:%Y%m%d_%H%M%S}__{name}"
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    sftp.get(remote.path, str(partial))
    local_size = partial.stat().st_size
    if local_size != remote.size or not remote_unchanged(sftp, remote):
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"copy failed validation (remote {remote.size:,} bytes, local {local_size:,}, "
                           f"or the file changed on the server while it was read)")
    sha = sha256_of(partial)
    os.replace(partial, target)
    return target, sha


# ── Warehouse ───────────────────────────────────────────────────────────────

class Warehouse:
    """The PostgreSQL side: "Integration" tracking tables and "RawPaylocity"."FileRow".

    Names are quoted PascalCase, so the SQL here is in single-quoted Python
    strings to keep the double quotes readable.
    """

    def __init__(self, cfg: dict):
        import psycopg
        from psycopg.types.json import Jsonb
        self.Jsonb = Jsonb
        self.cn = psycopg.connect(host=cfg.get("host", "localhost"), port=int(cfg.get("port", 5432)),
                                  dbname=cfg["dbname"], user=cfg["user"],
                                  password=database_password(cfg["user"]), autocommit=False)

    def _one(self, sql: str, *params):
        row = self.cn.execute(sql, params).fetchone()
        self.cn.commit()
        return row

    def _all(self, sql: str, *params) -> list:
        rows = self.cn.execute(sql, params).fetchall()
        self.cn.commit()
        return rows

    def _exec(self, sql: str, *params) -> None:
        self.cn.execute(sql, params)
        self.cn.commit()

    def try_lock(self) -> bool:
        """One run at a time, even when someone starts it by hand during the scheduled run."""
        return self._one('SELECT pg_try_advisory_lock(hashtext(%s))', JOB_NAME)[0]

    def start_batch(self) -> int:
        return self._one('INSERT INTO "Integration"."Batch" ("JobName") VALUES (%s) RETURNING "BatchId"', JOB_NAME)[0]

    def finish_batch(self, batch_id: int, counts: dict, errors: list[str]) -> None:
        self._exec('UPDATE "Integration"."Batch" SET "FinishedAt" = now(), "Status" = %s, "Counts" = %s, '
                   '"ErrorMessage" = %s WHERE "BatchId" = %s',
                   "failed" if errors else "succeeded", self.Jsonb(counts), "\n".join(errors) or None, batch_id)

    def find_version(self, remote: RemoteFile):
        """(file_id, remote_deleted_at) if this exact file version was already copied."""
        return self._one('SELECT "FileId", "RemoteDeletedAt" FROM "Integration"."SourceFile" '
                         'WHERE "Source" = %s AND "RemotePath" = %s AND "RemoteSize" = %s '
                         'AND "RemoteModifiedUtc" = %s ORDER BY "FileId" LIMIT 1',
                         SOURCE, remote.path, remote.size, remote.modified)

    def record_download(self, batch_id: int, remote: RemoteFile, key: str, sha: str, local: Path) -> int:
        self.cn.execute('INSERT INTO "Integration"."SourceReport" ("Source", "ReportKey") VALUES (%s, %s) '
                        'ON CONFLICT DO NOTHING', (SOURCE, key))
        return self._one(
            'INSERT INTO "Integration"."SourceFile" ("BatchId", "Source", "ReportKey", "RemotePath", "RemoteSize", '
            '"RemoteModifiedUtc", "Sha256", "LocalPath", "Status") '
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'downloaded') RETURNING \"FileId\"",
            batch_id, SOURCE, key, remote.path, remote.size, remote.modified, sha, str(local))[0]

    def mark_remote_deleted(self, file_id: int) -> None:
        self._exec('UPDATE "Integration"."SourceFile" SET "RemoteDeletedAt" = now() WHERE "FileId" = %s', file_id)

    def pending_files(self) -> list:
        return self._all(
            'SELECT f."FileId", f."LocalPath", f."Sha256", r."LoadEnabled", r."HeaderRow" '
            'FROM "Integration"."SourceFile" f JOIN "Integration"."SourceReport" r '
            'ON r."Source" = f."Source" AND r."ReportKey" = f."ReportKey" '
            "WHERE f.\"Source\" = %s AND f.\"Status\" IN ('downloaded', 'failed') "
            'ORDER BY f."RemoteModifiedUtc", f."FileId"', SOURCE)

    def loaded_file_with_sha(self, sha: str, file_id: int):
        row = self._one('SELECT "FileId" FROM "Integration"."SourceFile" WHERE "Source" = %s AND "Sha256" = %s '
                        "AND \"Status\" = 'loaded' AND \"FileId\" <> %s ORDER BY \"FileId\" LIMIT 1",
                        SOURCE, sha, file_id)
        return row[0] if row else None

    def set_status(self, file_id: int, status: str, duplicate_of: int | None = None, error: str | None = None) -> None:
        self._exec('UPDATE "Integration"."SourceFile" SET "Status" = %s, "DuplicateOfFileId" = %s, "ErrorMessage" = %s '
                   'WHERE "FileId" = %s', status, duplicate_of, error, file_id)

    def load_file(self, file_id: int, path: Path, header_row: int) -> int:
        """Replace this file's rows in "RawPaylocity"."FileRow" and mark it loaded, in one transaction."""
        total = 0
        try:
            with self.cn.cursor() as cur:
                cur.execute('DELETE FROM "RawPaylocity"."FileRow" WHERE "FileId" = %s', (file_id,))
                with cur.copy('COPY "RawPaylocity"."FileRow" ("FileId", "SheetName", "SheetRow", "RowKind", "RowJson") '
                              'FROM STDIN') as copy:
                    for sheet_name, rows in read_workbook(path):
                        for sheet_row, kind, row_json in sheet_rows(rows, header_row):
                            copy.write_row((file_id, sheet_name, sheet_row, kind, row_json))
                            total += 1
                cur.execute("UPDATE \"Integration\".\"SourceFile\" SET \"Status\" = 'loaded', \"RowsLoaded\" = %s, "
                            '"LoadedAt" = now(), "ErrorMessage" = NULL WHERE "FileId" = %s', (total, file_id))
            self.cn.commit()
        except Exception:
            self.cn.rollback()
            raise
        return total

    def unarchived_done_files(self) -> list:
        return self._all('SELECT "FileId", "LocalPath", "RemotePath", "RemoteModifiedUtc" FROM "Integration"."SourceFile" '
                         "WHERE \"Source\" = %s AND \"Status\" IN ('loaded', 'duplicate', 'skipped') "
                         'AND "ArchivedAt" IS NULL ORDER BY "FileId"', SOURCE)

    def set_archived(self, file_id: int, path: Path) -> None:
        self._exec('UPDATE "Integration"."SourceFile" SET "LocalPath" = %s, "ArchivedAt" = now() WHERE "FileId" = %s',
                   str(path), file_id)

    def purgeable_files(self, archive_days: int, unloaded_archive_days: int) -> list:
        """Archived files past retention. 0 days means keep forever."""
        return self._all(
            'SELECT "FileId", "LocalPath" FROM "Integration"."SourceFile" '
            'WHERE "Source" = %s AND "ArchivedAt" IS NOT NULL AND "PurgedAt" IS NULL AND ('
            "  (\"Status\" IN ('loaded', 'duplicate') AND %s > 0 "
            '   AND "ArchivedAt" < now() - make_interval(days => %s))'
            "  OR (\"Status\" = 'skipped' AND %s > 0 AND \"ArchivedAt\" < now() - make_interval(days => %s)))",
            SOURCE, archive_days, archive_days, unloaded_archive_days, unloaded_archive_days)

    def set_purged(self, file_id: int) -> None:
        self._exec('UPDATE "Integration"."SourceFile" SET "PurgedAt" = now() WHERE "FileId" = %s', file_id)

    def refresh_warehouse(self) -> dict:
        """Load dimensions and facts from staging, in one transaction (all or nothing)."""
        try:
            return self._one('SELECT "Integration"."RefreshWarehouse"()')[0]
        except Exception:
            self.cn.rollback()
            raise


# ── The run ─────────────────────────────────────────────────────────────────

def copy_from_sftp(sftp, wh: Warehouse, batch_id: int, remote_files: list[RemoteFile], incoming: Path,
                   delete_remote: bool, keep_on_server: set[str], counts: collections.Counter,
                   errors: list[str]) -> None:
    for remote in remote_files:
        key = report_key(remote.path)
        try:
            seen = wh.find_version(remote)
            if seen is None:
                local, sha = download(sftp, remote, incoming)
                file_id = wh.record_download(batch_id, remote, key, sha, local)
                deleted_at = None
                counts["downloaded"] += 1
                log.info("copied %s (%s bytes)", remote.path, f"{remote.size:,}")
            else:
                file_id, deleted_at = seen
            # Only after the copy is checked and recorded, and only if the server still has the same version.
            if delete_remote and key not in keep_on_server and deleted_at is None and remote_unchanged(sftp, remote):
                sftp.remove(remote.path)
                wh.mark_remote_deleted(file_id)
                counts["remote_deleted"] += 1
                log.info("deleted %s from the SFTP server", remote.path)
        except Exception as e:
            counts["failed"] += 1
            errors.append(f"copy {remote.path}: {e}")
            log.error("copy %s failed: %s", remote.path, e)


def load_incoming(wh: Warehouse, counts: collections.Counter, errors: list[str]) -> None:
    for file_id, local_path, sha, load_enabled, header_row in wh.pending_files():
        path = Path(local_path)
        try:
            if path.suffix.lower() not in SPREADSHEETS or not load_enabled:
                wh.set_status(file_id, "skipped")
                counts["skipped"] += 1
                continue
            duplicate_of = wh.loaded_file_with_sha(sha, file_id)
            if duplicate_of:
                wh.set_status(file_id, "duplicate", duplicate_of=duplicate_of)
                counts["duplicate"] += 1
                continue
            rows = wh.load_file(file_id, path, header_row)
            counts["loaded"] += 1
            counts["rows_loaded"] += rows
            log.info("loaded %s (%s rows)", path.name, f"{rows:,}")
        except Exception as e:
            counts["failed"] += 1
            errors.append(f"load {path.name}: {e}")
            log.error("load %s failed: %s", path.name, e)
            wh.set_status(file_id, "failed", error=str(e))


def archive_done(wh: Warehouse, archive: Path, counts: collections.Counter, errors: list[str]) -> None:
    for file_id, local_path, remote_path, modified in wh.unarchived_done_files():
        source = Path(local_path)
        target = archive / f"{modified:%Y}" / f"{modified:%m}" / remote_folder(remote_path) / source.name
        try:
            if source.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(source, target)
            elif not target.exists():
                raise FileNotFoundError(f"{source} is missing")
            wh.set_archived(file_id, target)
            counts["archived"] += 1
        except Exception as e:
            counts["failed"] += 1
            errors.append(f"archive {source.name}: {e}")
            log.error("archive %s failed: %s", source.name, e)


def purge_archive(wh: Warehouse, retention: dict, counts: collections.Counter, errors: list[str]) -> None:
    for file_id, local_path in wh.purgeable_files(int(retention.get("archive_days", 0)),
                                                  int(retention.get("unloaded_archive_days", 0))):
        try:
            Path(local_path).unlink(missing_ok=True)
            wh.set_purged(file_id)
            counts["purged"] += 1
        except Exception as e:
            counts["failed"] += 1
            errors.append(f"purge {local_path}: {e}")


def run(settings: dict, dry_run: bool = False) -> int:
    sftp_cfg = settings["sftp"]
    root = Path(settings["paths"]["root"])
    incoming, archive = root / "incoming", root / "archive"
    delete_remote = bool(sftp_cfg.get("delete_after_download", False))
    keep_on_server = set(sftp_cfg.get("keep_on_server", []))

    transport, sftp = connect_sftp(sftp_cfg)
    try:
        remote_files = list_remote(sftp, sftp_cfg.get("root", "/"))
        log.info("%d files on the SFTP server", len(remote_files))
        if dry_run:
            by_report = collections.Counter(report_key(f.path) for f in remote_files)
            for key, n in sorted(by_report.items()):
                log.info("  %-40s %4d file(s)", key, n)
            log.info("dry run: nothing downloaded, deleted or loaded")
            return 0

        wh = Warehouse(settings["warehouse"])
        if not wh.try_lock():
            log.warning("another run is in progress; exiting")
            return 0
        batch_id = wh.start_batch()
        counts: collections.Counter = collections.Counter(seen=len(remote_files))
        errors: list[str] = []
        try:
            copy_from_sftp(sftp, wh, batch_id, remote_files, incoming, delete_remote, keep_on_server, counts, errors)
        except Exception as e:
            errors.append(f"copy: {e}")
            wh.finish_batch(batch_id, dict(counts), errors)
            raise
    finally:
        sftp.close()
        transport.close()

    try:
        load_incoming(wh, counts, errors)
        archive_done(wh, archive, counts, errors)
        try:
            counts["warehouse"] = wh.refresh_warehouse()
            log.info("warehouse refreshed: %s", json.dumps(counts["warehouse"]))
        except Exception as e:
            errors.append(f"refresh warehouse: {e}")
            log.error("warehouse refresh failed: %s", e)
        purge_archive(wh, settings.get("retention", {}), counts, errors)
    except Exception as e:
        errors.append(f"run: {e}")
        raise
    finally:
        wh.finish_batch(batch_id, dict(counts), errors)
    log.info("batch %d done: %s", batch_id, dict(counts))
    return 1 if errors else 0


def inspect(path: Path, header_row: int) -> None:
    """Show how a local file would load, without touching SQL: sheets, row kinds and column names."""
    print(f"{path.name}  report_key={report_key(path.name)}")
    for sheet_name, rows in read_workbook(path):
        kinds = collections.Counter()
        columns: list[str] = []
        for _, kind, row_json in sheet_rows(rows, header_row):
            kinds[kind] += 1
            if kind == "header":
                columns = header_names(json.loads(row_json))
        print(f"  sheet {sheet_name!r}: {dict(kinds)}")
        print(f"    columns: {columns}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--settings", type=Path, default=Path(os.environ.get("DW_SETTINGS", DEFAULT_SETTINGS)))
    parser.add_argument("--dry-run", action="store_true", help="list the SFTP server only; no downloads, deletes or SQL")
    parser.add_argument("--inspect", type=Path, metavar="FILE", help="show how a local spreadsheet would load")
    parser.add_argument("--header-row", type=int, default=1, help="with --inspect")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)

    if args.inspect:
        inspect(args.inspect, args.header_row)
        return 0
    with args.settings.open("rb") as f:
        settings = tomllib.load(f)
    return run(settings, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
