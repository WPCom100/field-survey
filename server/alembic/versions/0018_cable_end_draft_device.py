"""cable_end.draft_device_id: the unplaced draft device an end waits for (T136, D235)

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-02

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0018"
down_revision: Union[str, Sequence[str], None] = "0017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("cable_end", sa.Column("draft_device_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        op.f("fk_cable_end_draft_device_id_draft_device"),
        "cable_end",
        "draft_device",
        ["draft_device_id"],
        ["id"],
        initially="DEFERRED",
        deferrable=True,
    )
    op.create_index(
        op.f("ix_cable_end_draft_device_id"), "cable_end", ["draft_device_id"], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_cable_end_draft_device_id"), table_name="cable_end")
    op.drop_constraint(
        op.f("fk_cable_end_draft_device_id_draft_device"), "cable_end", type_="foreignkey"
    )
    op.drop_column("cable_end", "draft_device_id")
