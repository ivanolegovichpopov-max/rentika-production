"""
Пароли и токены. Дизайн-решения (см. PRODUCTION_ARCHITECTURE.md §5):

- Хэширование — Argon2id (argon2-cffi), победитель Password Hashing Competition,
  рекомендован OWASP как приоритетный вариант. НЕ bcrypt/НЕ голый sha256.
- Политика пароля — NIST SP 800-63B (2024): длина важнее сложности, никаких
  принудительных "минимум 1 цифра/1 спецсимвол" (это доказанно ухудшает
  реальную стойкость — пользователи пишут "Password1!" и подобное), зато:
  минимум 12 символов, проверка по списку самых частых утечённых паролей,
  без принудительной периодической смены.
- JWT в заголовке Authorization, не в cookie — так access-токен не участвует
  в CSRF-атаках (никакой сторонний сайт не может заставить браузер добавить
  его сам). Refresh-токен — в httpOnly-cookie (см. app/api/routes/auth.py),
  потому что он живёт дольше и не должен быть доступен JS (защита от XSS).
"""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import httpx
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from jose import JWTError, jwt

from app.config import settings

_hasher = PasswordHasher()

# Небольшой локальный список — первая линия защиты, срабатывает мгновенно и
# без сети даже если HIBP недоступен/отключён.
_COMMON_PASSWORDS = {
    "password", "password123", "12345678", "123456789", "qwerty123",
    "admin12345", "letmein123", "iloveyou1", "qwertyuiop", "111111111",
    "password1", "passw0rd", "welcome123",
}


class PasswordPolicyError(ValueError):
    pass


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


async def check_password_pwned(password: str) -> int:
    """k-anonymity запрос к Have I Been Pwned: наружу уходят только первые
    5 символов SHA1-хэша пароля, сам пароль и полный хэш никогда не покидают
    сервер. Возвращает число известных утечек (0 = не найден). При недоступности
    сети — не блокирует регистрацию (fail-open), это дополнительная, а не
    единственная линия защиты."""
    sha1 = hashlib.sha1(password.encode("utf-8")).hexdigest().upper()
    prefix, suffix = sha1[:5], sha1[5:]
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"https://api.pwnedpasswords.com/range/{prefix}")
            resp.raise_for_status()
        for line in resp.text.splitlines():
            candidate_suffix, count = line.split(":")
            if candidate_suffix == suffix:
                return int(count)
        return 0
    except (httpx.HTTPError, ValueError):
        return 0


async def validate_password_policy(password: str, *, email: str | None = None) -> None:
    if len(password) < settings.password_min_length:
        raise PasswordPolicyError(f"Пароль должен быть не короче {settings.password_min_length} символов")
    if len(password) > settings.password_max_length:
        raise PasswordPolicyError(f"Пароль слишком длинный (максимум {settings.password_max_length} символов)")
    if password.lower() in _COMMON_PASSWORDS:
        raise PasswordPolicyError("Этот пароль слишком часто встречается в утечках — выберите другой")
    if email and password.lower() == email.lower():
        raise PasswordPolicyError("Пароль не должен совпадать с email")
    if settings.password_check_hibp:
        breach_count = await check_password_pwned(password)
        if breach_count > 0:
            raise PasswordPolicyError(
                "Этот пароль встречается в известных утечках данных — выберите другой"
            )


# --- JWT access-токены ---

def create_access_token(*, user_id: str, is_platform_admin: bool) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "admin": is_platform_admin,
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_ttl_minutes),
        "type": "access",
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_totp_challenge_token(*, user_id: str) -> str:
    """Промежуточный токен, выдаётся после верного пароля, но до ввода
    TOTP-кода — короткоживущий (2 минуты), ничего кроме права пройти второй
    фактор не даёт (type="totp_challenge", отдельно проверяется)."""
    now = datetime.now(timezone.utc)
    payload = {"sub": user_id, "iat": now, "exp": now + timedelta(minutes=2), "type": "totp_challenge"}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str, *, expected_type: str) -> dict:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError as exc:
        raise ValueError("Невалидный или истёкший токен") from exc
    if payload.get("type") != expected_type:
        raise ValueError("Токен неверного типа")
    return payload


# --- Refresh-токены (opaque, хранится хэш) ---

def generate_refresh_token() -> tuple[str, str]:
    """Возвращает (значение_для_клиента, хэш_для_БД)."""
    raw = secrets.token_urlsafe(48)
    return raw, hash_refresh_token(raw)


def hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
