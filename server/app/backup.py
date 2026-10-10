"""Database backups (D67, T06): nightly `pg_dump` to R2, weekly `rclone` copy to a second bucket.

The worker calls `tick()` every minute; it is idempotent and resumable because "already done"
is read from the bucket itself (a dump object for today, a marker for this ISO week), not from
local state. A restart, a redeploy or a missed night just runs the job on the next tick.

    python -m app.backup dump        # take a dump now and upload it
    python -m app.backup copy        # run the bucket copy now
    python -m app.backup lifecycle   # (re)apply the 90-day expiry rule on backups/pg/
    python -m app.backup list        # list dumps in R2
    python -m app.backup fetch KEY   # download one dump to stdout (for restores, docs/ops.md §3)
"""

import datetime as dt
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile

from botocore.exceptions import ClientError
from sqlalchemy.engine import make_url

from app import storage
from app.config import settings

log = logging.getLogger("backup")

DUMP_PREFIX = "backups/pg/"
COPY_MARKER_PREFIX = "backups/copy-markers/"
LIFECYCLE_RULE_ID = "expire-pg-dumps"


def _event(event: str, **fields) -> None:
    log.info(json.dumps({"event": event, **fields}))


def dump_key(now: dt.datetime) -> str:
    return f"{DUMP_PREFIX}survey-{now:%Y-%m-%dT%H%M%SZ}.dump"


def week_marker_key(now: dt.datetime) -> str:
    year, week, _ = now.isocalendar()
    return f"{COPY_MARKER_PREFIX}{year}-W{week:02d}"


def libpq_env(database_url: str) -> dict[str, str]:
    """PG* environment for pg_dump from the SQLAlchemy URL (keeps the password off the argv)."""
    url = make_url(database_url)
    env = {"PGHOST": url.host or "localhost", "PGDATABASE": url.database or ""}
    if url.port:
        env["PGPORT"] = str(url.port)
    if url.username:
        env["PGUSER"] = url.username
    if url.password:
        env["PGPASSWORD"] = url.password
    return env


def _keys(s3, prefix: str) -> list[str]:
    keys: list[str] = []
    for page in s3.get_paginator("list_objects_v2").paginate(
        Bucket=settings.s3_bucket, Prefix=prefix
    ):
        keys.extend(o["Key"] for o in page.get("Contents", []))
    return keys


def dump_done_today(s3, now: dt.datetime) -> bool:
    return bool(_keys(s3, f"{DUMP_PREFIX}survey-{now:%Y-%m-%d}T"))


def dump(s3=None, now: dt.datetime | None = None) -> str:
    """pg_dump -Fc into a temp file, upload it; returns the object key."""
    s3 = s3 or storage.client()
    now = now or dt.datetime.now(dt.UTC)
    key = dump_key(now)
    env = {**os.environ, **libpq_env(settings.database_url)}
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "survey.dump")
        subprocess.run(["pg_dump", "-Fc", "--no-owner", "-f", path], env=env, check=True)
        size = os.path.getsize(path)
        s3.upload_file(path, settings.s3_bucket, key)
    _event("backup_dump", key=key, bytes=size)
    return key


def apply_lifecycle(s3=None) -> None:
    """Expire objects under backups/pg/ after `backup_retention_days`, keeping any other rules."""
    s3 = s3 or storage.client()
    try:
        rules = s3.get_bucket_lifecycle_configuration(Bucket=settings.s3_bucket)["Rules"]
    except ClientError as e:
        if e.response["Error"]["Code"] not in (
            "NoSuchLifecycleConfiguration",
            "NoSuchBucketLifecycle",
        ):
            raise
        rules = []
    rules = [r for r in rules if r.get("ID") != LIFECYCLE_RULE_ID]
    rules.append(
        {
            "ID": LIFECYCLE_RULE_ID,
            "Status": "Enabled",
            "Filter": {"Prefix": DUMP_PREFIX},
            "Expiration": {"Days": settings.backup_retention_days},
        }
    )
    s3.put_bucket_lifecycle_configuration(
        Bucket=settings.s3_bucket, LifecycleConfiguration={"Rules": rules}
    )
    _event("backup_lifecycle", prefix=DUMP_PREFIX, days=settings.backup_retention_days)


def rclone_env() -> dict[str, str]:
    """Two rclone remotes, `src` (the main bucket) and `dst` (the copy bucket), from settings."""

    def remote(name: str, endpoint: str, key: str, secret: str) -> dict[str, str]:
        p = f"RCLONE_CONFIG_{name.upper()}_"
        return {
            p + "TYPE": "s3",
            p + "PROVIDER": "Cloudflare" if "r2.cloudflarestorage.com" in endpoint else "Minio",
            p + "ENDPOINT": endpoint,
            p + "ACCESS_KEY_ID": key,
            p + "SECRET_ACCESS_KEY": secret,
            p + "REGION": settings.s3_region,
            p + "NO_CHECK_BUCKET": "true",
        }

    return {
        **remote("src", settings.s3_endpoint, settings.s3_access_key, settings.s3_secret_key),
        **remote(
            "dst",
            settings.backup_copy_endpoint or settings.s3_endpoint,
            settings.backup_copy_access_key or settings.s3_access_key,
            settings.backup_copy_secret_key or settings.s3_secret_key,
        ),
    }


def copy(s3=None, now: dt.datetime | None = None) -> bool:
    """rclone copy (never sync: nothing is deleted downstream) of the whole main bucket.

    Returns False, logging a warning, when no copy bucket is configured.
    """
    if not settings.backup_copy_bucket:
        _event("backup_copy_skipped", reason="BACKUP_COPY_BUCKET not set")
        return False
    s3 = s3 or storage.client()
    now = now or dt.datetime.now(dt.UTC)
    src, dst = f"src:{settings.s3_bucket}", f"dst:{settings.backup_copy_bucket}"
    subprocess.run(
        [
            "rclone",
            "copy",
            src,
            dst,
            "--exclude",
            f"/{COPY_MARKER_PREFIX}**",
            "--stats-one-line",
            "-v",
        ],
        env={**os.environ, **rclone_env()},
        check=True,
    )
    s3.put_object(
        Bucket=settings.s3_bucket, Key=week_marker_key(now), Body=now.isoformat().encode()
    )
    _event("backup_copy", src=src, dst=dst, week=week_marker_key(now))
    return True


def _exists(s3, key: str) -> bool:
    try:
        s3.head_object(Bucket=settings.s3_bucket, Key=key)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def due(s3, now: dt.datetime) -> list[str]:
    """Which jobs should run now: dump at or after `backup_hour_utc` once a day; copy on
    `backup_copy_weekday` (ISO, 1 = Monday) after that day's dump, once per ISO week."""
    jobs: list[str] = []
    if now.hour < settings.backup_hour_utc:
        return jobs
    if not dump_done_today(s3, now):
        jobs.append("dump")
    if (
        settings.backup_copy_bucket
        and now.isoweekday() >= settings.backup_copy_weekday
        and not _exists(s3, week_marker_key(now))
    ):
        jobs.append("copy")
    return jobs


def tick(s3=None, now: dt.datetime | None = None) -> list[str]:
    """Run whatever is due. A failure is logged and retried on a later tick (never crashes)."""
    if not settings.backup_enabled:
        return []
    now = now or dt.datetime.now(dt.UTC)
    ran: list[str] = []
    try:
        s3 = s3 or storage.client()
        for job in due(s3, now):
            (dump if job == "dump" else copy)(s3, now)
            ran.append(job)
    except Exception as e:  # the worker must keep running (CLAUDE.md §5)
        _event("backup_failed", error=repr(e), ran=ran)
    return ran


def main(argv: list[str]) -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    match argv:
        case ["dump"]:
            print(dump())
        case ["copy"]:
            copy()
        case ["lifecycle"]:
            apply_lifecycle()
        case ["list"]:
            for key in sorted(_keys(storage.client(), DUMP_PREFIX)):
                print(key)
        case ["fetch", key]:
            body = storage.client().get_object(Bucket=settings.s3_bucket, Key=key)["Body"]
            shutil.copyfileobj(body, sys.stdout.buffer)
        case _:
            raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
