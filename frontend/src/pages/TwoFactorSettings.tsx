import { useState } from "react";
import { api, ApiError, getAccessToken } from "../api/client";
import { useAuth } from "../context/AuthContext";

export function TwoFactorSettings() {
  const { user, refreshUser } = useAuth();
  const [secret, setSecret] = useState<string | null>(null);
  const [provisioningUri, setProvisioningUri] = useState<string | null>(null);
  const [qrObjectUrl, setQrObjectUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disableCode, setDisableCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function startSetup() {
    setError(null);
    try {
      const resp = await api.post<{ secret: string; provisioning_uri: string }>("/auth/2fa/setup");
      setSecret(resp.secret);
      setProvisioningUri(resp.provisioning_uri);
      // <img src> не может отправить Authorization-заголовок — тянем PNG
      // вручную через fetch и превращаем в blob-URL для <img>.
      const qrResp = await fetch("/api/auth/2fa/qr.png", {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
        credentials: "include",
      });
      const blob = await qrResp.blob();
      setQrObjectUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось начать настройку");
    }
  }

  async function confirmSetup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const resp = await api.post<{ backup_codes: string[] }>("/auth/2fa/confirm", { code });
      setBackupCodes(resp.backup_codes);
      await refreshUser();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Неверный код");
    }
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/auth/2fa/disable", { code: disableCode });
      await refreshUser();
      setSecret(null);
      setBackupCodes(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Неверный код");
    }
  }

  // backupCodes проверяем ДО user?.totp_enabled (66-й проход, найдено при
  // проверке экрана обязательной 2FA): confirmSetup() сначала кладёт
  // backup-коды в локальный стейт, а затем вызывает refreshUser(), который
  // асинхронно обновляет user.totp_enabled на true. Если проверять
  // user?.totp_enabled первой веткой, то как только refreshUser()
  // отрабатывает, компонент навсегда переключается на карточку "2FA уже
  // включена" и только что показанные одноразовые backup-коды пропадают
  // с экрана раньше, чем пользователь успевает их сохранить — это
  // происходило даже в обычном профиле, не только на новом экране
  // обязательной 2FA. backupCodes сбрасывается только при повторном
  // отключении/включении 2FA (см. disable()), поэтому эта карточка
  // корректно остаётся, пока пользователь не уйдёт со страницы.
  if (backupCodes) {
    return (
      <div className="card">
        <h2>2FA включена — сохраните backup-коды</h2>
        <p className="muted">
          Каждый код можно использовать один раз, если телефон с приложением-аутентификатором
          недоступен. Сохраните их в надёжном месте — повторно они не показываются.
        </p>
        <pre className="backup-codes">{backupCodes.join("\n")}</pre>
      </div>
    );
  }

  if (user?.totp_enabled) {
    return (
      <div className="card">
        <h2>Двухфакторная аутентификация включена</h2>
        <p className="muted">
          Вход в аккаунт теперь требует код из приложения-аутентификатора (Google Authenticator,
          Microsoft Authenticator, Яндекс Ключ — подходит любое TOTP-приложение).
        </p>
        <form onSubmit={disable} className="inline-form">
          <input placeholder="Код для отключения" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} />
          <button type="submit" className="btn btn-danger">Отключить 2FA</button>
        </form>
        {error && <div className="form-error">{error}</div>}
      </div>
    );
  }

  if (secret) {
    return (
      <div className="card">
        <h2>Отсканируйте QR-код</h2>
        <p className="muted">
          Откройте Google Authenticator, Microsoft Authenticator или Яндекс Ключ и отсканируйте
          QR-код, либо введите секрет вручную: <code>{secret}</code>
        </p>
        {qrObjectUrl && <img alt="QR-код для настройки 2FA" src={qrObjectUrl} className="totp-qr" />}
        <p className="muted small">Provisioning URI (для отладки): {provisioningUri}</p>
        <form onSubmit={confirmSetup} className="inline-form">
          <input autoFocus placeholder="Код из приложения" value={code} onChange={(e) => setCode(e.target.value)} />
          <button type="submit" className="btn btn-primary">Подтвердить и включить</button>
        </form>
        {error && <div className="form-error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Двухфакторная аутентификация</h2>
      <p className="muted">
        Дополнительная защита входа кодом из приложения-аутентификатора. Совместимо с Google
        Authenticator, Microsoft Authenticator и Яндекс Ключ (стандарт TOTP, RFC 6238).
      </p>
      <button className="btn btn-primary" onClick={startSetup}>Включить 2FA</button>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}
