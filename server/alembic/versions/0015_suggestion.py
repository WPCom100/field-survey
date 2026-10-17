"""suggestion (T99, D174, D212)

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-16

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0015"
down_revision: Union[str, Sequence[str], None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "suggestion",
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("scope", sa.String(), nullable=False),
        sa.Column("ref", sa.String(), nullable=False),
        sa.Column("target", sa.String(), nullable=False),
        sa.Column("text", sa.String(), nullable=False),
        sa.Column("state", sa.String(), server_default="draft", nullable=False),
        sa.Column("created_by_id", sa.UUID(), nullable=True),
        sa.Column("promoted_from_id", sa.UUID(), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("version", sa.Integer(), server_default="0", nullable=False),
        sa.Column("head_seq", sa.BigInteger(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_by_id", sa.UUID(), nullable=True),
        sa.Column("delete_reason", sa.String(), nullable=True),
        sa.CheckConstraint(
            "scope IN ('type', 'category', 'code')", name=op.f("ck_suggestion_scope")
        ),
        sa.CheckConstraint(
            "target IN ('device_note', 'connection_note', 'punch_item', 'part')",
            name=op.f("ck_suggestion_target"),
        ),
        sa.CheckConstraint(
            "state IN ('draft', 'accepted', 'rejected')", name=op.f("ck_suggestion_state")
        ),
        sa.ForeignKeyConstraint(
            ["created_by_id"],
            ["app_user.id"],
            name=op.f("fk_suggestion_created_by_id_app_user"),
            initially="DEFERRED",
            deferrable=True,
        ),
        sa.ForeignKeyConstraint(
            ["deleted_by_id"],
            ["app_user.id"],
            name=op.f("fk_suggestion_deleted_by_id_app_user"),
            initially="DEFERRED",
            deferrable=True,
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["project.id"],
            name=op.f("fk_suggestion_project_id_project"),
            initially="DEFERRED",
            deferrable=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_suggestion")),
    )
    op.create_index(op.f("ix_suggestion_project_id"), "suggestion", ["project_id"], unique=False)
    op.create_index(op.f("ix_suggestion_ref"), "suggestion", ["ref"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_suggestion_ref"), table_name="suggestion")
    op.drop_index(op.f("ix_suggestion_project_id"), table_name="suggestion")
    op.drop_table("suggestion")
