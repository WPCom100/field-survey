import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, MetaData, create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings

NAMING = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)
    type_annotation_map = {
        uuid.UUID: UUID(as_uuid=True),
        datetime: DateTime(timezone=True),
        dict[str, Any]: JSONB,
        list[Any]: JSONB,
    }


engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(engine, expire_on_commit=False)
