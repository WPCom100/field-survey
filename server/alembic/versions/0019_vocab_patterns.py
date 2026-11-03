"""vocab lists room_code_pattern, tag_pattern: the plans job's text pass (T79, D240)

Revision ID: 0019
Revises: 0018
Create Date: 2026-11-02

"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0019"
down_revision: Union[str, Sequence[str], None] = "0018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD_LISTS = (
    "'device_note', 'punch_item', 'punch_note', 'part_note', 'connection_note', "
    "'photo_caption', 'model_map', 'level_alias', 'category', 'type', 'cable_code'"
)
NEW_LISTS = OLD_LISTS + ", 'room_code_pattern', 'tag_pattern'"


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_constraint(op.f("ck_vocab_list"), "vocab", type_="check")
    op.create_check_constraint(op.f("ck_vocab_list"), "vocab", f"list IN ({NEW_LISTS})")


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DELETE FROM vocab WHERE list IN ('room_code_pattern', 'tag_pattern')")
    op.drop_constraint(op.f("ck_vocab_list"), "vocab", type_="check")
    op.create_check_constraint(op.f("ck_vocab_list"), "vocab", f"list IN ({OLD_LISTS})")
