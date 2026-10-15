"""library_type.needs_neuron_id: null = the category's default (T68, D185)

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-15

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0010"
down_revision: Union[str, Sequence[str], None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("library_type", sa.Column("needs_neuron_id", sa.Boolean(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("library_type", "needs_neuron_id")
