/**
 * BulkReminderModal — массовая рассылка напоминаний по выбранным арендам
 * (WhatsApp/почта на каждую строку отдельно). Вынесена в отдельный файл при
 * разноске RentalsTab.tsx по модулям (52-й проход, по образцу round 23/29).
 */
import { useEffect, useRef } from "react";
import type { Client, Equipment, Rental } from "../../../api/types";
import { money, fmtDate } from "../../../lib/format";
import { IconClose } from "../../../lib/icons";
import { normalizePhoneDigits } from "../clients/helpers";
import { buildRentalSummaryText } from "../clients/summary";

/* ---------- Массовое напоминание (43-й проход, п.6 обзора) ---------- */
/**
 * Список выбранных аренд с кнопками WhatsApp/почта на КАЖДУЮ строку отдельно
 * — намеренно НЕ один "разослать всем" клик: и wa.me, и mailto: — это
 * переход по ссылке в новой вкладке/почтовом клиенте, который требует
 * пользовательского жеста на каждый вызов (браузеры блокируют несколько
 * одновременных window.open()/переходов по сгенерированному в JS клику без
 * прямого клика пользователя как всплывающие окна). Текст сообщения и сама
 * ссылка — переиспользование buildRentalSummaryText/normalizePhoneDigits из
 * clients/summary.ts и clients/helpers.ts, тех же, что уже использует
 * одиночная кнопка "Написать клиенту" в RentalDetailPanel.tsx — одна
 * формула сводки на все три места (детали аренды, карточка клиента, массовая
 * рассылка).
 */
export function BulkReminderModal({
  rentals,
  clients,
  equipment,
  onClose,
}: {
  rentals: Rental[];
  clients: Client[];
  equipment: Equipment[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const rows = rentals
    .map((r) => ({ rental: r, client: clients.find((c) => c.id === r.client_id) }))
    .filter((x): x is { rental: Rental; client: Client } => !!x.client && !!(x.client.phone || x.client.email));

  return (
    <dialog id="modal" ref={ref} onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-head">
        <h3>Напомнить клиентам ({rows.length})</h3>
        <button className="icon-btn" onClick={onClose} type="button">
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        {rows.length === 0 ? (
          <div className="empty-note">
            У выбранных аренд нет клиентов с телефоном или почтой — отправить напоминание некому.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {rows.map(({ rental, client }) => (
              <div
                key={rental.id}
                className="summary-box"
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{client.name}</div>
                  <div style={{ color: "var(--muted)", fontSize: "12.5px" }}>
                    {fmtDate(rental.start_date)} — {fmtDate(rental.end_date)} · {money(rental.total)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  {client.phone && (
                    <button
                      className="btn btn-sm"
                      type="button"
                      onClick={() =>
                        window.open(
                          `https://wa.me/${normalizePhoneDigits(client.phone)}?text=${encodeURIComponent(
                            buildRentalSummaryText(rental, client, equipment)
                          )}`,
                          "_blank",
                          "noreferrer"
                        )
                      }
                    >
                      WhatsApp
                    </button>
                  )}
                  {client.email && (
                    <button
                      className="btn btn-sm"
                      type="button"
                      onClick={() => {
                        window.location.href = `mailto:${client.email}?subject=${encodeURIComponent(
                          "Информация по аренде"
                        )}&body=${encodeURIComponent(buildRentalSummaryText(rental, client, equipment))}`;
                      }}
                    >
                      Почта
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose} type="button">
          Закрыть
        </button>
      </div>
    </dialog>
  );
}
