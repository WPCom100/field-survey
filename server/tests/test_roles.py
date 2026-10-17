"""Device roles (T112, D201): the category fallback, the type lookup, and the three readers —
the Punch List Device text, the floor PDF pin shapes and the DaVinci import's role on create."""

import uuid

from PIL import Image, ImageDraw

from app import roles
from app.ids import uuid7
from app.jobs import davinci_library as dl
from app.jobs import export_xlsx, floor_pdf
from app.models import Device, LibraryType


def test_the_masters_eight_imply_one_role_each_and_the_eleven_only_where_they_name_one():
    assert len(roles.ROLES) == 9 and set(roles.ROLE_LABEL) == set(roles.ROLES)
    assert len(roles.DEVICE_CATEGORIES) == 11
    for cat, role in {
        "Relay panel": "relay_panel",
        "Foundry panel": "foundry_panel",
        "EBDK": "ebdk",
        "Equipment rack": "equipment_rack",
        "NSPS": "nsps",
        "Touchscreen": "touchscreen",
        "Station": "station",
        "Sensor": "sensor",
        "Emergency Equipment": "ebdk",
        "Equipment Panels": "equipment_rack",
        "Equipment Rack": "equipment_rack",
    }.items():
        assert roles.role_of_category(cat) == role, cat
    for cat in (
        "Power Distribution",
        "Equipment",
        "Power Supplies",
        "Wall Plates",
        None,
        "",
        "Dimmer",
    ):
        assert roles.role_of_category(cat) == "other", cat
    assert set(roles.MASTER_CATEGORY_RENAME.values()) <= set(roles.DEVICE_CATEGORIES)


def test_role_of_reads_the_type_role_then_its_category_then_the_device_category():
    assert (
        roles.role_of(LibraryType(model="x", role="nsps", category="Equipment"), "Equipment")
        == "nsps"
    )
    assert roles.role_of(LibraryType(model="x", role=None, category="NSPS"), "Equipment") == "nsps"
    assert (
        roles.role_of(LibraryType(model="x", role="bogus", category="Station"), "NSPS") == "station"
    )
    assert roles.role_of(LibraryType(model="x", role=None, category=None), "Sensor") == "sensor"
    assert roles.role_of(None, "Power Distribution") == "other"
    assert roles.role_of(None, "EBDK") == "ebdk"


def test_device_roles_resolve_by_link_then_by_device_text_project_types_first():
    app_type = LibraryType(
        id=uuid7(), project_id=None, model="UFMP4", role="foundry_panel", state="draft"
    )
    project_id = uuid7()
    project_type = LibraryType(
        id=uuid7(),
        project_id=project_id,
        model="ufmp 4",
        aliases=["Foundry 4"],
        role="relay_panel",
        state="accepted",
    )
    rejected = LibraryType(
        id=uuid7(), project_id=project_id, model="P-NSPS-D-KIT", role="nsps", state="rejected"
    )
    nsps = LibraryType(
        id=uuid7(),
        project_id=None,
        model="P-NSPS-D",
        aliases=["P-NSPS-D-KIT"],
        category="Equipment",
        role="nsps",
    )
    r = roles.DeviceRoles([app_type, project_type, rejected, nsps])
    # by Device text, spaces and case ignored: the project's type shadows the app library's
    assert r.role_of(Device(device="UFMP4", category="Power Distribution")) == "relay_panel"
    assert r.role_of(Device(device="foundry 4", category="Power Distribution")) == "relay_panel"
    # a rejected type never matches by text; the app library's alias does
    assert r.role_of(Device(device="P-NSPS-D-KIT", category="Equipment")) == "nsps"
    # by link, even a rejected one
    assert (
        r.role_of(Device(library_type_id=rejected.id, device="zzz", category="Equipment")) == "nsps"
    )
    # no type: the category decides, the master's spelling or a D196 name that implies one role
    assert r.role_of(Device(device="CT06LCPB", category="Relay panel")) == "relay_panel"
    assert r.role_of(Device(device="CT06LCPB", category="Power Distribution")) == "other"
    assert r.role_of(Device(device="EBDK", category="Emergency Equipment")) == "ebdk"
    assert r.role_of(None) == "other"


def test_the_punch_list_device_text_reads_the_role():
    nsps = Device(
        display_id="06M-04", device="P-NSPS-D-KIT", category="Equipment", room_location="IDF 6M"
    )
    assert export_xlsx.default_device_text(nsps, "nsps") == "P-NSPS-D-KIT"
    assert (
        export_xlsx.default_device_text(nsps) == "P-NSPS-D-KIT - IDF 6M"
    )  # no type, `Equipment` names no role
    ebdk = Device(
        display_id="06M-03", device="EBDK", category="Emergency Equipment", panel_name="CT06LCPB"
    )
    assert export_xlsx.default_device_text(ebdk) == "EBDK (CT06LCPB)"
    assert export_xlsx.default_device_text(ebdk, "other") == "EBDK"
    ufmp = Device(
        display_id="01-08",
        device="UFMP4",
        category="Power Distribution",
        room_location="BH OBS RM 47",
    )
    assert export_xlsx.default_device_text(ufmp, "foundry_panel") == "UFMP4 - BH OBS RM 47"
    assert export_xlsx.default_device_text(ufmp, "relay_panel") == "UFMP4"
    rack = Device(
        display_id="06M-05",
        device="Equipment Rack 18U",
        category="Equipment Panels",
        room_location="IDF",
    )
    assert export_xlsx.default_device_text(rack) == "Equipment Rack 18U"


def test_floor_pdf_draws_one_shape_per_role_and_the_octagon_for_other():
    pixels = {}
    for role in roles.ROLES:
        img = Image.new("RGB", (60, 60), (255, 255, 255))
        floor_pdf.draw_pin(ImageDraw.Draw(img), 30, 30, role, "Issue", 24)
        pixels[role] = sum(1 for p in img.get_flattened_data() if p != (255, 255, 255))
    assert all(n > 0 for n in pixels.values())
    # the eight shapes differ from the octagon; the two rectangles differ from each other
    assert pixels["relay_panel"] != pixels["other"] and pixels["ebdk"] != pixels["relay_panel"]
    assert pixels["station"] != pixels["sensor"] and pixels["nsps"] != pixels["equipment_rack"]
    # an unknown role or none at all falls back to the octagon
    img = Image.new("RGB", (60, 60), (255, 255, 255))
    floor_pdf.draw_pin(ImageDraw.Draw(img), 30, 30, None, "Issue", 24)
    assert sum(1 for p in img.get_flattened_data() if p != (255, 255, 255)) == pixels["other"]


def _dtype(family: str, category: str, model: str, display_name: str | None = None) -> dl.DType:
    return dl.DType(
        type_id=str(uuid.uuid4()),
        display_name=display_name or model,
        description="",
        family=family,
        category=category,
        classification="",
        legacy=False,
        model_pattern=model,
        model=model,
        variants=(),
        part_numbers=(),
        ports=(),
        slots=(),
        groups=(),
        properties=(),
        datasheet_url=None,
    )


def test_davinci_role_mapping_by_our_category_and_the_davinci_family():
    cases = [
        (("Power Control", "Echo Relay Panels", "ERP24-FT"), "Power Distribution", "relay_panel"),
        (("Power Control", "DRd", "DRD12-24-277"), "Power Distribution", "relay_panel"),
        (("Power Control", "Foundry", "UFMP4"), "Power Distribution", "foundry_panel"),
        (("Power Control", "Foundry CE", "FSP-C-24"), "Power Distribution", "foundry_panel"),
        (("Paradigm", "Controllers", "P-NSPS-D"), "Equipment", "nsps"),
        (("Paradigm", "Controllers", "P-NSPS-D-KIT", "Paradigm NSPS kit"), "Equipment", "nsps"),
        (
            ("Paradigm", "Controllers", "ERn4-RM-240 Mk2", "Unison ERn4 rack-mount"),
            "Equipment",
            "equipment_rack",
        ),
        (("Paradigm", "Controllers", "DIN8-P-ACP"), "Equipment", "other"),
        (("Networking", "Response DMX Gateways", "RSN-DMX8-R"), "Equipment", "other"),
        (
            ("Emergency Lighting Control", "Emergency Bypass Detection Kit", "EBDK"),
            "Emergency Equipment",
            "ebdk",
        ),
        (("Emergency Lighting Control", "ELTS", "KS-ELTS"), "Emergency Equipment", "other"),
        (("Equipment Racks", "Equipment Racks", "18URack"), "Equipment Panels", "equipment_rack"),
        (("Networking", "Simple Network Boxes", "SNB-8"), "Equipment Panels", "other"),
        (("Distribution", "DIN rail Enclosures", "DIN14"), "Equipment Rack", "equipment_rack"),
        (("Paradigm", "Touchscreen Stations", "P-TS7-E"), "Touchscreen", "touchscreen"),
        (("Paradigm", "Inspire Stations", "PI1002"), "Station", "station"),
        (("Paradigm", "Contact Interfaces", "UHCI-WM"), "Sensor", "sensor"),
        (("Echo", "Power Supplies", "E-SPS"), "Power Supplies", "other"),
        (("Distribution", "ECPBs", "ECPB N/N/U"), "Wall Plates", "other"),
    ]
    for args, category, role in cases:
        assert dl.role_of_davinci(_dtype(*args), category) == role, (args, category)
    assert dl.role_of_davinci(_dtype("Paradigm", "Accessories", "P-LCD-FBB"), None) is None
    assert dl.role_of_davinci(_dtype("Paradigm", "Accessories", "P-LCD-FBB"), dl.IGNORE) is None
