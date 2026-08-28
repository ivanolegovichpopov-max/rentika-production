import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { Client, Equipment, EquipmentCategory, Rental } from "../api/types";

/**
 * Общее хранилище оборудования/клиентов/аренд текущего бизнеса — аналог
 * единого объекта `state` в демо-прототипе. Дашборду и «Финансам» нужны все
 * три списка одновременно (кросс-сущностные агрегаты — топ оборудования по
 * доходу, клиенты в зоне риска и т.д.), так что тянуть их в контекст один
 * раз и раздавать всем вкладкам проще и дешевле по трафику, чем чтобы
 * каждая вкладка запрашивала своё отдельно, как было раньше (Equipment/
 * Clients-вкладки самостоятельно грузили только свой список).
 *
 * equipmentCategories добавлен в тринадцатом проходе вместе со справочником
 * категорий — грузится тем же способом (в общем reload() + отдельный
 * reloadEquipmentCategories для точечного обновления после создания новой
 * категории/CSV-импорта, не перезагружая остальные три списка).
 */
interface DataContextValue {
  equipment: Equipment[];
  equipmentCategories: EquipmentCategory[];
  clients: Client[];
  rentals: Rental[];
  loading: boolean;
  reload: () => Promise<void>;
  reloadEquipment: () => Promise<void>;
  reloadEquipmentCategories: () => Promise<void>;
  reloadClients: () => Promise<void>;
  reloadRentals: () => Promise<void>;
}

const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ businessId, children }: { businessId: string; children: ReactNode }) {
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [equipmentCategories, setEquipmentCategories] = useState<EquipmentCategory[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [loading, setLoading] = useState(true);

  async function reloadEquipment() {
    setEquipment(await api.get<Equipment[]>(`/businesses/${businessId}/equipment`));
  }
  async function reloadEquipmentCategories() {
    setEquipmentCategories(await api.get<EquipmentCategory[]>(`/businesses/${businessId}/equipment-categories`));
  }
  async function reloadClients() {
    setClients(await api.get<Client[]>(`/businesses/${businessId}/clients`));
  }
  async function reloadRentals() {
    setRentals(await api.get<Rental[]>(`/businesses/${businessId}/rentals`));
  }

  async function reload() {
    setLoading(true);
    try {
      const [eq, cats, cl, re] = await Promise.all([
        api.get<Equipment[]>(`/businesses/${businessId}/equipment`),
        api.get<EquipmentCategory[]>(`/businesses/${businessId}/equipment-categories`),
        api.get<Client[]>(`/businesses/${businessId}/clients`),
        api.get<Rental[]>(`/businesses/${businessId}/rentals`),
      ]);
      setEquipment(eq);
      setEquipmentCategories(cats);
      setClients(cl);
      setRentals(re);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  return (
    <DataContext.Provider
      value={{
        equipment,
        equipmentCategories,
        clients,
        rentals,
        loading,
        reload,
        reloadEquipment,
        reloadEquipmentCategories,
        reloadClients,
        reloadRentals,
      }}
    >
      {children}
    </DataContext.Provider>
  );
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData должен использоваться внутри DataProvider");
  return ctx;
}
