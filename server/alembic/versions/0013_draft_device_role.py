"""draft_device.role (T115, D201)

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-16

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0013"
down_revision: Union[str, Sequence[str], None] = "0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ROLES = (
    "'relay_panel', 'foundry_panel', 'ebdk', 'equipment_rack', 'nsps', 'touchscreen', "
    "'station', 'sensor', 'other'"
)


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("draft_device", sa.Column("role", sa.String(), nullable=True))
    op.create_check_constraint(op.f("ck_draft_device_role"), "draft_device", f"role IN ({ROLES})")


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f("ck_draft_device_role"), "draft_device", type_="check")
    op.drop_column("draft_device", "role")
