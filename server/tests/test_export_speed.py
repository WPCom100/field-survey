"""Export speed at tower scale (T94): the Photo Log reads its pictures from storage several at a
time (`app.storage.read_ordered`), keeps them in Photo Log order and still reports the missing."""

import hashlib
import io
import threading
import time
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from test_export import exports_body, jpeg

from app import projects
from app.auth import upsert_user
from app.blobs import object_key
from app.ids import uuid7
from app.jobs import export_xlsx
from app.models import Blob, Level
from app.storage import READ_WORKERS, read_ordered
from app.sync import OpIn, Push


class SlowStore:
    """The test store with a delay per read, like an R2 GET from the Droplet (≈ 0.1 s)."""

    def __init__(self, store, delay: float) -> None:
        self.store, self.delay = store, delay
        self.reads = self.now = self.most = 0
        self._lock = threading.Lock()

    def read(self, key: str) -> bytes:
        with self._lock:
            self.reads += 1
            self.now += 1
            self.most = max(self.most, self.now)
        try:
            time.sleep(self.delay)
            return self.store.read(key)
        finally:
            with self._lock:
                self.now -= 1


def photo_project(session, store, n: int, missing: int) -> uuid.UUID:
    """n photos, each with its own thumbnail; photo `missing` has none in storage."""
    user = upsert_user(session, "Landry")
    out = projects.create_project(
        session, projects.ProjectIn(name="Pictures", levels=[projects.LevelIn(level="06")]), user
    )
    project_id = uuid.UUID(out.id)
    level = session.scalars(select(Level).where(Level.project_id == project_id)).one()
    ops = []
    for i in range(n):
        data = jpeg(32, 24, color=(i % 256, (i * 7) % 256, (i * 13) % 256))
        sha = hashlib.sha256(data).hexdigest()
        if i != missing:
            store.put_file(object_key(sha), io.BytesIO(data), "image/jpeg")
        session.add(
            Blob(
                sha256=sha,
                size=len(data),
                mime="image/jpeg",
                upload_state="complete",
                chunks_received=[],
            )
        )
        pid = uuid7()
        ops.append(
            OpIn(
                op_id=uuid7(),
                project_id=project_id,
                user_id=user.id,
                install_id=uuid7(),
                client_ts=datetime.now(UTC),
                entity_kind="photo",
                entity_id=pid,
                kind="create",
                change_type="Field survey",
                reason="Field survey",
                payload={"id": str(pid), "level_id": str(level.id), "thumb_blob": sha},
            )
        )
    session.commit()
    Push(session, exports_body(project_id)).run(ops)
    session.commit()
    return project_id


def test_read_ordered_keeps_the_order_and_hands_back_errors():
    def fn(i: int) -> int:
        time.sleep(0.001 * ((i * 7) % 5))  # finish out of order
        if i == 13:
            raise KeyError(i)
        return i * i

    got = list(read_ordered(fn, range(50), workers=8))
    assert [g[0] for g in got] == list(range(50))
    assert all(r == i * i and e is None for i, r, e in got if i != 13)
    assert got[13][1] is None and isinstance(got[13][2], KeyError)


def test_read_ordered_stops_reading_when_closed():
    started = []

    def fn(i: int) -> int:
        started.append(i)
        time.sleep(0.01)
        return i

    reads = read_ordered(fn, range(1000), workers=4)
    for i, _, _ in reads:
        if i == 5:
            break
    reads.close()  # the export was cancelled
    time.sleep(0.05)
    assert len(started) <= 5 + 4 * 4 + 4  # what was consumed, the read-ahead and the running ones


def test_photo_log_reads_pictures_in_parallel_in_order(session, store):
    n, delay = 60, 0.05
    project_id = photo_project(session, store, n, missing=17)

    plain = export_xlsx.load(session, store, project_id, None)
    slow = SlowStore(store, delay)
    t = time.perf_counter()
    data = export_xlsx.load(session, slow, project_id, None)
    took = time.perf_counter() - t

    # several reads at once: 60 one at a time would take 3 s
    assert slow.most > 1 and slow.most <= READ_WORKERS
    assert took < n * delay / 4, took
    # the same pictures in the same rows as a read one at a time, and the missing one reported
    assert {i: im and im.sha256 for i, im in data.images.items()} == {
        i: im and im.sha256 for i, im in plain.images.items()
    }
    assert data.images[17] is None and data.stats["images_missing"] == 1
    assert data.stats["images"] == n - 1
    assert data.rows["Photo Log"] == plain.rows["Photo Log"]
    assert [c for c in data.checks if "picture not in storage" in c] == [
        "Photo Log 06 #18: picture not in storage"
    ]


def test_cancel_during_the_photo_log_stops_the_reads(session, store):
    n = 200
    project_id = photo_project(session, store, n, missing=-1)
    slow = SlowStore(store, 0.01)

    class Cancelled(Exception):
        pass

    def progress(stage, done=None, total=None, unit=None):
        if stage == "Photo Log" and done == 10:
            raise Cancelled

    with pytest.raises(Cancelled):
        export_xlsx.load(session, slow, project_id, None, progress)
    time.sleep(0.1)
    assert slow.reads < n / 2
