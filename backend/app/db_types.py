"""
Кросс-диалектный UUID-тип: нативный `uuid` в Postgres (production и
docker-compose), обычный CHAR(32) в SQLite (используется только в тестах —
см. tests/conftest.py). Без этого модели пришлось бы дублировать под тесты,
а postgresql.UUID из sqlalchemy.dialects не рендерится на SQLite вообще.
Стандартный рецепт из документации SQLAlchemy.
"""
import uuid

from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.types import CHAR, TypeDecorator


class GUID(TypeDecorator):
    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PG_UUID(as_uuid=True))
        return dialect.type_descriptor(CHAR(32))

    def process_bind_param(self, value, dialect):
        if value is None:
            return value
        if dialect.name == "postgresql":
            return str(value)
        if not isinstance(value, uuid.UUID):
            value = uuid.UUID(value)
        return value.hex

    def process_result_value(self, value, dialect):
        if value is None:
            return value
        if isinstance(value, uuid.UUID):
            return value
        return uuid.UUID(value)
