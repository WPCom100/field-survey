"""App-library op log: ops and review items without a project (T61, D184)

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-15

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0009"
down_revision: Union[str, Sequence[str], None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.alter_column("op", "project_id", existing_type=sa.UUID(), nullable=True)
    op.alter_column("review_item", "project_id", existing_type=sa.UUID(), nullable=True)
    # The library log numbers its ops on its own (a NULL project_id is never "equal" in the
    # project-wide unique constraint).
    op.create_index(
        "uq_op_library_server_seq",
        "op",
        ["server_seq"],
        unique=True,
        postgresql_where=sa.text("project_id IS NULL"),
    )
    # A promoted type names its project type across streams: provenance, not a reference the
    # library push can wait for (the two logs commit separately).
    op.drop_constraint(
        "fk_library_type_promoted_from_id_library_type", "library_type", type_="foreignkey"
    )


def downgrade() -> None:
    """Downgrade schema (fails while library ops exist: they have no project)."""
    op.create_foreign_key(
        "fk_library_type_promoted_from_id_library_type",
        "library_type",
        "library_type",
        ["promoted_from_id"],
        ["id"],
        initially="DEFERRED",
        deferrable=True,
    )
    op.drop_index("uq_op_library_server_seq", table_name="op")
    op.alter_column("review_item", "project_id", existing_type=sa.UUID(), nullable=False)
    op.alter_column("op", "project_id", existing_type=sa.UUID(), nullable=False)
