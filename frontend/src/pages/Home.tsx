import { useAuth } from "../context/AuthContext";
import { BusinessProvider } from "../context/BusinessContext";
import { Dashboard } from "./Dashboard";
import { AdminBusinesses } from "./AdminBusinesses";

/** Точка ветвления: у платформенного админа (Ивана) обычно нет Employee ни в
 * одном бизнесе, поэтому обычный BusinessProvider/Dashboard ему не подходит —
 * он получает отдельный, свой экран. */
export function Home() {
  const { user } = useAuth();
  if (user?.is_platform_admin) return <AdminBusinesses />;
  return (
    <BusinessProvider>
      <Dashboard />
    </BusinessProvider>
  );
}
