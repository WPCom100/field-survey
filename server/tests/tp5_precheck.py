"""TP-5 pre-check (T30): structural checks for the causes of Excel's "We found a problem with
some content … Do you want us to try to recover as much as we can?" prompt.

This does not replace opening the file in Excel (docs/test/tp5.md); it catches, on any machine,
the package-level mistakes that make Excel repair a workbook: unparsable or untyped parts, broken
relationships, table headers that differ from their cells, overlapping tables / merges, invalid
names, out-of-range style or dxf indexes, over-long strings and formulas, impossible row heights
or widths, chart series pointing at missing sheets.

    uv run python tests/tp5_precheck.py <file.xlsx> [more.xlsx …]

Exit status 0 when no problem is found. `check(path)` returns the list of problems (tests).
"""

from __future__ import annotations

import posixpath
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
}
R_ID = "{%s}id" % NS["r"]
MAX_ROWS, MAX_COLS = 1_048_576, 16_384
CELL = re.compile(r"^\$?([A-Z]{1,3})\$?(\d+)$")
NAME_OK = re.compile(r"^[A-Za-z_\\][A-Za-z0-9_.\\]*$")
BAD_SHEET_CHARS = set("[]:*?/\\")
ILLEGAL_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f]")


def col_num(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def parse_ref(ref: str) -> tuple[int, int, int, int]:
    """'A3:K213' → (row1, col1, row2, col2); a single cell is a 1×1 range."""
    parts = ref.split(":")
    if len(parts) == 1:
        parts = parts * 2
    out = []
    for p in parts:
        m = CELL.match(p)
        if not m:
            raise ValueError(f"bad cell reference {p!r}")
        out.append((int(m.group(2)), col_num(m.group(1))))
    (r1, c1), (r2, c2) = out
    return min(r1, r2), min(c1, c2), max(r1, r2), max(c1, c2)


def overlaps(a, b) -> bool:
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


def rels_of(z: zipfile.ZipFile, part: str) -> dict[str, tuple[str, str]]:
    """rId → (type tail, resolved target) for one part."""
    d, f = posixpath.split(part)
    rp = posixpath.join(d, "_rels", f + ".rels")
    if rp not in z.namelist():
        return {}
    out = {}
    for rel in ET.fromstring(z.read(rp)).findall("pr:Relationship", NS):
        if rel.get("TargetMode") == "External":
            continue
        target = rel.get("Target")
        resolved = (
            target.lstrip("/")
            if target.startswith("/")
            else posixpath.normpath(posixpath.join(d, target))
        )
        out[rel.get("Id")] = (rel.get("Type").rsplit("/", 1)[-1], resolved)
    return out


def check(path: str | Path) -> list[str]:
    problems: list[str] = []
    p = problems.append
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        if bad:
            return [f"zip: corrupt member {bad}"]
        names = set(z.namelist())

        # every XML part parses; content types cover every part
        xml: dict[str, ET.Element] = {}
        for n in sorted(names):
            if n.endswith((".xml", ".rels")):
                try:
                    xml[n] = ET.fromstring(z.read(n))
                except ET.ParseError as e:
                    p(f"{n}: not well-formed XML ({e})")
        ct = xml.get("[Content_Types].xml")
        if ct is None:
            return problems + ["[Content_Types].xml missing"]
        defaults = {e.get("Extension").lower() for e in ct.findall("ct:Default", NS)}
        overrides = {e.get("PartName").lstrip("/") for e in ct.findall("ct:Override", NS)}
        for n in names:
            if n == "[Content_Types].xml" or n.endswith("/"):
                continue
            if n not in overrides and n.rsplit(".", 1)[-1].lower() not in defaults:
                p(f"{n}: no content type")
        for o in overrides:
            if o not in names:
                p(f"[Content_Types].xml: override for missing part {o}")

        # every internal relationship target exists
        for n in names:
            if not n.endswith(".rels"):
                continue
            # `xl/_rels/workbook.xml.rels` belongs to `xl/workbook.xml`; `_rels/.rels` to the root
            src = posixpath.join(
                posixpath.dirname(posixpath.dirname(n)), posixpath.basename(n)[:-5]
            )
            for rid, (_, target) in rels_of(z, src).items():
                if target not in names:
                    p(f"{n}: {rid} → missing {target}")

        # styles
        styles = xml.get("xl/styles.xml")
        n_xf = len(styles.find("m:cellXfs", NS)) if styles is not None else 0
        dxfs = styles.find("m:dxfs", NS) if styles is not None else None
        n_dxf = len(dxfs) if dxfs is not None else 0

        # shared strings
        sst = xml.get("xl/sharedStrings.xml")
        strings: list[str] = []
        if sst is not None:
            for si in sst.findall("m:si", NS):
                strings.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
            unique = sst.get("uniqueCount")
            if unique is not None and int(unique) != len(strings):
                p(f"sharedStrings: uniqueCount {unique} ≠ {len(strings)} items")
            for i, s in enumerate(strings):
                if len(s) > 32767:
                    p(f"sharedStrings[{i}]: {len(s)} characters (> 32,767)")

        # workbook: sheets, names
        wb = xml["xl/workbook.xml"]
        wb_rels = rels_of(z, "xl/workbook.xml")
        sheets: list[tuple[str, str]] = []
        seen_sheet = set()
        for s in wb.find("m:sheets", NS):
            name = s.get("name")
            if len(name) > 31 or BAD_SHEET_CHARS & set(name) or name.startswith("'"):
                p(f"workbook: invalid sheet name {name!r}")
            if name.lower() in seen_sheet:
                p(f"workbook: duplicate sheet name {name!r}")
            seen_sheet.add(name.lower())
            sheets.append((name, wb_rels[s.get(R_ID)][1]))
        sheet_names = {n for n, _ in sheets}
        dn = wb.find("m:definedNames", NS)
        for d in dn if dn is not None else []:
            nm = d.get("name")
            if not (nm.startswith("_xlnm.") or NAME_OK.match(nm)):
                p(f"workbook: invalid defined name {nm!r}")

        table_names: set[str] = set()
        for sheet_name, part in sheets:
            ws = xml[part]
            tag = f"{sheet_name}"
            # cells, styles, formulas
            cells: dict[tuple[int, int], str] = {}
            for row in ws.iter("{%s}row" % NS["m"]):
                ht = row.get("ht")
                if ht is not None and not (0 <= float(ht) <= 409):
                    p(f"{tag}: row {row.get('r')} height {ht} (> 409 pt)")
                for c in row.findall("m:c", NS):
                    r_, c_, _, _ = parse_ref(c.get("r"))
                    if r_ > MAX_ROWS or c_ > MAX_COLS:
                        p(f"{tag}!{c.get('r')}: outside the sheet")
                    s_ = c.get("s")
                    if s_ is not None and int(s_) >= n_xf:
                        p(f"{tag}!{c.get('r')}: style {s_} ≥ {n_xf} cellXfs")
                    f = c.find("m:f", NS)
                    if f is not None and f.text and len(f.text) > 8192:
                        p(f"{tag}!{c.get('r')}: formula of {len(f.text)} characters")
                    v = c.find("m:v", NS)
                    text = None
                    if c.get("t") == "s" and v is not None:
                        i = int(v.text)
                        if i >= len(strings):
                            p(f"{tag}!{c.get('r')}: shared string {i} out of range")
                        else:
                            text = strings[i]
                    elif c.get("t") == "inlineStr":
                        text = "".join(t.text or "" for t in c.iter("{%s}t" % NS["m"]))
                    elif v is not None:
                        text = v.text
                    if text is not None:
                        if ILLEGAL_XML.search(text):
                            p(f"{tag}!{c.get('r')}: control character in text")
                        cells[(r_, c_)] = text
            for col in ws.iter("{%s}col" % NS["m"]):
                w = col.get("width")
                if w is not None and float(w) > 255:
                    p(f"{tag}: column {col.get('min')} width {w} (> 255)")

            # merges never overlap each other
            merges = []
            mc = ws.find("m:mergeCells", NS)
            for m in mc if mc is not None else []:
                rng = parse_ref(m.get("ref"))
                for other in merges:
                    if overlaps(rng, other):
                        p(f"{tag}: merged ranges overlap ({m.get('ref')})")
                merges.append(rng)

            # validations
            dvs = ws.find("m:dataValidations", NS)
            for dv in dvs if dvs is not None else []:
                for sq in dv.get("sqref").split():
                    parse_ref(sq)
                f1 = dv.find("m:formula1", NS)
                if f1 is not None and f1.text and len(f1.text) > 255:
                    p(f"{tag}: validation formula over 255 characters ({dv.get('sqref')})")
                if f1 is not None and f1.text and "!" in f1.text:
                    ref_sheet = f1.text.split("!")[0].lstrip("=").strip("'")
                    if ref_sheet not in sheet_names:
                        p(f"{tag}: validation refers to missing sheet {ref_sheet!r}")

            # conditional formats reference existing dxfs
            for cf in ws.iter("{%s}cfRule" % NS["m"]):
                d = cf.get("dxfId")
                if d is not None and int(d) >= n_dxf:
                    p(f"{tag}: conditional format dxfId {d} ≥ {n_dxf}")

            # tables: unique valid names, headers equal cells, no overlaps with tables/merges,
            # no sheet autofilter on top of a table
            tables = []
            ws_rels = rels_of(z, part)
            tps = ws.find("m:tableParts", NS)
            for tp in tps if tps is not None else []:
                tpart = ws_rels[tp.get(R_ID)][1]
                t = xml[tpart]
                name, disp, ref = t.get("name"), t.get("displayName"), t.get("ref")
                for nm in {name, disp}:
                    if not NAME_OK.match(nm) or CELL.match(nm.upper()):
                        p(f"{tag}: invalid table name {nm!r}")
                if disp.lower() in table_names:
                    p(f"{tag}: duplicate table name {disp!r}")
                table_names.add(disp.lower())
                rng = parse_ref(ref)
                af = t.find("m:autoFilter", NS)
                if af is not None and af.get("ref") != ref:
                    p(f"{tag}: table {disp} autoFilter {af.get('ref')} ≠ {ref}")
                cols = t.find("m:tableColumns", NS)
                if int(cols.get("count")) != len(cols) or len(cols) != rng[3] - rng[1] + 1:
                    p(f"{tag}: table {disp} column count does not match {ref}")
                seen_cols = set()
                for k, tc in enumerate(cols):
                    hdr = tc.get("name")
                    if hdr.lower() in seen_cols:
                        p(f"{tag}: table {disp} duplicate column {hdr!r}")
                    seen_cols.add(hdr.lower())
                    if t.get("headerRowCount", "1") != "0":
                        cell = cells.get((rng[0], rng[1] + k))
                        if cell != hdr:
                            p(f"{tag}: table {disp} header {hdr!r} ≠ cell value {cell!r}")
                for other in tables:
                    if overlaps(rng, other):
                        p(f"{tag}: tables overlap ({ref})")
                for m in merges:
                    if overlaps(rng, m):
                        p(f"{tag}: table {disp} overlaps a merged range")
                tables.append(rng)
            if tables and ws.find("m:autoFilter", NS) is not None:
                p(f"{tag}: sheet autoFilter alongside a table")

            # charts: series refer to existing sheets
            for kind, target in ws_rels.values():
                if kind != "drawing":
                    continue
                for anchor in xml[target]:
                    for pos in anchor.iter("{%s}row" % NS["xdr"]):
                        if int(pos.text) < 0:
                            p(f"{target}: negative anchor row")
                for _, (k2, chart) in rels_of(z, target).items():
                    if k2 != "chart":
                        continue
                    for f in xml[chart].iter("{%s}f" % NS["c"]):
                        ref_sheet = f.text.split("!")[0].strip("'").replace("''", "'")
                        if ref_sheet not in sheet_names:
                            p(f"{chart}: series refers to missing sheet {ref_sheet!r}")
    return problems


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    status = 0
    for path in argv:
        problems = check(path)
        print(f"{path}: {'ok' if not problems else f'{len(problems)} problem(s)'}")
        for line in problems:
            print("  -", line)
        status |= bool(problems)
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
