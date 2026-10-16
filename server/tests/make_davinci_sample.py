"""Regenerate `fixtures/davinci-library-sample.json` (T111): the golden DaVinci types for
`tests/test_davinci_library.py`, trimmed from a real `library.json` to what the import reads.

    python tests/make_davinci_sample.py "%LOCALAPPDATA%/ETC/DaVinci/library.json"

Keeps the seven types the task names (plus the NSPS kit and an ERP-FT panel, so that ERP-FT-LVD
is reached as an accessory), every accessory they reference, and only the constants, property
types, scripts and documents those types use. Type entries lose their revision history and
visuals. Never edit the output by hand; run this again when ETC's library changes.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "fixtures" / "davinci-library-sample.json"

# displayName → typeId in the 2026-10-13 library (the ids are stable across ETC's updates)
GOLDEN = {
    "NSPS": "ff6d4887-353a-4919-bcc2-50ad725ecc8d",  # P-NSPS-D
    "NSPS-KIT": "1d37a7d1-f519-4710-8a37-46930085cff6",  # P-NSPS-D-KIT
    "EBDK": "fbe5485b-d8c7-442e-aeb4-2e40a8bc3f25",
    "Wall-Mount Contact Interface": "1649d29d-55b0-4cd6-ab9e-1b0fa45bd6cb",  # UHCI-WM
    "ERn2 Mk2": "e1179d8b-2ba9-4401-80df-b8637d2f2ce0",  # ERn2-W-120 Mk2
    'Paradigm 7" Touchscreen': "42d3aab8-fca8-43e5-a4f9-171e593cdacc",  # P-TS7-E
    "2-Button Heritage Station": "0df62e93-5094-4ef3-8e28-97611c11164e",  # UH10002
    "ERP Feedthrough 24": "e55eba99-a39f-453f-b94c-3560fa3af0ea",  # carries ERP-FT-LVD
    "0-10V Option Kit - FT (24 CH)": "d22fb480-10b7-4bb9-9b07-e5520d880ea1",  # ERP-FT-LVD
}
TYPE_DROP = ("versionInformation", "visuals", "imageId", "regulatoryAgencies", "supportedVoltages")


def main(path: str) -> int:
    lib = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    by_id = {t["typeId"]: t for t in lib["types"]}
    wanted = list(GOLDEN.values())
    for tid in list(wanted):
        for a in by_id[tid].get("accessories") or []:
            if a["typeId"] in by_id and a["typeId"] not in wanted:
                wanted.append(a["typeId"])
    types = []
    order = [t["typeId"] for t in lib["types"] if t["typeId"] in wanted]
    for tid in order:
        t = {k: v for k, v in by_id[tid].items() if k not in TYPE_DROP}
        types.append(t)

    used = {
        "familyId": set(),
        "categoryId": set(),
        "portProtocolId": set(),
        "portDirectionId": set(),
        "connectorTypeId": set(),
        "productClassificationId": set(),
        "propertyTypeId": set(),
        "scriptId": set(),
        "documentId": set(),
    }
    for t in types:
        info = t["typeInformation"]
        used["familyId"].add(info.get("familyId"))
        used["categoryId"].add(info.get("categoryId"))
        used["productClassificationId"].add(info.get("productClassificationId"))
        for p in t.get("ports") or []:
            used["portProtocolId"].add(p.get("portProtocolId"))
            used["portDirectionId"].add(p.get("portDirectionId"))
            used["connectorTypeId"].add(p.get("connectorTypeId"))
        for p in t.get("propertyTypes") or []:
            used["propertyTypeId"].add(p.get("propertyTypeId"))
        for it in t["modelInformation"]["generatorData"]["items"]:
            if it.get("type") == "propertyTypeId":
                used["propertyTypeId"].add(it.get("value"))
        for s in t.get("scripts") or []:
            used["scriptId"].add(s.get("scriptId"))
        for d in t.get("documents") or []:
            used["documentId"].add(d)

    c = lib["constants"]

    def pick(name: str, key: str) -> list[dict]:
        return [x for x in c[name] if x[key] in used[key]]

    constants = {
        "families": pick("families", "familyId"),
        "categories": pick("categories", "categoryId"),
        "portProtocols": pick("portProtocols", "portProtocolId"),
        "portDirections": pick("portDirections", "portDirectionId"),
        "connectorTypes": pick("connectorTypes", "connectorTypeId"),
        "productClassifications": pick("productClassifications", "productClassificationId"),
        "documentTypes": c["documentTypes"],
    }
    for rows in constants.values():
        for r in rows:
            r.pop("metadata", None)
            r.pop("imageId", None)
    property_types = [
        {
            "propertyTypeId": p["propertyTypeId"],
            "propertyTypeName": p["propertyTypeName"],
            "propertyMetaData": {
                "data": {
                    "choices": (p.get("propertyMetaData") or {}).get("data", {}).get("choices", [])
                }
            },
        }
        for p in lib["propertyTypes"]
        if p["propertyTypeId"] in used["propertyTypeId"]
    ]
    scripts = [
        {"scriptId": s["scriptId"], "scriptName": s["scriptName"]}
        for s in lib["scripts"]
        if s["scriptId"] in used["scriptId"]
    ]
    documents = [d for d in lib["documents"]["documents"] if d["documentId"] in used["documentId"]]
    sample = {
        "timestamp": lib["timestamp"],
        "sample_of": "ETC DaVinci library.json, trimmed by tests/make_davinci_sample.py (T111)",
        "constants": constants,
        "propertyTypes": property_types,
        "scripts": scripts,
        "documents": {"documents": documents},
        "types": types,
    }
    OUT.write_text(json.dumps(sample, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{OUT}: {len(types)} types, {OUT.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
