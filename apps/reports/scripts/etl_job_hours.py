"""
ETL: Paylocity job-hours export -> MySQL `JobHoursDetail`.

Standalone Python equivalent of the app's in-process sync
(src/lib/sharepoint-hours.ts + syncJobHoursDetail in src/lib/sync-actuals.ts).

WHY THIS EXISTS
    The app's own sync authenticates to Graph with a DPAPI-encrypted delegated
    token cache, which only decrypts inside the interactive Windows session that
    created it. A PM2/service process in session 0 cannot read it -- that is what
    froze the hours data. This script can instead use APP-ONLY auth (no user, no
    session, survives reboots), or read a file you downloaded by hand.

TRANSFORM PARITY -- do not "improve" these rules
    They replicate Power BI's Power Query on this file, and were verified
    2026-07-31 to reproduce PBI's [Hours Actual] by job/section exactly
    (141/141 rows for 2026-07). Any drift here silently produces wrong hours.

      * section code = MachineSec + "-" + Function      e.g. "10" + "211"
      * drop Function "417"
      * split "10-311" into "10-312" (30%) and "10-313" (70%)
      * keep only the 13 ETC-tracked section codes
      * Job Id normalised by stripping leading zeros ("0142" -> "142")
      * Work Date is an Excel serial date in the raw file

SETUP
    pip install msal requests pandas openpyxl PyMySQL python-dotenv

    Config comes from the app's own .env (loaded automatically from the repo
    root), so DATABASE_URL is already correct. For the SharePoint download you
    additionally need:
      GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET
    and the app registration needs the Graph APPLICATION permission
    Sites.Selected with admin consent, plus read on the SDC-PowerBIIntegration
    site. Without that, Graph issues a token but returns 401 spException on the
    site lookup -- get_token() checks the roles claim up front and says so.

USAGE
    # Read a file you downloaded by hand -- no Graph auth needed at all.
    python etl_job_hours.py --file "C:\\path\\Current_Job_Hours.xlsx" --dry-run
    python etl_job_hours.py --file "C:\\path\\Current_Job_Hours.xlsx"

    # Pull straight from SharePoint (needs the app-only credentials above).
    python etl_job_hours.py
    python etl_job_hours.py --month 2026-07
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import logging
import os
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Iterable
from urllib.parse import quote, unquote, urlparse

import pandas as pd
import pymysql

try:  # optional: only needed for the SharePoint download path
    import msal
    import requests
except ImportError:  # pragma: no cover
    msal = None
    requests = None

try:
    from dotenv import load_dotenv

    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))
except ImportError:
    pass


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

SITE = "stevendouglascorp.sharepoint.com:/sites/SDC-PowerBIIntegration"
FILE_PATH = "Project Planner V2/Job Hours Report/Job Hours From Paylocity/Current_Job_Hours.xlsx"
GRAPH = "https://graph.microsoft.com/v1.0"

# The 13 codes the Monthly ETC grid tracks -- SECTIONS minus PM (10-111),
# Manufacturing (10-413) and the Warranty phase (70-*). Mirrors
# ETC_TRACKED_CODES in src/lib/sections.ts.
ETC_TRACKED_CODES: frozenset[str] = frozenset(
    {
        "10-211",  # ME Gen
        "10-312",  # Design & Drawings
        "10-313",  # Software
        "10-515",  # HMI
        "10-516",  # Robot
        "10-517",  # Vision
        "10-518",  # Database & Device
        "10-411",  # Mech Build
        "10-412",  # Elec Build
        "40-211",  # Machine Testing - ME & CE
        "40-411",  # Machine Testing - MB & EB
        "50-211",  # Teardown & Install - ME & CE
        "50-411",  # Teardown & Install - MB & EB
    }
)

REQUIRED_COLUMNS = ("Work Date", "Jobs", "MachineSec", "Function", "Total Hours Worked", "Employee Id")

# Excel's epoch is 1899-12-30 -- the offset accounts for the 1900 leap-year bug.
EXCEL_EPOCH = datetime(1899, 12, 30, tzinfo=timezone.utc)

log = logging.getLogger("etl_job_hours")


# --------------------------------------------------------------------------- #
# Auth -- app-only, so it survives session 0, reboots and service starts
# --------------------------------------------------------------------------- #


def _app_roles(token: str) -> list[str]:
    """Application permissions from the token's `roles` claim.

    Read-only inspection of a token we just acquired -- not validation (Graph
    does that). Returns [] when the claim is absent or unparseable.
    """
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)  # restore base64url padding
        claims = json.loads(base64.urlsafe_b64decode(payload))
        roles = claims.get("roles", [])
        return roles if isinstance(roles, list) else []
    except Exception:
        return []


def get_token() -> str:
    if msal is None:
        raise SystemExit("msal and requests are required for the SharePoint download: pip install msal requests")

    tenant = os.environ.get("GRAPH_TENANT_ID")
    client = os.environ.get("GRAPH_CLIENT_ID")
    secret = os.environ.get("GRAPH_CLIENT_SECRET")
    if not (tenant and client and secret):
        raise SystemExit(
            "GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET must be set.\n"
            "These are the app-only credentials -- the point of this path is to avoid\n"
            "the delegated token cache that a service session cannot read.\n"
            "To run without them, download the file by hand and use --file."
        )

    app = msal.ConfidentialClientApplication(
        client_id=client,
        client_credential=secret,
        authority=f"https://login.microsoftonline.com/{tenant}",
    )
    result = app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
    if "access_token" not in result:
        raise SystemExit(f"Could not acquire an app-only Graph token: {result.get('error_description', result)}")

    token = result["access_token"]
    # A client-credentials token is issued even when the app has NO application
    # permissions; the failure then surfaces later as an opaque 401 on the site
    # lookup. Catch it here, where the message can actually be actioned.
    roles = _app_roles(token)
    if not any(r.startswith(("Sites.", "Files.")) for r in roles):
        raise SystemExit(
            f"The app registration has no Graph Sites/Files application permission "
            f"(roles: {', '.join(roles) if roles else 'none'}).\n"
            "Grant Sites.Selected with admin consent, then give this app read access "
            "to the SDC-PowerBIIntegration site."
        )
    return token


def download_workbook() -> bytes:
    headers = {"Authorization": f"Bearer {get_token()}"}

    site = requests.get(f"{GRAPH}/sites/{SITE}", headers=headers, timeout=60)
    if not site.ok:
        raise SystemExit(f"Graph site lookup failed (HTTP {site.status_code}): {site.text[:300]}")
    site_id = site.json()["id"]

    # ":/content" streams the file itself rather than its metadata.
    url = f"{GRAPH}/sites/{site_id}/drive/root:/{quote(FILE_PATH)}:/content"
    resp = requests.get(url, headers=headers, timeout=300)
    if not resp.ok:
        raise SystemExit(f"Graph file download failed (HTTP {resp.status_code}): {resp.text[:300]}")
    log.info("Downloaded %s (%.1f MB)", FILE_PATH.rsplit("/", 1)[-1], len(resp.content) / 1e6)
    return resp.content


# --------------------------------------------------------------------------- #
# Transform
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Punch:
    job_id: str  # normalised, leading zeros stripped
    section: str
    work_date: date
    employee_id: str
    hours: float

    @property
    def month(self) -> str:
        return f"{self.work_date.year}-{self.work_date.month:02d}"


def _coerce_work_date(value) -> date | None:
    """Work Date is an Excel serial in the raw file, but pandas converts
    date-formatted cells to Timestamps on its own. Accept either, so the result
    does not depend on how the sheet happens to be formatted this week.
    """
    if value is None or pd.isna(value):
        return None
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        serial = float(value)
    except (TypeError, ValueError):
        return None
    if serial <= 0:
        return None
    return (EXCEL_EPOCH + timedelta(days=serial)).date()


def _normalise_job_id(value) -> str | None:
    """"0142" / 142.0 -> "142". None when the row has no job."""
    if value is None or pd.isna(value):
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return str(int(float(text)))
    except (TypeError, ValueError):
        return text.lstrip("0") or "0"


def transform(source: bytes | str) -> list[Punch]:
    buf = source if isinstance(source, str) else io.BytesIO(source)
    raw = pd.read_excel(buf, sheet_name=0)
    log.info("Read %d raw rows from sheet %r", len(raw), 0)

    missing = [c for c in REQUIRED_COLUMNS if c not in raw.columns]
    if missing:
        raise SystemExit(
            f"The export is missing expected column(s): {', '.join(missing)}.\n"
            f"Found: {', '.join(map(str, raw.columns))}"
        )

    # Pull each needed column once as a list. Far faster than per-row attribute
    # lookups, and it keeps the loop below readable.
    work_dates = raw["Work Date"].tolist()
    jobs = raw["Jobs"].tolist()
    machine_secs = raw["MachineSec"].tolist()
    functions = raw["Function"].tolist()
    hours_col = raw["Total Hours Worked"].tolist()
    employees = raw["Employee Id"].tolist()

    punches: list[Punch] = []
    dropped_417 = skipped_untracked = skipped_no_job = skipped_no_date = 0

    def emit(job_id: str, section: str, work_date: date, employee_id: str, hours: float) -> bool:
        if section not in ETC_TRACKED_CODES:
            return False
        punches.append(Punch(job_id, section, work_date, employee_id, hours))
        return True

    for i in range(len(raw)):
        work_date = _coerce_work_date(work_dates[i])
        if work_date is None:
            skipped_no_date += 1
            continue

        function = "" if pd.isna(functions[i]) else str(functions[i]).strip()
        if function == "417":  # dropped by Power BI's own transform
            dropped_417 += 1
            continue

        job_id = _normalise_job_id(jobs[i])
        if job_id is None:
            skipped_no_job += 1
            continue

        machine_sec = "" if pd.isna(machine_secs[i]) else str(machine_secs[i]).strip()
        section = f"{machine_sec}-{function}"

        raw_hours = hours_col[i]
        hours = 0.0 if pd.isna(raw_hours) else float(raw_hours)

        raw_emp = employees[i]
        employee_id = "" if pd.isna(raw_emp) else str(raw_emp).strip()
        # Employee Id arrives as a float when the column is numeric ("1234.0").
        if employee_id.endswith(".0"):
            employee_id = employee_id[:-2]

        if section == "10-311":
            # Split into design (312, 30%) and software (313, 70%), per Power BI.
            # Both halves keep the employee, so one booking shows as two
            # attributed lines that still sum to what was worked.
            kept = emit(job_id, "10-312", work_date, employee_id, hours * 0.3)
            kept |= emit(job_id, "10-313", work_date, employee_id, hours * 0.7)
        else:
            kept = emit(job_id, section, work_date, employee_id, hours)

        if not kept:
            skipped_untracked += 1

    log.info(
        "Transformed -> %d tracked punches (dropped %d fn-417, %d untracked section, "
        "%d no job, %d no date)",
        len(punches), dropped_417, skipped_untracked, skipped_no_job, skipped_no_date,
    )
    return punches


def merge(punches: Iterable[Punch]) -> dict[tuple[str, str], dict[tuple[str, date, str], float]]:
    """Collapse to the table's unique key, bucketed by (job_id, month).

    The export is already one row per employee/day/job/section, but the 10-311
    split can emit two rows for the same key when someone books that function
    twice in a day -- those must be summed, not inserted twice (the table has a
    UNIQUE on jobId+section+workDate+employeeId).
    """
    buckets: dict[tuple[str, str], dict[tuple[str, date, str], float]] = defaultdict(dict)
    for p in punches:
        bucket = buckets[(p.job_id, p.month)]
        key = (p.section, p.work_date, p.employee_id)
        bucket[key] = bucket.get(key, 0.0) + p.hours
    return buckets


# --------------------------------------------------------------------------- #
# Load
# --------------------------------------------------------------------------- #


def connect(database_url: str):
    """Open MySQL using the same DATABASE_URL the app uses."""
    parsed = urlparse(database_url)
    if parsed.scheme not in ("mysql", "mysql+pymysql"):
        raise SystemExit(f"DATABASE_URL must be a mysql:// URL, got {parsed.scheme!r}")
    return pymysql.connect(
        host=parsed.hostname or "127.0.0.1",
        port=parsed.port or 3306,
        user=unquote(parsed.username or ""),
        password=unquote(parsed.password or ""),
        database=(parsed.path or "").lstrip("/"),
        charset="utf8mb4",
        autocommit=False,
    )


def load(conn, buckets, only_month: str | None, dry_run: bool) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT id, jobId FROM Job")
        job_pk_by_job_id = {str(job_id): pk for pk, job_id in cur.fetchall()}
    log.info("Resolved %d jobs from the database", len(job_pk_by_job_id))

    written = deleted = 0
    jobs_not_found: set[str] = set()
    months_touched: set[str] = set()

    for (job_id, month), rows in sorted(buckets.items()):
        if only_month and month != only_month:
            continue
        job_pk = job_pk_by_job_id.get(job_id)
        if job_pk is None:
            jobs_not_found.add(job_id)
            continue

        payload = [
            (job_pk, section, month, work_date, employee_id, Decimal(f"{hours:.2f}"), "sharepoint")
            for (section, work_date, employee_id), hours in rows.items()
        ]
        months_touched.add(month)

        if dry_run:
            written += len(payload)
            continue

        # Replace the whole (job, month) rather than upserting row by row: at
        # ~13k rows an upsert apiece is thousands of round-trips, and a month
        # present in the export is wholly described by it -- so delete-and-insert
        # is both faster and self-healing (a punch removed upstream disappears
        # here too, which an upsert-only pass would leave behind forever).
        #
        # Months NOT in the export are never touched: the file is a rolling
        # window, and treating absence as deletion would erase history.
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM JobHoursDetail WHERE jobId = %s AND month = %s", (job_pk, month))
                deleted += cur.rowcount
                cur.executemany(
                    "INSERT INTO JobHoursDetail "
                    "(jobId, section, month, workDate, employeeId, hours, source, syncedAt) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())",
                    payload,
                )
                written += cur.rowcount
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    verb = "Would write" if dry_run else "Wrote"
    log.info("%s %d rows across %d month(s)%s", verb, written, len(months_touched),
             "" if dry_run else f" (replaced {deleted} existing)")
    if jobs_not_found:
        # Expected and harmless: the export carries spare-parts/service pseudo
        # job numbers the app deliberately does not track.
        sample = ", ".join(sorted(jobs_not_found)[:15])
        log.info("Skipped %d job id(s) with no matching Job row: %s", len(jobs_not_found), sample)


# --------------------------------------------------------------------------- #


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--file", help="Read this local .xlsx instead of downloading from SharePoint")
    ap.add_argument("--month", help='Load only this ETC month, e.g. "2026-07"')
    ap.add_argument("--dry-run", action="store_true", help="Transform and report, write nothing")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is not set (expected in the repo's .env).")

    if args.file:
        if not os.path.isfile(args.file):
            raise SystemExit(f"No such file: {args.file}")
        log.info("Source: local file %s", args.file)
        source: bytes | str = args.file
    else:
        log.info("Source: SharePoint via Microsoft Graph (app-only)")
        source = download_workbook()

    buckets = merge(transform(source))

    months = sorted({m for _, m in buckets})
    log.info("Export covers %d month(s): %s", len(months), ", ".join(months))
    if args.month and args.month not in months:
        raise SystemExit(f"--month {args.month} is not present in this export.")

    conn = connect(database_url)
    try:
        load(conn, buckets, args.month, args.dry_run)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
