/**
 * FormModal — общий каркас модалки формы (тот же idiom, что DocModal в
 * ../documents.tsx: dialog id="modal" + ref + useEffect showModal()/close()
 * по пропу open), только с <form> внутри и футером Отмена/Сохранить вместо
 * Закрыть/Печать. Используется ВСЕМИ формами вкладки "Аренды" — вынесен в
 * отдельный файл при разноске RentalsTab.tsx по модулям (52-й проход, по
 * образцу разноски EquipmentTab.tsx/ClientsTab.tsx на модули в round 23/29),
 * т.к. общий для восьми разных модалок компонент — ровно тот случай "нужен в
 * нескольких местах", а не "локальный для одной формы".
 */
import type { ReactNode } from "react";
import { IconClose } from "../../../lib/icons";
import { useModalDialog } from "../../../lib/useModalDialog";

export function FormModal({
  title,
  open,
  onClose,
  onSubmit,
  submitLabel = "Сохранить",
  wide,
  error,
  // Красная кнопка отправки (43-й проход, п.5 обзора — CancelRentalModal) —
  // необязательный проп, по умолчанию false, старое поведение (btn-primary)
  // не меняется ни для одной из уже существующих форм на FormModal.
  danger,
  // Итоговая сумма в футере (46-й проход, повторный обзор формы "Новая
  // аренда") — необязательный проп, по умолчанию отсутствует, старое
  // поведение футера (просто кнопки, прижатые вправо) не меняется ни для
  // одной из форм, которые его не передают. Раньше итог показывался
  // "прилипающим" блоком внутри прокручиваемого тела формы (.summary-box.
  // sticky-summary) — по итогам обзора пользователь указал, что при
  // длинном списке оборудования это одновременно съедает видимую высоту
  // списка И визуально наезжает на соседние поля (скидка/доп. услуги),
  // когда список короткий. Футер модалки в принципе никогда не скроллится
  // — это НАСТОЯЩАЯ фиксация, а не CSS sticky-трюк, поэтому вынести туда
  // только сам итог (без построчной разбивки, которая остаётся в теле
  // формы обычным, не прилипающим блоком) решает обе жалобы сразу.
  footerExtra,
  // Защита от случайного закрытия (повторный обзор формы "Новая аренда") —
  // тот же принцип, что уже реализован в EquipmentFormModal/ClientFormModal:
  // если передан onRequestClose, ИМЕННО он вызывается из X/"Отмена"/Esc/
  // клика по фону вместо прямого onClose — вызывающий компонент сам решает,
  // нужно ли спросить подтверждение при несохранённых изменениях. Если проп
  // не передан (все остальные формы на FormModal — Выдача, Возврат,
  // Продление и т.д.) — поведение остаётся прежним, один-в-один.
  onRequestClose,
  // Второй <dialog> подтверждения ("Несохранённые изменения будут
  // потеряны") от useConfirm() вызывающего компонента — рендерится ПОСЛЕ
  // </form>, но всё ещё внутри этого же внешнего <dialog>, тем же приёмом,
  // что и discardDialog в EquipmentFormModal/ClientFormModal.
  afterForm,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  submitLabel?: string;
  wide?: boolean;
  error?: string | null;
  danger?: boolean;
  footerExtra?: ReactNode;
  onRequestClose?: () => void;
  afterForm?: ReactNode;
  children: ReactNode;
}) {
  const { ref, handleNativeClose } = useModalDialog(open);
  const requestClose = onRequestClose ?? onClose;

  return (
    <dialog
      id="modal"
      className={wide ? "wide" : undefined}
      ref={ref}
      onClose={() => handleNativeClose(onClose)}
      onCancel={(e) => {
        // Esc закрывает <dialog> сам — трактуем как запрос на закрытие,
        // а не как безусловное закрытие (тот же приём, что и в
        // EquipmentFormModal/ClientFormModal).
        e.preventDefault();
        requestClose();
      }}
      onClick={(e) => {
        // Клик по затемнённому фону закрывает модалку — тот же идиом, что и
        // в EquipmentTab.tsx (16-й проход, п.2 обзора). Раньше здесь этого
        // не было, хотя визуально модалка выглядит идентично.
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <form onSubmit={onSubmit}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={requestClose} type="button">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          {children}
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className={"modal-foot" + (footerExtra ? " modal-foot-split" : "")}>
          {footerExtra && <div className="modal-foot-total">{footerExtra}</div>}
          <div className="modal-foot-actions">
            <button className="btn" onClick={requestClose} type="button">
              Отмена
            </button>
            <button className={"btn " + (danger ? "btn-danger" : "btn-primary")} type="submit">
              {submitLabel}
            </button>
          </div>
        </div>
      </form>
      {afterForm}
    </dialog>
  );
}
