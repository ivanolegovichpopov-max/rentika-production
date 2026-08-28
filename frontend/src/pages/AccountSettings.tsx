/**
 * "Личный кабинет" сотрудника — профиль (только чтение, эти поля меняются
 * через раздел «Сотрудники»/владельца) + смена собственного пароля + (ниже)
 * настройка двухфакторной аутентификации (TwoFactorSettings, без изменений).
 * Новая функция без аналога в демо-прототипе, часть запроса пользователя на
 * "личные кабинеты сотрудников".
 */
import { useRef, useState } from "react";
import { api, ApiError, setAccessToken } from "../api/client";
import { useAuth } from "../context/AuthContext";
import type { Business, Employee } from "../api/types";
import { colorFromId, initials } from "../lib/format";
import { TwoFactorSettings } from "./TwoFactorSettings";

// Ограничение на исходный файл ДО кодирования в base64 (сама data: URL
// строка получится примерно на треть больше) — грубый, но достаточный
// предохранитель: своего файлового хранилища у проекта нет (см. миграцию
// 0007), логотип хранится прямо в столбце businesses.logo_url, поэтому
// разумно не пускать туда файлы в несколько мегабайт.
const MAX_LOGO_BYTES = 300 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Логотип бизнеса — владелец загружает файл, он читается на фронте через
 * FileReader и шлётся на backend уже готовой строкой (data: URL), см.
 * миграцию 0007 и app/api/routes/businesses.py::update_business_logo.
 * Отдельного файлового хранилища (S3 и т.п.) у проекта нет, а деплой на
 * Render со свободным планом использует эфемерный диск — сознательный
 * компромисс для логотипа небольшого размера, а не файлов вроде документов
 * аренды. */
function BusinessLogoCard({
  businessId,
  logoUrl,
  onLogoChange,
}: {
  businessId: string;
  logoUrl: string | null;
  onLogoChange: (url: string | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Выберите файл изображения (PNG, JPG, SVG…)");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError(`Файл слишком большой (максимум ${Math.round(MAX_LOGO_BYTES / 1024)} КБ) — уменьшите изображение.`);
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const updated = await api.patch<Business>(`/businesses/${businessId}/logo`, { logo_url: dataUrl });
      onLogoChange(updated.logo_url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить логотип");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleRemove() {
    setError(null);
    setBusy(true);
    try {
      const updated = await api.patch<Business>(`/businesses/${businessId}/logo`, { logo_url: null });
      onLogoChange(updated.logo_url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось удалить логотип");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Логотип бизнеса</h2>
      <p className="muted">Показывается в левом верхнем углу вместо стандартной марки Rentika CRM — виден всей команде.</p>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 10 }}>
        <div className="logo-preview">
          {logoUrl ? <img src={logoUrl} alt="Логотип" /> : <span className="muted small">Нет логотипа</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          {logoUrl && (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void handleRemove()}>
              Убрать логотип
            </button>
          )}
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

function fmtMemberSince(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { year: "numeric", month: "long", day: "numeric" });
}

function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (next !== confirm) {
      setError("Новый пароль и подтверждение не совпадают");
      return;
    }
    setBusy(true);
    try {
      const resp = await api.post<{ access_token: string }>("/auth/change-password", {
        current_password: current,
        new_password: next,
      });
      // Смена пароля выпускает новую пару токенов (см. app/api/routes/auth.py) —
      // подставляем новый access-токен в память, иначе следующий же запрос
      // словил бы 401 от уже отозванного старого.
      setAccessToken(resp.access_token);
      setCurrent("");
      setNext("");
      setConfirm("");
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сменить пароль");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Смена пароля</h2>
      <p className="muted">
        После смены пароля все остальные сессии (другие устройства/браузеры) будут разлогинены — это устройство
        останется в системе.
      </p>
      <form onSubmit={submit} className="form-grid">
        <div className="field">
          <label>Текущий пароль</label>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
        <div className="field">
          <label>Новый пароль</label>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={12} required />
        </div>
        <div className="field">
          <label>Повторите новый пароль</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={12} required />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Сменить пароль
        </button>
      </form>
      {error && <div className="form-error">{error}</div>}
      {success && <div className="field-hint" style={{ color: "var(--good-ink)" }}>Пароль изменён.</div>}
    </div>
  );
}

export function AccountSettings({
  myEmployee,
  isOwner,
  businessName,
  businessId,
  logoUrl,
  onLogoChange,
}: {
  myEmployee: Employee | null;
  isOwner: boolean;
  businessName: string | null;
  businessId: string;
  logoUrl: string | null;
  onLogoChange: (url: string | null) => void;
}) {
  const { user } = useAuth();

  return (
    <>
      <div className="card">
        <h2>Профиль</h2>
        <div className="profile-head">
          <span className="avatar profile-avatar" style={{ background: colorFromId(myEmployee?.id ?? user?.id ?? "") }}>
            {initials(myEmployee?.name ?? user?.email ?? "?")}
          </span>
          <div>
            <div className="profile-name">{myEmployee?.name ?? "—"}</div>
            <div className="muted">{user?.email}</div>
          </div>
        </div>
        <div className="kv-grid" style={{ marginTop: 14 }}>
          <div className="muted">Бизнес</div>
          <div>{businessName ?? "—"}</div>
          <div className="muted">Роль</div>
          <div>{isOwner ? "Владелец бизнеса" : "Сотрудник"}</div>
          {myEmployee && (
            <>
              <div className="muted">В команде с</div>
              <div>{fmtMemberSince(myEmployee.created_at)}</div>
            </>
          )}
        </div>
      </div>

      {isOwner && <BusinessLogoCard businessId={businessId} logoUrl={logoUrl} onLogoChange={onLogoChange} />}

      <ChangePasswordCard />

      <TwoFactorSettings />
    </>
  );
}
