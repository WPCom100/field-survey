"""library_type columns, vocab list cable_code, import kind davinci (T111, D197)

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-16

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "0011"
down_revision: Union[str, Sequence[str], None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD_LISTS = (
    "'device_note', 'punch_item', 'punch_note', 'part_note', 'connection_note', "
    "'photo_caption', 'model_map', 'level_alias', 'category', 'type'"
)
NEW_LISTS = OLD_LISTS + ", 'cable_code'"
OLD_KINDS = "'bom', 'riser', 'plans', 'master_xlsx', 'floor_xlsx', 'mss'"
NEW_KINDS = OLD_KINDS + ", 'davinci'"


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("library_type", sa.Column("description", sa.String(), nullable=True))
    op.add_column("library_type", sa.Column("datasheet_url", sa.String(), nullable=True))
    op.add_column(
        "library_type",
        sa.Column("source_ref", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column("library_type", sa.Column("accessory_only", sa.Boolean(), nullable=True))
    op.drop_constraint(op.f("ck_vocab_list"), "vocab", type_="check")
    op.create_check_constraint(op.f("ck_vocab_list"), "vocab", f"list IN ({NEW_LISTS})")
    op.drop_constraint(op.f("ck_import_batch_kind"), "import_batch", type_="check")
    op.create_check_constraint(
        op.f("ck_import_batch_kind"), "import_batch", f"kind IN ({NEW_KINDS})"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f("ck_import_batch_kind"), "import_batch", type_="check")
    op.create_check_constraint(
        op.f("ck_import_batch_kind"), "import_batch", f"kind IN ({OLD_KINDS})"
    )
    op.drop_constraint(op.f("ck_vocab_list"), "vocab", type_="check")
    op.create_check_constraint(op.f("ck_vocab_list"), "vocab", f"list IN ({OLD_LISTS})")
    op.drop_column("library_type", "accessory_only")
    op.drop_column("library_type", "source_ref")
    op.drop_column("library_type", "datasheet_url")
    op.drop_column("library_type", "description")
