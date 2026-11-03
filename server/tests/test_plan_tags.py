"""What a plan sheet prints beside its devices (T140, D234): the text pass keeps every model or
alias of a library type — stations and sensors included — joins a type split into fragments or
over two lines, and leaves out notes, legend tables and legend symbols. Golden on the 06M,
Level 02 and Level 03 composites; the job reads the project's library, and `retag` re-reads a
stored sheet."""

import io
from functools import cache

import pdfplumber
import pytest
from conftest import SERVER_DIR
from sqlalchemy import select
from test_plans import _project_with_level, _run, _small_pdf

from app.ids import uuid7
from app.jobs import plan_analysis as pa
from app.jobs import plans
from app.models import LibraryType, Op, Sheet

FIXTURES = SERVER_DIR.parent / "fixtures"
L06M = FIXTURES / "Level_06M_-_Lighting_Composite_vector.pdf"
L02 = FIXTURES / "Level 02 Concourse - Composite (vector).pdf"
L03 = FIXTURES / "Level_03_-_Lighting_Composite_vector.pdf"

# The app library's rows for what these sheets print, as the DaVinci import (T111) writes them
# from ETC's library.json — model and aliases only (display name, part numbers, variants).
CATALOGUE: list[tuple[str, list[str]]] = [
    ("PI1104", ["Inspire Station - 4 Btn Fader", "7185B2110-5", "PI1104-5", "PI1104-X"]),
    ("PI1002", ["Inspire Station - 2 Button", "7185B2102-1", "PI1002-1", "PI1002-X"]),
    ("PI1004", ["Inspire Station - 4 Button", "7185B2104-1", "PI1004-1", "PI1004-X"]),
    ("P-LS", ["Light Sensor", "7184A1451", "7184A1451-4", "P-LS-4", "P-LS-X"]),
    (
        "P-DOC-C",
        ["7184A1416-5", "P-DOC-C-HC-5", "P-DOC-C-SR-5", "P-DOC-C-LR-5", "P-DOC-C-LR-X"],
    ),
    ("EBDK", ["7180A1200"]),
    ("UFMP4", ["4 Zone Mini Panel", "7179A1029", "UFMP4-F"]),
    ("UFMP8", ["8 Zone Mini Panel", "7179A1028", "UFMP8-F"]),
    ("P-NSPS-D-KIT", ["NSPS-KIT", "7182K1711"]),
    ("ERP Feedthrough 24", ["7123A1123", "ERP24-FT121P", "ERP24-FT241P"]),
    ("ERP Feedthrough 48", ["7123A1125", "ERP48-FT481P"]),
    ("ERP-FT-LVD", []),
    ("M-TS8", ["Mosaic Touchscreen 8"]),
    ("UH-NET", ["NET"]),
    ("MAP UPS-1000R", ["UPS"]),
]
NAMES = pa.name_keys(CATALOGUE)


@cache
def _words(path):
    if not path.exists():
        pytest.skip(f"golden fixture missing: {path} (CLAUDE.md §6)")
    with pdfplumber.open(io.BytesIO(path.read_bytes())) as pdf:
        page = pdf.pages[0]
        pa._read_page(pdf, page)  # as the job reads it: paths never kept (T124)
        return pa._page_words(page)


def _tags(path):
    return pa.find_tags(_words(path), names=NAMES)


def _count(tags, text, size=None):
    return sum(1 for t in tags if t["text"] == text and (size is None or t["size"] == size))


def _w(text, x=100.0, y=100.0, size=5.5, width=None):
    half = (width if width is not None else 0.55 * size * len(text)) / 2
    return pa.Word(text, x, y, x - half, y - size / 2, x + half, y + size / 2, size, True)


# ------------------------------------------------------------------ the rules, on made-up words


def test_name_keys_cut_variants_short_and_drop_short_names():
    keys = pa.name_keys(CATALOGUE)
    assert {"PI1104", "P-DOC-C", "P-DOC-C-LR", "P-DOC-C-SR", "ERP24-FT241P", "UFMP8"} <= keys
    assert "INSPIRESTATION-4BTNFADER" in keys  # spaces ignored, as the library matches
    assert "P-DOC-C-LR-X" in keys and "P-DOC" not in keys  # never shorter than the model
    assert not {"NET", "UPS"} & keys  # MIN_NAME_LEN: ordinary words on a sheet
    assert "PI1104-5" in keys and "PI1104" in keys
    assert pa.name_keys([("97", ["-B"])]) == frozenset()


def test_fragments_and_two_line_labels_are_joined():
    """The 03 composite draws `P-DOC` / `C-LR` over two lines and, elsewhere, letter by letter."""
    split = [
        _w("P", 10.0, 50.0, width=3.7),
        _w("-D", 14.6, 50.0, width=5.8),
        _w("O", 19.6, 50.0, width=4.3),
        _w("C", 23.7, 50.0, width=3.9),
    ]
    # x0 of each piece is the x1 of the one before
    for a, b in zip(split, split[1:], strict=False):
        b.x0 = a.x1
    lower = [_w("C", 12.0, 54.4, width=4.0), _w("-L", 16.4, 54.4, width=4.8)]
    lower.append(_w("R", 20.8, 54.4, width=4.0))
    lower[1].x0, lower[2].x0 = lower[0].x1, lower[1].x1
    two_lines = [_w("P-DOC", 300.0, 50.0), _w("C-LR", 300.0, 54.4)]
    erp = [_w("ERP24-FT", 500.0, 50.0), _w("241P", 500.0, 54.5)]
    tags = pa.find_tags([*split, *lower, *two_lines, *erp], names=NAMES)
    assert sorted((t["text"], round(t["x"])) for t in tags) == [
        ("ERP24-FT241P", 500),
        ("P-DOC-C-LR", 17),
        ("P-DOC-C-LR", 300),
    ]
    # without the library nothing is joined, and only the tag patterns count (`P-…` racks)
    assert [t["text"] for t in pa.find_tags(two_lines + erp)] == ["P-DOC"]


def test_notes_and_legends_are_left_out():
    note = [_w("SYSTEM", 0.0, 10.0, 12.0), _w("EBDK", 50.0, 10.0, 12.0), _w("IN", 76.0, 10.0, 12.0)]
    legend = [_w("Description", 400.0, 100.0, 8.0)]
    legend += [_w(t, 400.0, 116.4 + 16.4 * i, 8.0) for i, t in enumerate(["EBDK", "PI1002"])]
    one_row = [_w("Description", 700.0, 100.0, 8.0), _w("PI1104", 700.0, 116.4, 8.0)]
    no_header = [_w(t, 900.0, 100.0 + 16.4 * i, 8.0) for i, t in enumerate(["P-LS", "UFMP4"])]
    no_header.append(_w("PI1004", 900.0, 132.8, 8.0))
    label = [_w("PI1104", 1200.0, 100.0), _w("PANIC", 1212.0, 112.0, 4.0)]
    tiny = [_w("PI1002", 1500.0, 100.0, 2.1)]
    tags = pa.find_tags(note + legend + one_row + no_header + label + tiny, names=NAMES)
    assert [(t["text"], t["x"]) for t in tags] == [("PI1104", 1200.0)]
    # two device labels one above the other are not a legend
    pair = [_w("PI1104", 50.0, 50.0), _w("PI1002", 50.0, 66.0)]
    assert len(pa.find_tags(pair, names=NAMES)) == 2


# ------------------------------------------------------------------ the composites


def test_03_keeps_the_stations_and_sensors_it_prints():
    """Landry on 03 (D234): "PI1004, P-LS, P-DOC-C-LR, EBDK … can easily be matched"."""
    tags = _tags(L03)
    assert _count(tags, "PI1104", 5.5) == 10
    assert _count(tags, "PI1002", 5.5) == 8
    assert _count(tags, "PI1004", 5.5) == 1
    assert _count(tags, "P-LS", 5.5) == 1
    # eight over two lines and four drawn letter by letter, all joined
    assert _count(tags, "P-DOC-C-LR", 5.5) == 12 and _count(tags, "P-DOC", None) == 0
    assert _count(tags, "UFMP4", 5.5) == 2 and _count(tags, "EBDK", 5.5) == 2
    assert _count(tags, "ERP24-FT241P", 5.5) == 2 and _count(tags, "ERP24-FT") == 0
    assert _count(tags, "P-NSPS-D-KIT", 5.5) == 1
    assert {"CT03LCPA", "CT03LCPB"} <= {t["text"] for t in tags}
    # the legend tables (8 pt), their symbols (≈ 2 pt) and the notes (12 pt) are left out
    assert not [t for t in tags if t["text"] not in ("CT03LCPA", "CT03LCPB") and t["size"] != 5.5]
    assert all(t["size"] >= pa.MIN_TAG_SIZE for t in tags)


def test_02_keeps_its_sensors_and_drops_the_word_net():
    tags = _tags(L02)
    assert _count(tags, "PI1002", 5.5) == 49
    assert _count(tags, "P-DOC-C-LR", 5.5) == 13 and _count(tags, "P-DOC-C-SR", 5.5) == 60
    assert _count(tags, "UFMP8", 5.5) == 11 and _count(tags, "UFMP4", 5.5) == 4
    assert _count(tags, "ERP48-FT481P", 5.5) == 4 and _count(tags, "M-TS8", 5.5) == 1
    assert _count(tags, "NET") == 0 and _count(tags, "PI1002", 8.0) == 0


def test_06m_keeps_its_panels_and_drops_its_notes():
    tags = _tags(L06M)
    for text in ("EBDK", "UFMP8", "ERP24-FT241P"):
        assert _count(tags, text, 5.5) == 1, text
    assert _count(tags, "CT06LCPA") == 2 and _count(tags, "CT06LCPB") == 2  # 6 pt and 9.5 pt
    assert _count(tags, "UFMP8", 12.0) == 0  # "CT06LCPA / UFMP8 IN CORE LOCATION"


# ------------------------------------------------------------------ the job


def test_the_job_reads_the_library(session, store, factory, monkeypatch):
    """The plans job passes the names of the project's library and the app library, rejected and
    deleted types left out (T140)."""
    project_id, level, _ = _project_with_level(session)
    other_id, _, _ = _project_with_level(session, "03")
    session.add_all(
        [
            LibraryType(id=uuid7(), project_id=None, model="PI1104", aliases=["PI1104-X"]),
            LibraryType(id=uuid7(), project_id=project_id, model="P-LS", state="accepted"),
            LibraryType(id=uuid7(), project_id=other_id, model="P-DOC-C", state="accepted"),
            LibraryType(id=uuid7(), project_id=None, model="UFMP4", state="rejected"),
        ]
    )
    session.commit()
    seen = []
    real = pa.analyse_sheet

    def spy(data, page_index=0, **kw):
        seen.append(kw["names"])
        return real(data, page_index, **kw)

    monkeypatch.setattr(pa, "analyse_sheet", spy)
    batch = _run(session, store, factory, project_id, level, _small_pdf(), name="t140.pdf")
    assert batch.job_state == "done", batch.stats
    assert seen[-1] == frozenset({"PI1104", "PI1104-X", "P-LS"})


def _text_pdf(words: list[tuple[str, float, float, float]]) -> bytes:
    """A one-page PDF printing `(text, x, y from the top, size)` in Helvetica."""
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    w = PdfWriter()
    page = w.add_blank_page(width=600, height=400)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    fonts = DictionaryObject({NameObject("/F1"): w._add_object(font)})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): fonts})
    content = DecodedStreamObject()
    text = "".join(f"BT /F1 {s} Tf {x} {400 - y} Td ({t}) Tj ET\n" for t, x, y, s in words)
    content.set_data(text.encode())
    page[NameObject("/Contents")] = w._add_object(content)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def test_retag_rereads_the_tags_of_stored_sheets(session, store, factory):
    """`plans retag` (T140): a sheet uploaded before its types were in the library gets them on a
    re-read — one `features` set with only `tags` replaced — and a second re-read changes nothing.
    """
    project_id, level, user = _project_with_level(session, "03")
    pdf = _text_pdf(
        [("PI1104", 100, 100, 5.5), ("CT03LCPA", 300, 100, 6), ("PI1002", 500, 300, 5.5)]
    )
    batch = _run(session, store, factory, project_id, level, pdf, name="03.pdf")
    assert batch.job_state == "done", batch.stats
    sheet = session.scalars(select(Sheet).where(Sheet.level_id == level.id)).one()
    assert [t["text"] for t in sheet.features["tags"]] == ["CT03LCPA"]
    stored = {k: v for k, v in sheet.features.items() if k != "tags"}

    session.add(LibraryType(id=uuid7(), project_id=None, model="PI1104", state="accepted"))
    session.add(LibraryType(id=uuid7(), project_id=project_id, model="PI1002", state="accepted"))
    session.commit()
    out = plans.retag_sheets(session, store, project_id, user.id)
    session.commit()
    assert out["sheets"] == 1
    assert [(c["before"], c["after"]) for c in out["changed"]] == [(1, 3)]
    session.expire_all()
    sheet = session.get(Sheet, sheet.id)
    assert [t["text"] for t in sheet.features["tags"]] == ["CT03LCPA", "PI1002", "PI1104"]
    assert {k: v for k, v in sheet.features.items() if k != "tags"} == stored
    op = session.scalars(select(Op).where(Op.entity_id == sheet.id, Op.field == "features")).one()
    assert (op.change_type, op.reason) == ("Master edit", plans.RETAG_REASON)

    again = plans.retag_sheets(session, store, project_id, user.id)
    assert again["changed"] == [] and again["last_server_seq"] is None
