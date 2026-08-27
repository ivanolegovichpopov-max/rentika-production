"""
Небольшой хелпер вокруг timezone-aware datetime. Нужен из-за одной
особенности SQLite (используется в тестах, см. tests/conftest.py): колонка
`DateTime(timezone=True)` в Postgres честно хранит и возвращает aware-datetime,
а в SQLite — теряет tzinfo при обратном чтении и возвращает naive datetime.
Сравнение naive и aware datetime бросает TypeError, поэтому перед любым
сравнением "давности" мы приводим обе стороны к aware UTC через to_aware().
"""
from datetime import datetime, timezone


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def to_aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
