"""index op (project_id, entity_kind, kind) for device-ID assignment (T75, D146)

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-12

"""

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "0004"
down_revision: Union[str, Sequence[str], None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_index(
        "ix_op_project_id_entity_kind_kind", "op", ["project_id", "entity_kind", "kind"]
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_op_project_id_entity_kind_kind", table_name="op")
