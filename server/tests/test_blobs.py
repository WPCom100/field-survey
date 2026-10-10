"""Resumable blob routes (PLAN §3.4, T12): declare, chunks in any order, status, complete with
hash check, content, dedup, and the S3 store against a real bucket when one is reachable."""

import hashlib
import io
import os
import uuid

import pytest

from app import blobs
from app.config import settings
from app.main import app
from app.storage import MemoryObjectStore, ObjectMissing, S3ObjectStore, get_object_store
from app.storage import client as storage_client
from tests.conftest import HDR

CHUNK = blobs.CHUNK_SIZE


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def payload(size: int, seed: int = 1) -> bytes:
    return bytes((i * 31 + seed) % 251 for i in range(size))


@pytest.fixture
def store():
    s = MemoryObjectStore()
    app.dependency_overrides[get_object_store] = lambda: s
    yield s
    app.dependency_overrides.pop(get_object_store, None)


@pytest.fixture
def api(client, store):
    return client


def declare(api, data: bytes, mime="image/jpeg", **extra):
    return api.post(
        f"/blobs/{sha(data)}", json={"size": len(data), "mime": mime, **extra}, headers=HDR
    )


def put(api, data: bytes, n: int, body: bytes | None = None):
    if body is None:
        body = data[n * CHUNK : (n + 1) * CHUNK]
    return api.put(f"/blobs/{sha(data)}/chunks/{n}", content=body, headers=HDR)


def upload(api, data: bytes, order=None):
    r = declare(api, data)
    assert r.status_code == 200, r.text
    total = r.json()["chunks_total"]
    for n in order if order is not None else range(total):
        assert put(api, data, n).status_code == 200
    return api.post(f"/blobs/{sha(data)}/complete", headers=HDR)


def test_requires_token(api):
    data = b"x"
    assert api.post(f"/blobs/{sha(data)}", json={"size": 1, "mime": "a/b"}).status_code == 401
    assert api.get(f"/blobs/{sha(data)}").status_code == 401
    assert api.get(f"/blobs/{sha(data)}/content").status_code == 401


def test_declare_reports_chunk_plan_and_is_idempotent(api):
    data = payload(2 * CHUNK + 10)
    r = declare(api, data, width=4032, height=3024)
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "sha256": sha(data),
        "size": len(data),
        "mime": "image/jpeg",
        "width": 4032,
        "height": 3024,
        "upload_state": "partial",
        "chunk_size": CHUNK,
        "chunks_total": 3,
        "chunks_received": [],
    }
    assert declare(api, data).json() == body


def test_full_upload_any_order_then_content(api, store):
    data = payload(2 * CHUNK + 12345)
    r = upload(api, data, order=[2, 0, 1])
    assert r.status_code == 200, r.text
    assert r.json()["upload_state"] == "complete"
    assert store.objects[blobs.object_key(sha(data))] == data
    assert store.content_types[blobs.object_key(sha(data))] == "image/jpeg"
    # chunk objects are cleaned up
    assert not [k for k in store.objects if k.startswith("blobs/.chunks/")]
    got = api.get(f"/blobs/{sha(data)}/content", headers=HDR)
    assert got.status_code == 200
    assert got.content == data
    assert got.headers["content-type"] == "image/jpeg"
    assert got.headers["etag"] == f'"{sha(data)}"'


def test_status_lists_received_chunks_for_resume(api):
    data = payload(3 * CHUNK)
    declare(api, data)
    put(api, data, 2)
    put(api, data, 0)
    put(api, data, 0)  # a repeat after a lost response is harmless
    r = api.get(f"/blobs/{sha(data)}", headers=HDR)
    assert r.status_code == 200
    assert r.json()["chunks_received"] == [0, 2]
    assert r.json()["upload_state"] == "partial"
    # resuming by declaring again gives the same answer
    assert declare(api, data).json()["chunks_received"] == [0, 2]


def test_complete_with_missing_chunks_is_409_with_the_list(api):
    data = payload(3 * CHUNK + 1)
    declare(api, data)
    put(api, data, 1)
    r = api.post(f"/blobs/{sha(data)}/complete", headers=HDR)
    assert r.status_code == 409
    assert r.json()["detail"] == {"error": "missing_chunks", "missing": [0, 2, 3]}


def test_hash_mismatch_is_422_and_discards_chunks(api, store):
    data = payload(CHUNK + 5)
    declare(api, data)
    put(api, data, 0)
    put(api, data, 1, body=b"\0" * 5)  # right length, wrong bytes
    r = api.post(f"/blobs/{sha(data)}/complete", headers=HDR)
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "hash_mismatch"
    status = api.get(f"/blobs/{sha(data)}", headers=HDR).json()
    assert status["chunks_received"] == []
    assert status["upload_state"] == "partial"
    assert not [k for k in store.objects if k.startswith("blobs/")]
    # a clean retry succeeds
    assert upload(api, data).status_code == 200


def test_chunk_lost_from_bucket_is_asked_for_again(api, store):
    data = payload(2 * CHUNK)
    declare(api, data)
    put(api, data, 0)
    put(api, data, 1)
    store.delete_many([blobs.chunk_key(sha(data), 1)])
    r = api.post(f"/blobs/{sha(data)}/complete", headers=HDR)
    assert r.status_code == 409
    assert r.json()["detail"]["missing"] == [1]
    assert api.get(f"/blobs/{sha(data)}", headers=HDR).json()["chunks_received"] == [0]


def test_complete_twice_and_declare_after_complete_dedups(api):
    data = payload(1000)
    assert upload(api, data).status_code == 200
    again = api.post(f"/blobs/{sha(data)}/complete", headers=HDR)
    assert again.status_code == 200 and again.json()["upload_state"] == "complete"
    r = declare(api, data)
    assert r.json()["upload_state"] == "complete"
    # a chunk sent after completion is acknowledged, not stored
    assert put(api, data, 0).json()["upload_state"] == "complete"


def test_chunk_validation(api):
    data = payload(CHUNK + 100)
    declare(api, data)
    assert put(api, data, 2).status_code == 422  # out of range
    assert put(api, data, -1).status_code == 422
    r = put(api, data, 1, body=b"x" * 99)  # last chunk must be exactly 100 bytes
    assert r.status_code == 422
    assert r.json()["detail"] == {"error": "bad_chunk_length", "expected": 100, "got": 99}
    assert put(api, data, 0, body=b"x" * CHUNK).status_code == 200  # length ok (hash fails later)
    other = payload(10, seed=9)
    assert put(api, other, 0).status_code == 404  # never declared


def test_declare_validation(api, monkeypatch):
    assert api.post("/blobs/ABC", json={"size": 1, "mime": "a/b"}, headers=HDR).status_code == 422
    upper = sha(b"q").upper()
    assert (
        api.post(f"/blobs/{upper}", json={"size": 1, "mime": "a/b"}, headers=HDR).status_code == 422
    )
    data = b"hello"
    assert declare(api, data).status_code == 200
    r = api.post(f"/blobs/{sha(data)}", json={"size": 6, "mime": "a/b"}, headers=HDR)
    assert r.status_code == 409
    assert r.json()["detail"] == {"error": "size_mismatch", "size": 5}
    monkeypatch.setattr(settings, "blob_max_bytes", 10)
    big = payload(11)
    assert declare(api, big).status_code == 413
    assert (
        api.post(f"/blobs/{sha(b'z')}", json={"size": -1, "mime": "a/b"}, headers=HDR).status_code
        == 422
    )


def test_content_and_status_of_unknown_or_partial_blob(api):
    data = payload(100)
    assert api.get(f"/blobs/{sha(data)}", headers=HDR).status_code == 404
    assert api.get(f"/blobs/{sha(data)}/content", headers=HDR).status_code == 404
    declare(api, data)
    r = api.get(f"/blobs/{sha(data)}/content", headers=HDR)
    assert r.status_code == 404
    assert r.json()["detail"] == {"error": "not_available", "upload_state": "partial"}


def test_empty_blob(api, store):
    data = b""
    r = upload(api, data)
    assert r.status_code == 200 and r.json()["chunks_total"] == 0
    assert api.get(f"/blobs/{sha(data)}/content", headers=HDR).content == b""


def test_survives_a_server_restart_between_chunks(api, store, session):
    """State is the row + the bucket, so a fresh session (restart) resumes where it stopped."""
    data = payload(3 * CHUNK - 7)
    declare(api, data)
    put(api, data, 0)
    session.expunge_all()  # nothing cached in the "process"
    assert api.get(f"/blobs/{sha(data)}", headers=HDR).json()["chunks_received"] == [0]
    put(api, data, 1)
    put(api, data, 2)
    assert api.post(f"/blobs/{sha(data)}/complete", headers=HDR).status_code == 200


# ----------------------------------------------------------------- real bucket


_probe: list[S3ObjectStore | None] = []


def _reachable_s3() -> S3ObjectStore | None:
    """The configured bucket if it answers (probed once, without retries)."""
    if not _probe:
        try:
            s = S3ObjectStore(s3=storage_client(fail_fast=True))
            s.s3.head_bucket(Bucket=s.bucket)
            _probe.append(S3ObjectStore())
        except Exception:
            _probe.append(None)
    return _probe[0]


def test_s3_object_store_round_trip():
    """Runs against S3_ENDPOINT (SeaweedFS locally: `docker compose up -d s3` then
    `uv run python -m app.storage ensure-bucket`). Skipped, with this reason, when unreachable."""
    if os.environ.get("CI"):
        pytest.skip("no S3 service in CI; the API tests use MemoryObjectStore")
    s = _reachable_s3()
    if s is None:
        pytest.skip(f"S3 not reachable at {settings.s3_endpoint} bucket {settings.s3_bucket}")
    key = f"_test/{uuid.uuid4()}"
    data = payload(700_000)  # several READ_CHUNK pieces
    s.put_bytes(key + "/a", data)
    assert s.read(key + "/a") == data
    assert b"".join(s.stream(key + "/a")) == data
    s.put_file(key + "/b", io.BytesIO(data), "image/jpeg")
    head = s.s3.head_object(Bucket=s.bucket, Key=key + "/b")
    assert head["ContentType"] == "image/jpeg"
    s.delete_many([key + "/a", key + "/b", key + "/never"])
    with pytest.raises(ObjectMissing):
        s.read(key + "/a")
    with pytest.raises(ObjectMissing):
        s.stream(key + "/b")


def test_upload_through_the_real_bucket(client):
    """The whole route flow with `S3ObjectStore` (chunks, assembly, content). Same skip rule."""
    if os.environ.get("CI"):
        pytest.skip("no S3 service in CI; the API tests use MemoryObjectStore")
    s = _reachable_s3()
    if s is None:
        pytest.skip(f"S3 not reachable at {settings.s3_endpoint} bucket {settings.s3_bucket}")
    app.dependency_overrides[get_object_store] = lambda: s
    try:
        data = payload(2 * CHUNK + 999, seed=uuid.uuid4().int % 200)
        assert upload(client, data, order=[1, 2, 0]).status_code == 200
        got = client.get(f"/blobs/{sha(data)}/content", headers=HDR)
        assert got.status_code == 200 and got.content == data
        assert not s.s3.list_objects_v2(Bucket=s.bucket, Prefix=f"blobs/.chunks/{sha(data)}/").get(
            "Contents"
        )
        s.delete_many([blobs.object_key(sha(data))])
    finally:
        app.dependency_overrides.pop(get_object_store, None)
