"""TP-3 synthetic project generator (T32): small run, counts, numbering, edits and an export."""

from sqlalchemy import func, select

from app.jobs import exports, synthetic
from app.models import CableEnd, Device, Level, Op, Photo, PunchItem, Sheet


def test_synthetic_project_is_made_through_the_push_loop(session, store, factory):
    spec = synthetic.Spec(
        name="TP-3 small",
        devices=40,
        photos=30,
        ops=25,
        levels=("06", "06M", "07"),
        dense_level="06M",
        dense_share=0.5,
    )
    stats = synthetic.generate(session, store, spec)
    pid = stats["project_id"]
    assert stats["levels"] == {"06": 10, "06M": 20, "07": 10}
    count = lambda m: session.scalar(select(func.count()).select_from(m))  # noqa: E731
    assert count(Device) == 40 and count(Photo) == 30 and count(PunchItem) == 20
    assert count(CableEnd) == stats["ends"] == 40
    assert stats["edits"] == 25
    # every level opens a plan sheet: the 06M composite's bytes, one blob for all
    levels = session.scalars(select(Level).where(Level.project_id.is_not(None))).all()
    assert all(lv.display_sheet_id for lv in levels)
    sheets = session.scalars(select(Sheet)).all()
    assert len({s.blob for s in sheets}) == 1 and (
        sheets[0].blob is None or store.read(f"blobs/{sheets[0].blob}")[:4] == b"%PDF"
    )
    # server numbering: photos 1..30 in the 06/06M group + 07's own; C-nn on every end
    assert (
        session.scalar(select(func.count()).select_from(Photo).where(Photo.number.is_(None))) == 0
    )
    assert all(
        e.display_id and e.display_id.startswith("C-") for e in session.scalars(select(CableEnd))
    )
    # distinct thumbnails (no dedupe), all stored
    thumbs = session.scalars(select(Photo.thumb_blob)).all()
    assert len(set(thumbs)) == 30 and all(store.read(f"blobs/{t}") for t in thumbs)
    # the edits are ordinary applied field ops by the team
    users = session.scalars(
        select(func.count(func.distinct(Op.user_id))).where(Op.change_type == "Field survey")
    ).one()
    assert users == 3
    # and the project exports
    row = exports.create_export(session, project_id=pid, user=None)
    assert exports.run_export(factory, store, row.id) == "done"


def test_chunks_never_split_a_cable_from_its_ends(session, store, monkeypatch):
    monkeypatch.setattr(synthetic, "CHUNK", 4)  # a cable + two ends straddle many boundaries
    spec = synthetic.Spec(
        name="TP-3 chunks", devices=12, photos=3, ops=6, levels=("01",), sheet_pdf=None
    )
    stats = synthetic.generate(session, store, spec)
    assert stats["cables"] == 6 and stats["edits"] == 6 and stats["sheet_blob"] is None
