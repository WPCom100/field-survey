"""vocab.state: draft until accepted (T40, D182)

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-15

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0008"
down_revision: Union[str, Sequence[str], None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "vocab",
        sa.Column("state", sa.String(), server_default="accepted", nullable=False),
    )
    op.create_check_constraint(
        op.f("ck_vocab_state"), "vocab", "state IN ('draft', 'accepted', 'rejected')"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f("ck_vocab_state"), "vocab", type_="check")
    op.drop_column("vocab", "state")
