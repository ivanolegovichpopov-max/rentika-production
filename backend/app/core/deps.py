"""
Слой авторизации. Два независимых уровня проверки — по замыслу, не случайно:

1. Аутентификация (get_current_user) — кто ты вообще.
2. ACL по бизнесу (require_business_access) — что тебе можно в ЭТОМ бизнесе.

Плюс третий, независимый от кода уровень — RLS в самой Postgres (см.
app/database.py:set_tenant_context и alembic-миграцию). Даже если в каком-то
будущем эндпоинте забудут вызвать require_business_access, RLS не даст
получить чужие строки — это и есть defense-in-depth, тот же принцип, что был
в Supabase-версии (is_admin() внутри RLS-политик).
"""
import uuid

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import decode_token
from app.database import get_db, set_tenant_context
from app.models.business import LEVEL_ORDER, Employee, EmployeeStatus, PermissionLevel, Position, Permission, ResourceType
from app.models.user import User

bearer_scheme = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Требуется авторизация")
    try:
        payload = decode_token(credentials.credentials, expected_type="access")
    except ValueError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc

    user = db.get(User, uuid.UUID(payload["sub"]))
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Пользователь не найден или деактивирован")
    return user


async def require_platform_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_platform_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Только для администратора платформы")
    return user


class BusinessContext:
    """Результат разрешения доступа к бизнесу: сам Employee-объект (или None
    для платформенного админа, у которого членства может не быть) плюс флаг
    полного доступа."""

    def __init__(self, *, business_id: uuid.UUID, user: User, employee: Employee | None, full_access: bool):
        self.business_id = business_id
        self.user = user
        self.employee = employee
        self.full_access = full_access


async def get_business_context(
    business_id: uuid.UUID,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BusinessContext:
    """Достаётся один раз на запрос как FastAPI-зависимость с path-параметром
    business_id (роуты объявляются как `/businesses/{business_id}/...`).
    Одновременно включает RLS-контекст транзакции — после этого вызова любой
    ORM-запрос к equipment/clients/rentals/rental_items внутри ЭТОЙ же
    транзакции автоматически ограничен business_id на уровне БД."""
    set_tenant_context(db, str(business_id))

    if user.is_platform_admin:
        # Платформенный админ технически не обязан быть Employee — full_access
        # даём безусловно. НО если у него в ЭТОМ бизнесе всё же есть своя
        # запись Employee (типичный случай — его собственный бизнес,
        # созданный при регистрации), подставляем её в ctx.employee, а не
        # None: часть маршрутов (например создание записи в «Заметках»)
        # требует конкретного employee_id как автора действия, и админ не
        # должен упираться в «нет профиля сотрудника» там, где профиль
        # физически есть. Для чужого бизнеса, где Employee-записи нет,
        # ctx.employee корректно останется None — full_access всё равно даёт
        # доступ на чтение/модерацию, но не даёт «авторства» там, где оно
        # нужно (см. notes.py: без employee_id пост создать нельзя).
        admin_employee = db.scalar(
            select(Employee).where(Employee.business_id == business_id, Employee.user_id == user.id)
        )
        return BusinessContext(business_id=business_id, user=user, employee=admin_employee, full_access=True)

    employee = db.scalar(
        select(Employee).where(Employee.business_id == business_id, Employee.user_id == user.id)
    )
    if employee is None or employee.status != EmployeeStatus.active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Нет доступа к этому бизнесу")

    return BusinessContext(business_id=business_id, user=user, employee=employee, full_access=employee.is_owner)


def get_effective_permission(db: Session, employee: Employee, resource: ResourceType) -> PermissionLevel:
    if employee.is_owner:
        return PermissionLevel.edit
    if employee.position_id is None:
        return PermissionLevel.none
    perm = db.scalar(
        select(Permission).where(Permission.position_id == employee.position_id, Permission.resource == resource)
    )
    return perm.level if perm else PermissionLevel.none


def require_permission(resource: ResourceType, min_level: PermissionLevel):
    """Фабрика FastAPI-зависимостей: `Depends(require_permission(ResourceType.equipment, PermissionLevel.edit))`.
    Владелец бизнеса и платформенный админ всегда проходят без обращения к
    таблице Permission."""

    async def _dependency(
        ctx: BusinessContext = Depends(get_business_context),
        db: Session = Depends(get_db),
    ) -> BusinessContext:
        if ctx.full_access:
            return ctx
        assert ctx.employee is not None
        level = get_effective_permission(db, ctx.employee, resource)
        if LEVEL_ORDER[level] < LEVEL_ORDER[min_level]:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"Недостаточно прав: требуется «{min_level.value}» на «{resource.value}»",
            )
        return ctx

    return _dependency
