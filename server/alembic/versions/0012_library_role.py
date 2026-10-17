"""library_type.role (T112, D201)

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-16

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0012"
down_revision: Union[str, Sequence[str], None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ROLES = (
    "'relay_panel', 'foundry_panel', 'ebdk', 'equipment_rack', 'nsps', 'touchscreen', "
    "'station', 'sensor', 'other'"
)


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("library_type", sa.Column("role", sa.String(), nullable=True))
    op.create_check_constraint(op.f("ck_library_type_role"), "library_type", f"role IN ({ROLES})")


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f("ck_library_type_role"), "library_type", type_="check")
    op.drop_column("library_type", "role")
