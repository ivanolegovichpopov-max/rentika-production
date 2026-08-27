from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import get_current_user
from app.core.totp import (
    build_provisioning_uri,
    encode_backup_codes_for_storage,
    generate_backup_codes,
    generate_totp_secret,
    qr_code_png_bytes,
    verify_totp_code,
)
from app.database import get_db
from app.models.user import User
from app.schemas.auth import TotpConfirmRequest, TotpConfirmResponse, TotpSetupResponse

router = APIRouter(prefix="/auth/2fa", tags=["2fa"])


@router.post("/setup", response_model=TotpSetupResponse)
async def setup_totp(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Генерирует новый секрет и возвращает его вместе с provisioning-URI
    (для рендера QR-кода на фронтенде). 2FA считается включённой только
    после успешного /confirm — до этого секрет хранится, но totp_enabled
    остаётся False, так что просто вызов /setup не может случайно запереть
    пользователя без второго фактора."""
    if user.totp_enabled:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Двухфакторная аутентификация уже включена")

    secret = generate_totp_secret()
    user.totp_secret = secret
    db.commit()

    return TotpSetupResponse(secret=secret, provisioning_uri=build_provisioning_uri(secret=secret, email=user.email))


@router.get("/qr.png")
async def totp_qr_png(user: User = Depends(get_current_user)):
    if not user.totp_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Сначала вызовите /auth/2fa/setup")
    uri = build_provisioning_uri(secret=user.totp_secret, email=user.email)
    return Response(content=qr_code_png_bytes(uri), media_type="image/png")


@router.post("/confirm", response_model=TotpConfirmResponse)
async def confirm_totp(
    body: TotpConfirmRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    if not user.totp_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Сначала вызовите /auth/2fa/setup")
    if not verify_totp_code(secret=user.totp_secret, code=body.code):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Неверный код — проверьте время на устройстве")

    backup_codes = generate_backup_codes()
    user.totp_enabled = True
    user.totp_backup_codes = encode_backup_codes_for_storage(backup_codes)
    log_action(db, user_id=user.id, action="2fa_enabled", resource="user", resource_id=str(user.id))
    db.commit()

    return TotpConfirmResponse(backup_codes=backup_codes)


@router.post("/disable", status_code=status.HTTP_204_NO_CONTENT)
async def disable_totp(
    body: TotpConfirmRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Требует действующий TOTP-код для отключения — иначе захваченная на
    короткое время сессия (украденный access-токен) могла бы снять 2FA и
    закрепиться в аккаунте надолго."""
    if not user.totp_enabled or not user.totp_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Двухфакторная аутентификация не включена")
    if not verify_totp_code(secret=user.totp_secret, code=body.code):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Неверный код")

    user.totp_enabled = False
    user.totp_secret = None
    user.totp_backup_codes = None
    log_action(db, user_id=user.id, action="2fa_disabled", resource="user", resource_id=str(user.id))
    db.commit()
