from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.deps import BusinessContext, get_business_context
from app.database import get_db
from app.schemas.business import DashboardPrefs

router = APIRouter(prefix="/businesses/{business_id}/dashboard-prefs", tags=["dashboard"])


@router.get("", response_model=DashboardPrefs)
async def get_dashboard_prefs(ctx: BusinessContext = Depends(get_business_context)):
    """Личная настройка дашборда ТЕКУЩЕГО пользователя в этом бизнесе (скрытые
    плашки/панели + переименованные подписи) — не требует отдельного ACL-права,
    т.к. это чисто персональная настройка отображения, не бизнес-данные, и
    каждый сотрудник может настраивать только свою собственную (см. ctx.employee,
    привязан к текущему пользователю через get_business_context)."""
    if ctx.employee is None or not ctx.employee.dashboard_prefs:
        return DashboardPrefs()
    return DashboardPrefs.model_validate_json(ctx.employee.dashboard_prefs)


@router.put("", response_model=DashboardPrefs)
async def set_dashboard_prefs(
    body: DashboardPrefs,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    if ctx.employee is None:
        # Платформенный админ без своего Employee в этом бизнесе (в норме такого
        # не бывает — /auth/register всегда заводит Employee даже для него, но
        # на случай будущих сценариев без членства сохранять настройку некуда).
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "У вас нет собственного профиля сотрудника в этом бизнесе")
    ctx.employee.dashboard_prefs = body.model_dump_json()
    db.commit()
    return body
