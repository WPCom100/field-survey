"""Floor PDF at tower scale (T98): the findings' thumbnails and the Photos section's pictures are
read from storage several at a time (`app.storage.read_ordered`), in report order, with a bound on
the full-size pictures held at once."""

import threading
import time
import uuid

import pytest
from test_export_speed import SlowStore, photo_project

from app.jobs import floor_pdf, synthetic
from app.storage import READ_WORKERS, read_ordered


def finding_project(session, store) -> uuid.UUID:
    spec = synthetic.Spec(
        name="Floor PDF speed",
        devices=40,
        photos=160,
        ops=0,
        levels=("06",),
        dense_level=None,
        sheet_pdf=None,
    )
    return uuid.UUID(synthetic.generate(session, store, spec)["project_id"])


class FailingStore:
    """Storage that is down for one key (not a missing picture)."""

    def __init__(self, store, every: int) -> None:
        self.store, self.every, self.reads = store, every, 0
        self._lock = threading.Lock()

    def read(self, key: str) -> bytes:
        with self._lock:
            self.reads += 1
            n = self.reads
        if n == self.every:
            raise RuntimeError("storage down")
        return self.store.read(key)


def test_read_ordered_ahead_bounds_what_is_held():
    started, consumed = [], []
    most = [0]

    def fn(i: int) -> int:
        started.append(i)
        most[0] = max(most[0], len(started) - len(consumed))
        time.sleep(0.002)
        return i

    for i, r, e in read_ordered(fn, range(60), workers=8, ahead=3):
        assert r == i and e is None
        consumed.append(i)
    assert consumed == list(range(60))
    assert most[0] <= 3  # never more than `ahead` read and not yet consumed


def test_photos_section_reads_in_parallel_in_order(session, store):
    n, delay = 60, 0.05
    project_id = photo_project(session, store, n, missing=17)

    plain = floor_pdf.load(session, store, project_id, "06", ("photos",))
    slow = SlowStore(store, delay)
    t = time.perf_counter()
    data = floor_pdf.load(session, slow, project_id, "06", ("photos",))
    took = time.perf_counter() - t

    # several reads at once: 60 one at a time would take 3 s
    assert 1 < slow.most <= min(READ_WORKERS, floor_pdf.PHOTOS_AHEAD)
    assert took < n * delay / 4, took
    # the same pictures in the same order as read one at a time; the missing one has none
    assert [(p.number, p.jpeg) for p in data.photos] == [(p.number, p.jpeg) for p in plain.photos]
    assert [p.jpeg is None for p in data.photos].count(True) == 1
    assert data.photos[17].jpeg is None


def test_findings_thumbnails_read_in_parallel_per_device(session, store):
    project_id = finding_project(session, store)
    plain = floor_pdf.load(session, store, project_id, "06", ("findings",))
    wanted = sum(len(d.thumbs) for d in plain.devices)
    assert wanted > 20
    assert all(len(d.thumbs) <= floor_pdf.THUMBS_PER_FINDING for d in plain.devices)
    assert all(not d.thumbs for d in plain.devices if d.status == floor_pdf.NOT_A_FINDING)

    slow = SlowStore(store, 0.03)
    t = time.perf_counter()
    data = floor_pdf.load(session, slow, project_id, "06", ("findings",))
    took = time.perf_counter() - t
    assert slow.most > 1 and slow.reads == wanted
    assert took < wanted * 0.03 / 4, took
    # each device keeps its own thumbnails, in the same order
    assert [(d.display_id, d.thumbs) for d in data.devices] == [
        (d.display_id, d.thumbs) for d in plain.devices
    ]


def test_a_storage_error_still_fails_the_floor_pdf(session, store):
    project_id = photo_project(session, store, 30, missing=-1)
    with pytest.raises(RuntimeError, match="storage down"):
        floor_pdf.load(session, FailingStore(store, every=12), project_id, "06", ("photos",))


def test_cancel_during_the_photos_stops_the_reads(session, store):
    n = 200
    project_id = photo_project(session, store, n, missing=-1)
    slow = SlowStore(store, 0.01)

    class Cancelled(Exception):
        pass

    def progress(stage, done=None, total=None, unit=None):
        if stage == "Photos" and done == 10:
            raise Cancelled

    with pytest.raises(Cancelled):
        floor_pdf.load(session, slow, project_id, "06", ("photos",), progress)
    time.sleep(0.1)
    assert slow.reads < n / 2
