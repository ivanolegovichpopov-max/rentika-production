/**
 * "Личный кабинет" сотрудника — профиль (только чтение, эти поля меняются
 * через раздел «Сотрудники»/владельца) + смена собственного пароля + (ниже)
 * настройка двухфакторной аутентификации (TwoFactorSettings, без изменений).
 * Новая функция без аналога в демо-прототипе, часть запроса пользователя на
 * "личные кабинеты сотрудников".
 */
import { useState } from "react";
import { api, ApiError, setAccessToken } from "../api/client";
import { useAuth } from "../context/AuthContext";
import type { Employee } from "../api/types";
import { colorFromId, initials } from "../lib/format";
import { TwoFactorSettings } from "./TwoFactorSettings";

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
}: {
  myEmployee: Employee | null;
  isOwner: boolean;
  businessName: string | null;
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

      <ChangePasswordCard />

      <TwoFactorSettings />
    </>
  );
}
