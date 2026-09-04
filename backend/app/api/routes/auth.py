"""
Эндпоинты аутентификации. Регистрация здесь = «создать новый бизнес и стать
его владельцем» (в отличие от Supabase-версии, где первый зарегистрировавшийся
становился общим админом единственного бизнеса) — это ключевое отличие
production-модели: она мультитенантная, каждый /auth/register создаёт СВОЙ,
изолированный от остальных Business.
"""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.core.audit import log_action
from app.core.clock import to_aware, utcnow
from app.core.deps import get_current_user
from app.core.rate_limit import LOGIN_LIMIT, REGISTER_LIMIT, TOTP_VERIFY_LIMIT, limiter
from app.core.security import (
    PasswordPolicyError,
    create_access_token,
    create_totp_challenge_token,
    decode_token,
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    validate_password_policy,
    verify_password,
)
from app.core.totp import consume_backup_code, verify_totp_code
from app.database import get_db
from app.models.business import Business, Employee, EmployeeStatus
from app.models.user import RefreshToken, User
from app.schemas.auth import (
    ChangePasswordRequest,
    LoginRequest,
    LoginResponse,
    RegisterRequest,
    TokenResponse,
    TotpLoginRequest,
    UserOut,
)

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE_NAME = "rentika_refresh"


def _set_refresh_cookie(response: Response, raw_refresh_token: str) -> None:
    # SameSite=None обязателен, когда frontend и backend живут на разных
    # доменах (например frontend.onrender.com и backend.onrender.com) —
    # SameSite=Lax браузер вообще не отправит на fetch/XHR-запрос с другого
    # origin. Браузеры требуют Secure вместе с SameSite=None, поэтому это
    # включаем только в production (там всегда https); в dev/test остаётся
    # Lax+not-secure, как было — это same-origin окружение (Vite proxy /
    # httpx TestClient) и тесты уже полагаются на такое поведение.
    is_production = settings.environment == "production"
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=raw_refresh_token,
        httponly=True,
        secure=is_production,
        samesite="none" if is_production else "lax",
        max_age=settings.refresh_token_ttl_days * 24 * 3600,
        path="/api/auth",
    )


def _activate_invited_employees(db: Session, user: User) -> None:
    """Реальный сценарий invited -> active (66-й проход) — раньше
    EmployeeStatus.invited существовал только в модели/схемах: invite_employee
    (app/api/routes/employees.py) всегда сразу ставил status=active, так что
    invited был мёртвым кодом. Теперь invite_employee сохраняет invited, а
    первый успешный вход пользователя переводит ВСЕ его invited-членства во
    active сразу по всем бизнесам, куда его успели пригласить, а не только в
    том, в который он в итоге зайдёт. Безопасно вызывать именно отсюда (а не
    из get_business_context) — /auth/login и /auth/login/totp не
    business-scoped и не проходят через set_tenant_context/RLS, поэтому не
    нужно заранее знать business_id, чтобы активировать членство."""
    invited = db.scalars(
        select(Employee).where(Employee.user_id == user.id, Employee.status == EmployeeStatus.invited)
    ).all()
    for employee in invited:
        employee.status = EmployeeStatus.active
        log_action(
            db,
            business_id=employee.business_id,
            user_id=user.id,
            action="activate",
            resource="employee",
            resource_id=str(employee.id),
        )


def _issue_tokens(db: Session, user: User, response: Response) -> TokenResponse:
    raw_refresh, refresh_hash = generate_refresh_token()
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=refresh_hash,
            expires_at=utcnow() + timedelta(days=settings.refresh_token_ttl_days),
        )
    )
    db.commit()
    _set_refresh_cookie(response, raw_refresh)
    access_token = create_access_token(user_id=str(user.id), is_platform_admin=user.is_platform_admin)
    return TokenResponse(access_token=access_token, expires_in=settings.access_token_ttl_minutes * 60)


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit(REGISTER_LIMIT)
async def register(request: Request, body: RegisterRequest, response: Response, db: Session = Depends(get_db)):
    existing = db.scalar(select(User).where(User.email == body.email))
    if existing is not None:
        # Намеренно НЕ уточняем, что именно "email уже занят" — иначе эндпоинт
        # превращается в оракул для перебора зарегистрированных email-адресов.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Не удалось зарегистрироваться с этими данными")

    try:
        await validate_password_policy(body.password, email=body.email)
    except PasswordPolicyError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    is_platform_admin = bool(settings.platform_admin_email) and body.email.lower() == settings.platform_admin_email.lower()

    user = User(email=body.email, password_hash=hash_password(body.password), is_platform_admin=is_platform_admin)
    db.add(user)
    db.flush()

    business = Business(name=body.business_name, owner_user_id=user.id)
    db.add(business)
    db.flush()

    employee = Employee(business_id=business.id, user_id=user.id, name=body.business_name, is_owner=True)
    db.add(employee)

    log_action(
        db,
        business_id=business.id,
        user_id=user.id,
        action="register",
        resource="business",
        resource_id=str(business.id),
        ip_address=request.client.host if request.client else None,
    )
    db.commit()

    return _issue_tokens(db, user, response)


@router.post("/login", response_model=LoginResponse)
@limiter.limit(LOGIN_LIMIT)
async def login(request: Request, body: LoginRequest, response: Response, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == body.email))

    generic_error = HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный email или пароль")

    if user is None:
        raise generic_error

    if to_aware(user.locked_until) and to_aware(user.locked_until) > utcnow():
        raise HTTPException(status.HTTP_423_LOCKED, "Аккаунт временно заблокирован из-за подозрительных попыток входа")

    if not verify_password(body.password, user.password_hash):
        user.failed_login_attempts += 1
        if user.failed_login_attempts >= 10:
            user.locked_until = utcnow() + timedelta(minutes=15)
        db.commit()
        raise generic_error

    user.failed_login_attempts = 0

    if user.totp_enabled:
        # Это ещё не завершённый вход — только пароль подтверждён, TOTP-код
        # проверяется вторым шагом в /login/totp. last_login_at проставляем
        # только там, иначе "последний вход" будет врать при неудачном вводе
        # кода (или его отсутствии вовсе).
        db.commit()
        return LoginResponse(requires_totp=True, totp_challenge_token=create_totp_challenge_token(user_id=str(user.id)))

    user.last_login_at = utcnow()
    _activate_invited_employees(db, user)
    db.commit()

    tokens = _issue_tokens(db, user, response)
    return LoginResponse(requires_totp=False, access_token=tokens.access_token, expires_in=tokens.expires_in)


@router.post("/login/totp", response_model=TokenResponse)
@limiter.limit(TOTP_VERIFY_LIMIT)
async def login_totp(request: Request, body: TotpLoginRequest, response: Response, db: Session = Depends(get_db)):
    try:
        payload = decode_token(body.totp_challenge_token, expected_type="totp_challenge")
    except ValueError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc

    import uuid as _uuid

    user = db.get(User, _uuid.UUID(payload["sub"]))
    if user is None or not user.totp_enabled or not user.totp_secret:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Некорректный запрос")

    code_ok = verify_totp_code(secret=user.totp_secret, code=body.code)
    if not code_ok:
        updated_codes = consume_backup_code(user.totp_backup_codes, body.code)
        if updated_codes is not None:
            user.totp_backup_codes = updated_codes
            db.commit()
            code_ok = True

    if not code_ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный код двухфакторной аутентификации")

    user.last_login_at = utcnow()
    _activate_invited_employees(db, user)
    db.commit()

    return _issue_tokens(db, user, response)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(request: Request, response: Response, db: Session = Depends(get_db)):
    raw_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if not raw_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Нет refresh-токена")

    token_hash = hash_refresh_token(raw_token)
    stored = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    if stored is None or stored.revoked or to_aware(stored.expires_at) < utcnow():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Refresh-токен недействителен")

    # Ротация: старый токен сжигаем сразу — если кто-то смог его перехватить,
    # окно повторного использования равно нулю (иначе украденный токен работал
    # бы бесконечно долго).
    stored.revoked = True
    user = db.get(User, stored.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Пользователь не найден или деактивирован")

    return _issue_tokens(db, user, response)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    raw_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if raw_token:
        token_hash = hash_refresh_token(raw_token)
        stored = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
        if stored:
            stored.revoked = True
            db.commit()
    response.delete_cookie(REFRESH_COOKIE_NAME, path="/api/auth")


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)):
    return user


@router.post("/change-password", response_model=TokenResponse)
async def change_password(
    request: Request,
    response: Response,
    body: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Текущий пароль указан неверно")

    try:
        await validate_password_policy(body.new_password, email=user.email)
    except PasswordPolicyError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    user.password_hash = hash_password(body.new_password)

    # Смена пароля — сигнал "возможно, аккаунт был скомпрометирован", поэтому
    # отзываем ВСЕ существующие refresh-токены пользователя (все ДРУГИЕ
    # сессии/устройства разлогиниваются и должны войти заново с новым
    # паролем). Текущую же сессию не обрываем — сразу же выпускаем новую пару
    # токенов через _issue_tokens (ниже), как при обычном логине: иначе
    # получилось бы, что смена собственного пароля выкидывает из аккаунта и
    # самого пользователя, который её только что подтвердил своим текущим
    # паролем — неожиданное и недружелюбное поведение, не дающее лишней
    # защиты (только что введённый пароль уже был проверен).
    db.execute(
        RefreshToken.__table__.update().where(RefreshToken.user_id == user.id).values(revoked=True)
    )

    log_action(
        db,
        business_id=None,
        user_id=user.id,
        action="change_password",
        resource="user",
        resource_id=str(user.id),
        ip_address=request.client.host if request.client else None,
    )
    db.commit()

    return _issue_tokens(db, user, response)
