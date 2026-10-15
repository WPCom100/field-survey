"""export: one active export per project and kind, and Cancel (T93, D166)

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-14

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0007"
down_revision: Union[str, Sequence[str], None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("export", sa.Column("cancel_requested_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("export", sa.Column("cancelled_by_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_export_cancelled_by_id_app_user"), "export", "app_user", ["cancelled_by_id"], ["id"], initially="DEFERRED", deferrable=True
    )
    # Exports queued behind an older one of the same project and kind (TP-3, close-out G-4) are
    # cancelled, so the index below can hold: the oldest active one keeps its place.
    op.execute(
        """
        UPDATE export SET job_state = 'cancelled',
          stats = coalesce(stats, '{}'::jsonb)
            || jsonb_build_object('cancelled', 'one export at a time (T93)',
                                  'finished_at', to_char(now() AT TIME ZONE 'UTC',
                                                         'YYYY-MM-DD"T"HH24:MI:SS"+00:00"'))
        WHERE job_state IN ('queued', 'running') AND id NOT IN (
          SELECT DISTINCT ON (project_id, kind) id FROM export
          WHERE job_state IN ('queued', 'running')
          ORDER BY project_id, kind, created_at, id
        )
        """
    )
    op.create_index(
        "ux_export_active",
        "export",
        ["project_id", "kind"],
        unique=True,
        postgresql_where=sa.text("job_state IN ('queued', 'running')"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ux_export_active", table_name="export")
    op.drop_constraint(op.f("fk_export_cancelled_by_id_app_user"), "export", type_="foreignkey")
    op.drop_column("export", "cancelled_by_id")
    op.drop_column("export", "cancel_requested_at")
