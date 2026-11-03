"""device.ip_address / dmx_address, library_type.needs_ip_address / needs_dmx_address (T146, D245)

Revision ID: 0020
Revises: 0019
Create Date: 2026-11-03

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0020"
down_revision: Union[str, Sequence[str], None] = "0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("device", sa.Column("ip_address", sa.String(length=15), nullable=True))
    op.add_column("device", sa.Column("dmx_address", sa.String(length=12), nullable=True))
    op.create_index(op.f("ix_device_ip_address"), "device", ["ip_address"], unique=False)
    op.create_index(op.f("ix_device_dmx_address"), "device", ["dmx_address"], unique=False)
    op.add_column("library_type", sa.Column("needs_ip_address", sa.Boolean(), nullable=True))
    op.add_column("library_type", sa.Column("needs_dmx_address", sa.Boolean(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("library_type", "needs_dmx_address")
    op.drop_column("library_type", "needs_ip_address")
    op.drop_index(op.f("ix_device_dmx_address"), table_name="device")
    op.drop_index(op.f("ix_device_ip_address"), table_name="device")
    op.drop_column("device", "dmx_address")
    op.drop_column("device", "ip_address")
