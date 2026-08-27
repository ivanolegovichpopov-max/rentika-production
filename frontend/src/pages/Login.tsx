import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../api/client";

export function Login() {
  const { login, loginTotp } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpChallengeToken, setTotpChallengeToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await login(email, password);
      if (result.requiresTotp) {
        setTotpChallengeToken(result.totpChallengeToken ?? null);
      } else {
        navigate("/");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  }

  async function handleTotpSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!totpChallengeToken) return;
    setError(null);
    setBusy(true);
    try {
      await loginTotp(totpChallengeToken, code);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Неверный код");
    } finally {
      setBusy(false);
    }
  }

  if (totpChallengeToken) {
    return (
      <div className="auth-screen">
        <form className="auth-card" onSubmit={handleTotpSubmit}>
          <h1>Код подтверждения</h1>
          <p className="muted">Введите код из приложения-аутентификатора (Google Authenticator, Microsoft Authenticator, Яндекс Ключ) или backup-код.</p>
          <input autoFocus placeholder="000000" value={code} onChange={(e) => setCode(e.target.value)} />
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={busy}>Подтвердить</button>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>RENTIKA CRM</h1>
        <label>
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Пароль
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="btn btn-primary" disabled={busy}>Войти</button>
        <p className="muted">
          Нет аккаунта? <Link to="/register">Зарегистрировать свой бизнес</Link>
        </p>
      </form>
    </div>
  );
}
