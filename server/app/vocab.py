"""Fixed value lists (CLAUDE.md §3, PLAN §2–3). Exact strings, never paraphrased.

Editable lists (category, cable code, notes, captions…) live in the `vocab` table instead.
"""

DEVICE_STATUS = ("Complete", "Installed, untested", "Issue", "Not installed", "No access")
CONNECTION_STATUS = (*DEVICE_STATUS, "Not started")
PUNCH_TYPE = (
    "Missing part",
    "Cable not run",
    "Termination",
    "Wiring",
    "Not installed",
    "Replace Part",
    "Missed Survey",
    "Information",
    "Access",
)
OWNER = ("EC", "ETC", "EC/ETC")
TRACKING_STATUS = ("Open", "In progress", "Closed")
PART_STATUS = ("Needed", "Ordered", "On site", "Installed")
CHANGE_TYPE = (
    "Field survey",
    "Ruling",
    "Reconcile",
    "Correction",
    "Riser cross-check",
    "MSS ruling",
    "Master edit",
)

ORIGIN = ("baseline", "import", "field_addition", "library", "manual")
LEVEL_STATE = ("setup", "baseline_locked")
SHEET_KIND = ("display", "source")
NEURON_METHOD = ("typed", "scan")
CABLE_ORIGIN = ("riser", "library", "import", "manual")
CABLE_SIDE = ("A", "B")
ENDPOINT_KIND = ("device", "placeholder")
STATUS_SOURCE = ("surveyed", "copied", "derived")
PLACEHOLDER_KIND = (
    "fixtures",
    "power",
    "station_bus",
    "level_not_in_scope",
    "external",
    "fixture_run",
    "spare",
    "unknown",
    "custom",
)
PART_SOURCE_TARGET = ("punch", "device", "cable_end")
UPLOAD_STATE = ("local", "partial", "complete")
OP_KIND = ("create", "set", "delete", "restore", "link_add", "link_remove", "assign")
OP_STATE = ("pending", "applied", "review", "rejected", "superseded", "awaiting_approval")
REVIEW_KIND = ("sync_conflict", "extraction", "source_conflict", "import_pair", "lint", "mss")
REVIEW_STATE = ("open", "resolved", "dismissed")
PROPOSAL_KIND = ("punch", "part", "cable", "status", "note")
PROPOSAL_STATE = ("proposed", "accepted", "edited", "rejected", "superseded")
FINDING_STATE = ("open", "resolved", "dismissed")
IMPORT_KIND = ("bom", "riser", "plans", "master_xlsx", "floor_xlsx", "mss")
DRAFT_STATE = ("proposed", "accepted", "edited", "rejected")
ID_SCHEME = ("level_number", "level_tag")
LIBRARY_STATE = ("draft", "accepted", "rejected")
VOCAB_LIST = (
    "device_note",
    "punch_item",
    "punch_note",
    "part_note",
    "connection_note",
    "photo_caption",
    "model_map",
    "level_alias",
    "category",
    "type",
)
EXPORT_KIND = ("xlsx", "floor_pdf")
