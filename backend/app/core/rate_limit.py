"""
Rate limiting через slowapi + Redis (общее состояние между несколькими
инстансами backend, не in-memory — иначе за балансировщиком лимит не работал
бы). Настроено на чувствительные к перебору эндпоинты: логин, регистрацию,
проверку TOTP-кода, запрос сброса пароля.
"""
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import settings

limiter = Limiter(key_func=get_remote_address, storage_uri=settings.redis_url)

LOGIN_LIMIT = "20/minute"
REGISTER_LIMIT = "5/hour"
TOTP_VERIFY_LIMIT = "20/minute"
