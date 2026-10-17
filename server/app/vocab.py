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
# D128: what a photo can be linked to besides the device it was taken from
PHOTO_LINK_TARGET = ("device", "cable_end", "punch")
UPLOAD_STATE = ("local", "partial", "complete")
OP_KIND = ("create", "set", "delete", "restore", "link_add", "link_remove", "assign")
OP_STATE = ("pending", "applied", "review", "rejected", "superseded", "awaiting_approval")
REVIEW_KIND = ("sync_conflict", "extraction", "source_conflict", "import_pair", "lint", "mss")
REVIEW_STATE = ("open", "resolved", "dismissed")
PROPOSAL_KIND = ("punch", "part", "cable", "status", "note")
PROPOSAL_STATE = ("proposed", "accepted", "edited", "rejected", "superseded")
FINDING_STATE = ("open", "resolved", "dismissed")
IMPORT_KIND = ("bom", "riser", "plans", "master_xlsx", "floor_xlsx", "mss", "davinci")
DRAFT_STATE = ("proposed", "accepted", "edited", "rejected")
ID_SCHEME = ("level_number", "level_tag")
LIBRARY_STATE = ("draft", "accepted", "rejected")
# T112 (D201): `library_type.role`; the same list as `ROLES` in app/roles.py (here for the CHECK).
LIBRARY_ROLE = (
    "relay_panel",
    "foundry_panel",
    "ebdk",
    "equipment_rack",
    "nsps",
    "touchscreen",
    "station",
    "sensor",
    "other",
)
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
    # T111 (D197): the cable codes; a DaVinci port protocol with no code lands here as a draft
    "cable_code",
)
# T99 (D174, D212): library suggestion chips — what a row hangs off and where it is offered.
SUGGESTION_SCOPE = ("type", "category", "code")
SUGGESTION_TARGET = ("device_note", "connection_note", "punch_item", "part")
EXPORT_KIND = ("xlsx", "floor_pdf")
