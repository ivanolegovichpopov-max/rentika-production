/**
 * RentalDetailPanel (слайд-панель с деталями аренды) — новое в 39-м проходе,
 * по итогам обзора вкладки "Аренды": у Клиентов и Оборудования есть детальная
 * карточка с разбивкой, у Аренд её не было вообще — сама карточка в списке
 * (.rental-card) показывает только самое основное (клиент, позиции одной
 * строкой, суммарно даты и итог), а куда именно ушла сумма (плановые дни vs
 * просрочка vs повреждения vs скидка), какая ставка у каждой позиции
 * отдельно и что записано в заметках при выдаче/возврате — узнать было
 * нельзя, не листая печатные акты.
 *
 * Открывается кликом по самой карточке (см. RentalsTab.tsx: класс
 * .rental-card.clickable + onClick на карточке, кнопки действий внутри
 * останавливают всплытие). Намеренно ПОЛНОСТЬЮ read-only: у карточки в
 * списке уже есть все нужные кнопки действий (Выдать/Принять возврат/
 * Изменить/Отменить/печать) — дублировать их здесь значило бы поддерживать
 * два места с одной и той же логикой ради того, что и так на расстоянии
 * одного клика. Единственное действие панели — открыть карточку клиента
 * (onOpenClient), тот же кросс-вкладочный механизм dashClientId/
 * setDashClientId, что уже используют DashboardTab и ClientsTab (см.
 * Dashboard.tsx).
 */
import type { Rental } from "../../../api/types";
import { useData } from "../../../context/DataContext";
import { RENTAL_META, Badge, rentalDisplayStatus } from "../../../lib/statusMeta";
import { money, fmtDate } from "../../../lib/format";
import { IconClose, IconUser } from "../../../lib/icons";
import { itemRateLabel } from "./helpers";

export function RentalDetailPanel({
  rentalId,
  onClose,
  onOpenClient,
}: {
  rentalId: string;
  onClose: () => void;
  onOpenClient: (clientId: string) => void;
}) {
  const { equipment, clients, rentals } = useData();
  const rental: Rental | undefined = rentals.find((r) => r.id === rentalId);

  if (!rental) return null;

  const client = clients.find((c) => c.id === rental.client_id);
  const st = rentalDisplayStatus(rental);

  return (
    <div className="slideover">
      <div className="slideover-head">
        <div>
          <h3>{client?.name ?? "Клиент удалён"}</h3>
          <div style={{ color: "var(--muted)", fontSize: "12.5px", marginTop: "2px" }}>
            {fmtDate(rental.start_date)} — {fmtDate(rental.end_date)}
            {rental.actual_return ? ` · возврат ${fmtDate(rental.actual_return)}` : ""}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="slideover-section" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <Badge meta={RENTAL_META[st]} />
        {client && (
          <button className="btn btn-sm" onClick={() => onOpenClient(client.id)}>
            <IconUser /> Карточка клиента
          </button>
        )}
      </div>

      <div className="slideover-section">
        <h4>Оборудование</h4>
        {rental.items.map((it) => {
          const eq = equipment.find((e) => e.id === it.equipment_id);
          return (
            <div className="mini-item" key={it.equipment_id}>
              <span>{eq?.name ?? "—"}</span>
              <span className="mono">{itemRateLabel(it)}</span>
            </div>
          );
        })}
      </div>

      <div className="slideover-section">
        <h4>Финансы</h4>
        <div className="kv-grid">
          <span className="k">Плановых дней</span>
          <span className="mono">{rental.planned_days}</span>
          <span className="k">Фактических дней</span>
          <span className="mono">{rental.actual_return ? rental.actual_days : "—"}</span>
          <span className="k">Аренда</span>
          <span className="mono">{money(rental.base)}</span>
          {rental.late_fee > 0 && (
            <>
              <span className="k">Просрочка, {rental.late_days} дн.</span>
              <span className="mono">{money(rental.late_fee)}</span>
            </>
          )}
          {rental.damage_fee > 0 && (
            <>
              <span className="k">Повреждения</span>
              <span className="mono">{money(rental.damage_fee)}</span>
            </>
          )}
          {rental.discount > 0 && (
            <>
              <span className="k">Скидка</span>
              <span className="mono">−{money(rental.discount)}</span>
            </>
          )}
          <span className="k">Итого</span>
          <span className="mono" style={{ fontWeight: 700 }}>
            {money(rental.total)}
          </span>
          <span className="k">Депозит на удержании</span>
          <span className="mono">{money(rental.deposit_total)}</span>
        </div>
      </div>

      {(rental.issue_notes || rental.return_notes) && (
        <div className="slideover-section">
          <h4>Заметки</h4>
          {rental.issue_notes && (
            <div style={{ marginBottom: rental.return_notes ? "10px" : 0 }}>
              <div className="k" style={{ marginBottom: "4px" }}>
                При выдаче
              </div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: "13px" }}>{rental.issue_notes}</div>
            </div>
          )}
          {rental.return_notes && (
            <div>
              <div className="k" style={{ marginBottom: "4px" }}>
                При возврате
              </div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: "13px" }}>{rental.return_notes}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
