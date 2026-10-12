"""export jobs and punch device text (T29, D136, D137)

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-12

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: Union[str, Sequence[str], None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("punch_item", sa.Column("device_text", sa.String(), nullable=True))
    op.add_column("export", sa.Column("job_state", sa.String(), nullable=True))
    op.add_column(
        "export", sa.Column("stats", postgresql.JSONB(astext_type=sa.Text()), nullable=True)
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("export", "stats")
    op.drop_column("export", "job_state")
    op.drop_column("punch_item", "device_text")
