import { BusinessProvider } from "../context/BusinessContext";
import { Dashboard } from "./Dashboard";

/**
 * Раньше здесь было ветвление: платформенный админ (Иван) получал только
 * read-only AdminBusinesses и не мог попасть в саму CRM. На практике это
 * оказалось тупиком — /auth/register ВСЕГДА создаёт бизнес и Employee
 * (is_owner=true) для регистрирующегося пользователя, даже если его email
 * совпадает с PLATFORM_ADMIN_EMAIL, так что у Ивана есть собственный бизнес
 * ("Rentika") точно так же, как у любого другого пользователя. Поэтому
 * теперь ВСЕ пользователи (включая платформенного админа) попадают в обычный
 * Dashboard — а обзор всех бизнесов платформы для админа встроен туда же
 * отдельным пунктом навигации "Все бизнесы" (см. Dashboard.tsx,
 * AdminOverviewTab.tsx), а не отдельным экраном без доступа к CRM.
 */
export function Home() {
  return (
    <BusinessProvider>
      <Dashboard />
    </BusinessProvider>
  );
}
