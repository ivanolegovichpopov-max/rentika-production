/**
 * Печатные шаблоны документов (договор / акт приёма-передачи / акт возврата)
 * + модалка предпросмотра-печати — перенесено 1:1 из демо-прототипа
 * (buildContractDoc/buildIssueDoc/buildReturnDoc + модалка #modal), только
 * вместо конкатенации HTML-строк здесь JSX, и данные берутся из реальных
 * полей backend'а (Rental.base/late_fee/damage_fee/discount/total/
 * planned_days/late_days — см. app/services/pricing.py compute_rental_breakdown)
 * вместо пересчёта на фронте, как в демо.
 */
import { useEffect, useRef, type ReactNode } from "react";
import type { Client, Equipment, Rental } from "../../api/types";
import { fmtDate, money, todayISO } from "../../lib/format";
import { IconClose, IconPrinter } from "../../lib/icons";

// В проде нет сущности "реквизиты компании" — как и в демо, это статичный
// плейсхолдер в шаблоне, который бизнес правит от руки перед печатью/подписью.
const COMPANY_NAME = "[Название вашей компании]";

function docNumber(r: Rental): string {
  return r.id.slice(0, 8).toUpperCase();
}

/** Таблица позиций аренды — общая для всех трёх документов (Оборудование / Инв. № / Ставка). */
function ItemsTable({ r, equipment }: { r: Rental; equipment: Equipment[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Оборудование</th>
          <th>Инв. №</th>
          <th>Ставка</th>
        </tr>
      </thead>
      <tbody>
        {r.items.map((it) => {
          const eq = equipment.find((e) => e.id === it.equipment_id);
          const rate = it.period_days_snapshot
            ? `${money(it.period_price_snapshot ?? 0)} / ${it.period_days_snapshot} дн.`
            : `${money(it.daily_rate_snapshot)}/день`;
          return (
            <tr key={it.equipment_id}>
              <td>{eq?.name ?? "—"}</td>
              <td>{eq?.code ?? "—"}</td>
              <td>{rate}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function buildContractDoc(r: Rental, client: Client | undefined, equipment: Equipment[]): ReactNode {
  return (
    <div className="doc-page">
      <h2>Договор аренды оборудования № {docNumber(r)}</h2>
      <div className="doc-sub">
        от {fmtDate(r.created_at.slice(0, 10))} · {COMPANY_NAME}{" "}
        <span className="doc-placeholder">(шаблон — заполните реквизиты)</span>
      </div>

      <div className="doc-grid">
        <div className="k">Арендодатель</div>
        <div>{COMPANY_NAME}</div>
        <div className="k">Арендатор</div>
        <div>{client?.name ?? "—"}</div>
        <div className="k">Телефон</div>
        <div>{client?.phone ?? "—"}</div>
        <div className="k">Документ</div>
        <div>{client?.doc ?? "—"}</div>
        <div className="k">Период аренды</div>
        <div>{fmtDate(r.start_date)} — {fmtDate(r.end_date)}</div>
        <div className="k">Депозит</div>
        <div>{money(r.deposit_total)}</div>
      </div>

      <ItemsTable r={r} equipment={equipment} />

      <p>
        Арендатор обязуется вернуть оборудование, указанное в настоящем договоре, в исправном
        состоянии и комплектации, в которой оно было получено, с учётом нормального износа. В
        случае возврата оборудования позже согласованной даты окончания аренды начисляется
        плата за просрочку по ставке, действующей для соответствующей позиции, за каждый день
        задержки. При повреждении, утрате или неисправности оборудования по вине арендатора
        стоимость ремонта или замены удерживается из суммы депозита, а при недостаточности
        депозита — возмещается арендатором дополнительно в полном объёме.
      </p>

      <div className="doc-sign">
        <div className="line">Арендодатель / {COMPANY_NAME}</div>
        <div className="line">Арендатор / {client?.name ?? "—"}</div>
      </div>
    </div>
  );
}

export function buildIssueDoc(r: Rental, client: Client | undefined, equipment: Equipment[]): ReactNode {
  return (
    <div className="doc-page">
      <h2>Акт приёма-передачи оборудования</h2>
      <div className="doc-sub">к договору № {docNumber(r)} · выдано {fmtDate(todayISO())}</div>

      <div className="doc-grid">
        <div className="k">Арендодатель</div>
        <div>{COMPANY_NAME}</div>
        <div className="k">Арендатор</div>
        <div>{client?.name ?? "—"}</div>
      </div>

      <ItemsTable r={r} equipment={equipment} />

      <p><b>Состояние на момент выдачи:</b> {r.issue_notes || "не указано"}</p>

      <div className="doc-sign">
        <div className="line">Передал / {COMPANY_NAME}</div>
        <div className="line">Принял / {client?.name ?? "—"}</div>
      </div>
    </div>
  );
}

export function buildReturnDoc(r: Rental, client: Client | undefined, equipment: Equipment[]): ReactNode {
  return (
    <div className="doc-page">
      <h2>Акт возврата оборудования</h2>
      <div className="doc-sub">к договору № {docNumber(r)} · возврат {fmtDate(r.actual_return || todayISO())}</div>

      <div className="doc-grid">
        <div className="k">Арендодатель</div>
        <div>{COMPANY_NAME}</div>
        <div className="k">Арендатор</div>
        <div>{client?.name ?? "—"}</div>
      </div>

      <ItemsTable r={r} equipment={equipment} />

      <p><b>Состояние на момент возврата:</b> {r.return_notes || "не указано"}</p>

      <table>
        <tbody>
          <tr>
            <td>Аренда, {r.planned_days} дн.</td>
            <td className="mono">{money(r.base)}</td>
          </tr>
          {r.late_fee > 0 && (
            <tr>
              <td>Просрочка, {r.late_days} дн.</td>
              <td className="mono">{money(r.late_fee)}</td>
            </tr>
          )}
          {r.damage_fee > 0 && (
            <tr>
              <td>Компенсация повреждений</td>
              <td className="mono">{money(r.damage_fee)}</td>
            </tr>
          )}
          {r.discount > 0 && (
            <tr>
              <td>Скидка</td>
              <td className="mono">{"−" + money(r.discount)}</td>
            </tr>
          )}
          <tr>
            <th>Итого</th>
            <th className="mono">{money(r.total)}</th>
          </tr>
        </tbody>
      </table>

      <div className="doc-sign">
        <div className="line">Принял / {COMPANY_NAME}</div>
        <div className="line">Сдал / {client?.name ?? "—"}</div>
      </div>
    </div>
  );
}

export function DocModal({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog id="modal" ref={ref} onClose={onClose}>
      <div className="modal-head">
        <h3>{title}</h3>
        <button className="icon-btn" onClick={onClose} type="button">
          <IconClose />
        </button>
      </div>
      <div className="modal-body">{children}</div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose} type="button">
          Закрыть
        </button>
        <button className="btn btn-primary print-btn" onClick={() => window.print()} type="button">
          <IconPrinter />
          Печать / Сохранить PDF
        </button>
      </div>
    </dialog>
  );
}
