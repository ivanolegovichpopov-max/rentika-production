from sqlalchemy.orm import Session

from app.models.audit import AuditLog


def log_action(
    db: Session,
    *,
    business_id=None,
    user_id=None,
    action: str,
    resource: str,
    resource_id: str | None = None,
    meta: dict | None = None,
    ip_address: str | None = None,
) -> None:
    db.add(
        AuditLog(
            business_id=business_id,
            user_id=user_id,
            action=action,
            resource=resource,
            resource_id=resource_id,
            meta=meta,
            ip_address=ip_address,
        )
    )
