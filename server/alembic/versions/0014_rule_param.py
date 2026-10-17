"""rule_param (T102, D176, D211)

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-16

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0014"
down_revision: Union[str, Sequence[str], None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "rule_param",
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("rule_id", sa.String(), nullable=False),
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("state", sa.String(), server_default="accepted", nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("version", sa.Integer(), server_default="0", nullable=False),
        sa.Column("head_seq", sa.BigInteger(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_by_id", sa.UUID(), nullable=True),
        sa.Column("delete_reason", sa.String(), nullable=True),
        sa.CheckConstraint(
            "state IN ('draft', 'accepted', 'rejected')", name=op.f("ck_rule_param_state")
        ),
        sa.ForeignKeyConstraint(
            ["deleted_by_id"],
            ["app_user.id"],
            name=op.f("fk_rule_param_deleted_by_id_app_user"),
            initially="DEFERRED",
            deferrable=True,
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["project.id"],
            name=op.f("fk_rule_param_project_id_project"),
            initially="DEFERRED",
            deferrable=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_rule_param")),
    )
    op.create_index(op.f("ix_rule_param_project_id"), "rule_param", ["project_id"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_rule_param_project_id"), table_name="rule_param")
    op.drop_table("rule_param")
