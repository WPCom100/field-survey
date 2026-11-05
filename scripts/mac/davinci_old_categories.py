"""A fake older DaVinci_categories.xlsx for the rig's S5 flow (T158, T144).

Before D232 the ERn enclosures read `Equipment`; the workbook in fixtures/ files them under
`Equipment Panels` through the Types tab's Override. This writes a copy whose ERn Product rows
override to `Equipment` instead, so uploading it, then the current workbook, makes the second
upload correct the categories ("n categories corrected"). Runs in the api container (openpyxl):

    python davinci_old_categories.py <in.xlsx> <out.xlsx>
"""

import sys

from openpyxl import load_workbook

OVERRIDE = "Override (optional)"


def main(src: str, dst: str) -> None:
    wb = load_workbook(src)
    ws = wb["Types"]
    header = [c.value for c in ws[1]]
    name_i, kind_i, ov_i = header.index("Display name"), header.index("Product / Accessory"), header.index(OVERRIDE)
    changed = 0
    for row in ws.iter_rows(min_row=2):
        name, kind, ov = row[name_i].value, row[kind_i].value, row[ov_i]
        if isinstance(name, str) and name.startswith("ERn") and kind == "Product" and ov.value == "Equipment Panels":
            ov.value = "Equipment"
            changed += 1
    if not changed:
        sys.exit("no ERn row overrides to Equipment Panels: is this the current workbook?")
    wb.save(dst)
    print(f"{changed} ERn rows → Equipment")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
