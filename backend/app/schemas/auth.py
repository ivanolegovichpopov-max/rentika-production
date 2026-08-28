import uuid

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)
    business_name: str = Field(min_length=1, max_length=255)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class LoginResponse(BaseModel):
    """Если у пользователя включена 2FA, access_token не выдаётся сразу —
    вместо этого приходит totp_challenge_token, который нужно предъявить в
    /auth/login/totp вместе с кодом из приложения-аутентификатора."""

    requires_totp: bool
    access_token: str | None = None
    totp_challenge_token: str | None = None
    expires_in: int | None = None


class TotpLoginRequest(BaseModel):
    totp_challenge_token: str
    # 6 цифр для обычного TOTP-кода, либо backup-код вида "xxxxxxxx-xxxxxxxx"
    # (см. app/core/totp.py:generate_backup_codes) — отсюда более широкий диапазон.
    code: str = Field(min_length=6, max_length=32)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class TotpSetupResponse(BaseModel):
    secret: str
    provisioning_uri: str


class TotpConfirmRequest(BaseModel):
    code: str = Field(min_length=6, max_length=6)


class TotpConfirmResponse(BaseModel):
    backup_codes: list[str]


class UserOut(BaseModel):
    id: uuid.UUID
    email: EmailStr
    is_platform_admin: bool
    totp_enabled: bool

    model_config = {"from_attributes": True}


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=1, max_length=128)
