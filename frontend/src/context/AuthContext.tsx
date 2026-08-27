import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setAccessToken, setUnauthorizedHandler } from "../api/client";
import type { User } from "../api/types";

interface LoginResult {
  requiresTotp: boolean;
  totpChallengeToken?: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  loginTotp: (totpChallengeToken: string, code: string) => Promise<void>;
  register: (email: string, password: string, businessName: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  async function refreshUser() {
    try {
      const me = await api.get<User>("/auth/me");
      setUser(me);
    } catch {
      setUser(null);
    }
  }

  useEffect(() => {
    // При загрузке страницы access-токена в памяти ещё нет (см. api/client.ts) —
    // пытаемся молча восстановить сессию из httpOnly refresh-cookie.
    (async () => {
      const ok = await api.tryRefresh().catch(() => false);
      if (ok) await refreshUser();
      setLoading(false);
    })();

    setUnauthorizedHandler(() => {
      setAccessToken(null);
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  async function login(email: string, password: string): Promise<LoginResult> {
    const resp = await api.post<{
      requires_totp: boolean;
      access_token?: string;
      totp_challenge_token?: string;
    }>("/auth/login", { email, password });

    if (resp.requires_totp) {
      return { requiresTotp: true, totpChallengeToken: resp.totp_challenge_token };
    }
    setAccessToken(resp.access_token!);
    await refreshUser();
    return { requiresTotp: false };
  }

  async function loginTotp(totpChallengeToken: string, code: string) {
    const resp = await api.post<{ access_token: string }>("/auth/login/totp", {
      totp_challenge_token: totpChallengeToken,
      code,
    });
    setAccessToken(resp.access_token);
    await refreshUser();
  }

  async function register(email: string, password: string, businessName: string) {
    const resp = await api.post<{ access_token: string }>("/auth/register", {
      email,
      password,
      business_name: businessName,
    });
    setAccessToken(resp.access_token);
    await refreshUser();
  }

  async function logout() {
    await api.post("/auth/logout").catch(() => undefined);
    setAccessToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, loginTotp, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth должен использоваться внутри AuthProvider");
  return ctx;
}
