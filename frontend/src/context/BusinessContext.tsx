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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

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
