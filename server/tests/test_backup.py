"""Backup scheduling and plumbing (app/backup.py). No Postgres, R2 or rclone needed:
S3 is an in-memory fake and the subprocess calls are captured."""

import datetime as dt

import pytest
from botocore.exceptions import ClientError

from app import backup
from app.config import settings


class FakeS3:
    def __init__(self, keys=(), lifecycle=None):
        self.objects = {k: b"" for k in keys}
        self.lifecycle = lifecycle

    def get_paginator(self, _name):
        objects = self.objects

        class P:
            def paginate(self, Bucket, Prefix):
                yield {"Contents": [{"Key": k} for k in objects if k.startswith(Prefix)]}

        return P()

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")

    def put_object(self, Bucket, Key, Body):
        self.objects[Key] = Body

    def upload_file(self, path, Bucket, Key):
        with open(path, "rb") as f:
            self.objects[Key] = f.read()

    def get_bucket_lifecycle_configuration(self, Bucket):
        if self.lifecycle is None:
            raise ClientError({"Error": {"Code": "NoSuchLifecycleConfiguration"}}, "Get")
        return {"Rules": self.lifecycle}

    def put_bucket_lifecycle_configuration(self, Bucket, LifecycleConfiguration):
        self.lifecycle = LifecycleConfiguration["Rules"]


@pytest.fixture
def cfg(monkeypatch):
    monkeypatch.setattr(settings, "backup_enabled", True)
    monkeypatch.setattr(settings, "backup_hour_utc", 8)
    monkeypatch.setattr(settings, "backup_copy_weekday", 7)
    monkeypatch.setattr(settings, "backup_copy_bucket", "survey-copy")
    monkeypatch.setattr(settings, "backup_retention_days", 90)
    return settings


SUN = dt.datetime(2026, 10, 11, 9, 30, tzinfo=dt.UTC)  # ISO week 41, Sunday


def test_keys():
    assert backup.dump_key(SUN) == "backups/pg/survey-2026-10-11T093000Z.dump"
    assert backup.week_marker_key(SUN) == "backups/copy-markers/2026-W41"


def test_libpq_env_from_sqlalchemy_url():
    env = backup.libpq_env("postgresql+psycopg://survey:p%40ss@postgres:5432/survey")
    assert env == {
        "PGHOST": "postgres",
        "PGPORT": "5432",
        "PGDATABASE": "survey",
        "PGUSER": "survey",
        "PGPASSWORD": "p@ss",
    }


def test_nothing_due_before_the_hour(cfg):
    assert backup.due(FakeS3(), SUN.replace(hour=7)) == []


def test_dump_and_copy_due_on_sunday(cfg):
    assert backup.due(FakeS3(), SUN) == ["dump", "copy"]


def test_done_today_and_this_week_is_not_due(cfg):
    s3 = FakeS3(
        [
            "backups/pg/survey-2026-10-11T080100Z.dump",
            "backups/copy-markers/2026-W41",
        ]
    )
    assert backup.due(s3, SUN) == []
    # yesterday's dump does not count for today
    assert backup.due(FakeS3(["backups/pg/survey-2026-10-10T080100Z.dump"]), SUN) == [
        "dump",
        "copy",
    ]


def test_copy_only_on_the_weekday_and_only_when_configured(cfg, monkeypatch):
    assert backup.due(FakeS3(), SUN - dt.timedelta(days=1)) == ["dump"]
    monkeypatch.setattr(settings, "backup_copy_bucket", "")
    assert backup.due(FakeS3(), SUN) == ["dump"]
    assert backup.copy(FakeS3(), SUN) is False


def test_tick_runs_dump_then_copy_and_is_idempotent(cfg, monkeypatch):
    calls = []

    def fake_run(argv, env, check):
        calls.append(argv)
        if argv[0] == "pg_dump":
            with open(argv[argv.index("-f") + 1], "wb") as f:
                f.write(b"PGDMP")
            assert env["PGDATABASE"]
        else:
            assert env["RCLONE_CONFIG_DST_TYPE"] == "s3"

    monkeypatch.setattr(backup.subprocess, "run", fake_run)
    s3 = FakeS3()
    assert backup.tick(s3, SUN) == ["dump", "copy"]
    assert s3.objects["backups/pg/survey-2026-10-11T093000Z.dump"] == b"PGDMP"
    assert "backups/copy-markers/2026-W41" in s3.objects
    assert [c[0] for c in calls] == ["pg_dump", "rclone"]
    assert calls[1][1:4] == ["copy", f"src:{settings.s3_bucket}", "dst:survey-copy"]
    assert backup.tick(s3, SUN + dt.timedelta(minutes=1)) == []


def test_tick_survives_a_failing_dump(cfg, monkeypatch):
    def boom(*a, **k):
        raise OSError("pg_dump not found")

    monkeypatch.setattr(backup.subprocess, "run", boom)
    assert backup.tick(FakeS3(), SUN) == []


def test_tick_disabled(monkeypatch):
    monkeypatch.setattr(settings, "backup_enabled", False)
    assert backup.tick(FakeS3(), SUN) == []


def test_lifecycle_keeps_other_rules_and_replaces_its_own(cfg):
    other = {"ID": "other", "Status": "Enabled", "Filter": {"Prefix": "x/"}}
    stale = {"ID": backup.LIFECYCLE_RULE_ID, "Expiration": {"Days": 7}}
    s3 = FakeS3(lifecycle=[other, stale])
    backup.apply_lifecycle(s3)
    assert s3.lifecycle[0] == other
    assert s3.lifecycle[1]["Expiration"] == {"Days": 90}
    assert s3.lifecycle[1]["Filter"] == {"Prefix": "backups/pg/"}
    fresh = FakeS3()
    backup.apply_lifecycle(fresh)
    assert len(fresh.lifecycle) == 1


def test_rclone_copy_remote_defaults_to_main_credentials(cfg, monkeypatch):
    monkeypatch.setattr(settings, "s3_endpoint", "https://acct.r2.cloudflarestorage.com")
    monkeypatch.setattr(settings, "s3_access_key", "k")
    monkeypatch.setattr(settings, "backup_copy_access_key", "")
    env = backup.rclone_env()
    assert env["RCLONE_CONFIG_SRC_PROVIDER"] == "Cloudflare"
    assert env["RCLONE_CONFIG_DST_ENDPOINT"] == "https://acct.r2.cloudflarestorage.com"
    assert env["RCLONE_CONFIG_DST_ACCESS_KEY_ID"] == "k"
