"""
TOTP-2FA (RFC 6238) — тот же стандарт, что используют Google Authenticator,
Microsoft Authenticator и Яндекс Ключ, поэтому подключение пользователю не
нужно как-то по-особому объяснять под конкретное приложение: любое из них
сканирует один и тот же QR-код (otpauth://) или принимает один и тот же
base32-секрет вручную.
"""
import hashlib
import io
import secrets

import pyotp
import qrcode

from app.config import settings


def generate_totp_secret() -> str:
    return pyotp.random_base32()


def build_provisioning_uri(*, secret: str, email: str) -> str:
    return pyotp.totp.TOTP(secret).provisioning_uri(name=email, issuer_name=settings.totp_issuer)


def qr_code_png_bytes(provisioning_uri: str) -> bytes:
    img = qrcode.make(provisioning_uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def verify_totp_code(*, secret: str, code: str) -> bool:
    # valid_window=1 — допускает код из соседнего 30-секундного окна, чтобы
    # небольшой рассинхрон часов на телефоне не блокировал вход наглухо.
    return pyotp.TOTP(secret).verify(code, valid_window=1)


def generate_backup_codes(count: int = 10) -> list[str]:
    """Человекочитаемые одноразовые коды на случай утери телефона.
    Возвращает СЫРЫЕ значения — показываются пользователю один раз, в БД
    хранятся только их хэши (см. hash_backup_code)."""
    return [f"{secrets.token_hex(4)}-{secrets.token_hex(4)}" for _ in range(count)]


def hash_backup_code(code: str) -> str:
    return hashlib.sha256(code.strip().lower().encode("utf-8")).hexdigest()


def encode_backup_codes_for_storage(codes: list[str]) -> str:
    import json

    return json.dumps([hash_backup_code(c) for c in codes])


def consume_backup_code(stored_json: str | None, submitted_code: str) -> str | None:
    """Проверяет код и возвращает обновлённый JSON БЕЗ использованного кода
    (одноразовость), либо None если код не найден/список пуст."""
    import json

    if not stored_json:
        return None
    hashes = json.loads(stored_json)
    target = hash_backup_code(submitted_code)
    if target not in hashes:
        return None
    hashes.remove(target)
    return json.dumps(hashes)
