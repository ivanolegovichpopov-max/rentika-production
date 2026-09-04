import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { Business } from "../api/types";
import { useAuth } from "./AuthContext";

interface BusinessContextValue {
  businesses: Business[];
  currentBusinessId: string | null;
  setCurrentBusinessId: (id: string) => void;
  loading: boolean;
  reload: () => Promise<void>;
}

const BusinessContext = createContext<BusinessContextValue | null>(null);

export function BusinessProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [currentBusinessId, setCurrentBusinessId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    setLoading(true);
    try {
      const list = await api.get<Business[]>("/businesses");
      setBusinesses(list);
      setCurrentBusinessId((prev) => prev ?? list[0]?.id ?? null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user) void reload();
    else {
      setBusinesses([]);
      setCurrentBusinessId(null);
      setLoading(false);
    }
    // Зависимость — user?.id, а не весь объект user (66-й проход, найдено
    // при проверке экрана обязательной 2FA): refreshUser() в AuthContext
    // возвращает новый объект User при КАЖДОМ вызове (после /auth/2fa/confirm,
    // /auth/2fa/disable, смены пароля и т.п.), даже если сам пользователь не
    // менялся. С зависимостью [user] это приводило к лишней перезагрузке
    // списка бизнесов (loading=true -> false) на каждое такое событие, а
    // Dashboard.tsx на время loading=true подменяет всё дерево на "Загрузка…",
    // размонтируя всё внутри — включая, например, TwoFactorSettings с только
    // что показанными backup-кодами, которые пользователь ещё не успел
    // сохранить. user?.id меняется только при реальном логине/логауте.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return (
    <BusinessContext.Provider value={{ businesses, currentBusinessId, setCurrentBusinessId, loading, reload }}>
      {children}
    </BusinessContext.Provider>
  );
}

export function useBusiness() {
  const ctx = useContext(BusinessContext);
  if (!ctx) throw new Error("useBusiness должен использоваться внутри BusinessProvider");
  return ctx;
}
