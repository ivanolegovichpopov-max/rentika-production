import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.deps import BusinessContext, get_business_context, get_current_user, require_platform_admin
from app.database import get_db
from app.models.business import Business, Employee
from app.models.user import User
from app.schemas.business import BusinessOut

router = APIRouter(prefix="/businesses", tags=["businesses"])


@router.get("", response_model=list[BusinessOut])
async def list_my_businesses(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Бизнесы, в которых пользователь состоит сотрудником (обычно один, но
    сотрудник в теории может работать в нескольких компаниях)."""
    ids = db.scalars(select(Employee.business_id).where(Employee.user_id == user.id)).all()
    if not ids:
        return []
    return db.scalars(select(Business).where(Business.id.in_(ids))).all()


@router.get("/{business_id}", response_model=BusinessOut)
async def get_business(business_id: uuid.UUID, ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)):
    return db.get(Business, business_id)


@router.get("/admin/all", response_model=list[BusinessOut], dependencies=[Depends(require_platform_admin)])
async def admin_list_all_businesses(db: Session = Depends(get_db)):
    """Только для Ивана: список всех бизнесов на платформе, для техподдержки/
    администрирования. Не проходит через RLS-контекст конкретного business_id
    осознанно — это единственное место, где нужен обзор сразу всех тенантов."""
    return db.scalars(select(Business)).all()
