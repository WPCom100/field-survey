"""S3-compatible object storage: SeaweedFS in local dev, Cloudflare R2 everywhere else (D67).

`ObjectStore` is the small surface the blob routes need (T12). `S3ObjectStore` is the real one;
`MemoryObjectStore` backs the API tests. The routes get theirs from `get_object_store`, which
tests override.

`python -m app.storage check` writes, reads and deletes one object to prove the
credentials and bucket in `.env` work (docs/ops.md, provisioning step).
`python -m app.storage ensure-bucket` creates the bucket if it is missing (local dev only).
"""

import sys
import threading
import uuid
from collections import deque
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from functools import lru_cache
from typing import BinaryIO, Protocol

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.config import settings

READ_CHUNK = 256 * 1024
# Reads in flight at once for `read_ordered` (T94): one R2 GET costs ≈ 0.1 s from the Droplet, so
# 10,000 Photo Log pictures read one at a time took 18–23 min. The pool keeps a connection each.
READ_WORKERS = 16
POOL_CONNECTIONS = 32
_END = object()


def client(fail_fast: bool = False):
    """boto3 S3 client for the configured bucket; `fail_fast` (probes) skips retries."""
    extra = {"connect_timeout": 2, "retries": {"max_attempts": 1}} if fail_fast else {}
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            max_pool_connections=POOL_CONNECTIONS,
            **extra,
        ),
    )


def read_ordered[T, R](
    fn: Callable[[T], R], items: Iterable[T], workers: int = READ_WORKERS
) -> Iterator[tuple[T, R | None, Exception | None]]:
    """`fn(item)` for each item on `workers` threads, yielded in the items' order as
    `(item, result, None)` or `(item, None, error)` (T94). At most `workers * 4` calls are ahead of
    the consumer; closing the generator (the job was cancelled) drops the ones not started."""
    ahead = max(1, workers) * 4
    pending: deque[tuple[T, Future[R]]] = deque()
    pool = ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="read")
    try:
        it = iter(items)
        for item in it:
            pending.append((item, pool.submit(fn, item)))
            if len(pending) >= ahead:
                break
        while pending:
            item, fut = pending.popleft()
            nxt = next(it, _END)
            if nxt is not _END:
                pending.append((nxt, pool.submit(fn, nxt)))
            try:
                out = (item, fut.result(), None)
            except Exception as e:  # noqa: BLE001 — handed to the caller with its item
                out = (item, None, e)
            yield out
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


class ObjectMissing(KeyError):
    """The key does not exist in the bucket."""


class ObjectStore(Protocol):
    def put_bytes(self, key: str, data: bytes) -> None: ...

    def put_file(self, key: str, fileobj: BinaryIO, content_type: str) -> None: ...

    def read(self, key: str) -> bytes:
        """The whole object; raises `ObjectMissing`."""
        ...

    def stream(self, key: str) -> Iterator[bytes]:
        """The object in pieces; raises `ObjectMissing` before the first piece."""
        ...

    def delete_many(self, keys: list[str]) -> None:
        """Delete these keys; missing ones are ignored."""
        ...


class S3ObjectStore:
    def __init__(self, s3=None, bucket: str | None = None) -> None:
        self.s3 = s3 or client()
        self.bucket = bucket or settings.s3_bucket

    def put_bytes(self, key: str, data: bytes) -> None:
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data)

    def put_file(self, key: str, fileobj: BinaryIO, content_type: str) -> None:
        self.s3.upload_fileobj(fileobj, self.bucket, key, ExtraArgs={"ContentType": content_type})

    def _get(self, key: str):
        try:
            return self.s3.get_object(Bucket=self.bucket, Key=key)["Body"]
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404", "NotFound"):
                raise ObjectMissing(key) from e
            raise

    def read(self, key: str) -> bytes:
        return self._get(key).read()

    def stream(self, key: str) -> Iterator[bytes]:
        body = self._get(key)  # raises before any byte is sent

        def pieces() -> Iterator[bytes]:
            try:
                yield from body.iter_chunks(READ_CHUNK)
            finally:
                body.close()

        return pieces()

    def delete_many(self, keys: list[str]) -> None:
        for start in range(0, len(keys), 1000):
            batch = [{"Key": k} for k in keys[start : start + 1000]]
            if batch:
                self.s3.delete_objects(Bucket=self.bucket, Delete={"Objects": batch, "Quiet": True})


class MemoryObjectStore:
    """In-process store for tests: same contract, no network."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}
        self._lock = threading.Lock()

    def put_bytes(self, key: str, data: bytes) -> None:
        with self._lock:
            self.objects[key] = bytes(data)

    def put_file(self, key: str, fileobj: BinaryIO, content_type: str) -> None:
        data = fileobj.read()
        with self._lock:
            self.objects[key] = data
            self.content_types[key] = content_type

    def read(self, key: str) -> bytes:
        with self._lock:
            if key not in self.objects:
                raise ObjectMissing(key)
            return self.objects[key]

    def stream(self, key: str) -> Iterator[bytes]:
        data = self.read(key)
        return iter([data[i : i + READ_CHUNK] for i in range(0, len(data), READ_CHUNK)])

    def delete_many(self, keys: list[str]) -> None:
        with self._lock:
            for k in keys:
                self.objects.pop(k, None)
                self.content_types.pop(k, None)


@lru_cache(maxsize=1)
def get_object_store() -> ObjectStore:
    """FastAPI dependency: the configured bucket (tests override it)."""
    return S3ObjectStore()


def check() -> None:
    s3 = client()
    key = f"_health/{uuid.uuid4()}"
    body = b"field-survey storage check"
    s3.put_object(Bucket=settings.s3_bucket, Key=key, Body=body)
    got = s3.get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read()
    s3.delete_object(Bucket=settings.s3_bucket, Key=key)
    if got != body:
        raise SystemExit("storage check: read-back mismatch")
    print(f"storage ok: {settings.s3_endpoint} bucket={settings.s3_bucket}")


def ensure_bucket() -> None:
    s3 = client()
    try:
        s3.head_bucket(Bucket=settings.s3_bucket)
        print(f"bucket exists: {settings.s3_bucket}")
    except ClientError:
        s3.create_bucket(Bucket=settings.s3_bucket)
        print(f"bucket created: {settings.s3_bucket}")


if __name__ == "__main__":
    commands = {"check": check, "ensure-bucket": ensure_bucket}
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        raise SystemExit("usage: python -m app.storage check|ensure-bucket")
    commands[sys.argv[1]]()
