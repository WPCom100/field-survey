"""vocab.project_id nullable: null = the app library's value (T104, D214)

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-17

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0017"
down_revision: Union[str, Sequence[str], None] = "0016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.alter_column("vocab", "project_id", existing_type=sa.UUID(), nullable=True)


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DELETE FROM vocab WHERE project_id IS NULL")
    op.alter_column("vocab", "project_id", existing_type=sa.UUID(), nullable=False)
