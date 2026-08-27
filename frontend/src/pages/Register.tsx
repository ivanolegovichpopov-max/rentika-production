import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../api/client";

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register(email, password, businessName);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось зарегистрироваться");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>Регистрация бизнеса</h1>
        <p className="muted">
          Вы станете владельцем нового изолированного пространства в RENTIKA CRM — сможете
          добавлять сотрудников, оборудование и клиентов.
        </p>
        <label>
          Название компании
          <input required value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
        </label>
        <label>
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Пароль
          <input type="password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <p className="muted small">Минимум 12 символов. Мы проверим пароль по базе известных утечек.</p>
        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="btn btn-primary" disabled={busy}>Создать бизнес</button>
        <p className="muted">
          Уже есть аккаунт? <Link to="/login">Войти</Link>
        </p>
      </form>
    </div>
  );
}
