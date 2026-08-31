import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconAlert } from "../lib/icons";

/**
 * Замена нативного window.confirm() на стилизованную модалку — тот же идиом
 * <dialog> (ref + showModal()/close() в useEffect по состоянию), что и
 * остальные модалки проекта (FormModal в RentalsTab.tsx, EquipmentFormModal
 * в EquipmentTab.tsx, DocModal в documents.tsx). Уродливый нативный диалог
 * браузера (разный на каждой ОС, без стилей приложения) заменяется на
 * согласованный со всем остальным UI компонент.
 *
 * Использование в компоненте:
 *   const { confirm, dialog } = useConfirm();
 *   ...
 *   async function handleDelete() {
 *     if (!(await confirm("Удалить эту запись?"))) return;
 *     ...
 *   }
 *   ...
 *   return <div>...{dialog}</div>;
 *
 * Один экземпляр хука на компонент — если внутри компонента возможны
 * одновременные независимые подтверждения, используйте несколько вызовов
 * useConfirm() (по одному на сценарий), как и с остальными локальными
 * модалками в проекте.
 */
interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** true — кнопка подтверждения красная (btn-danger), для необратимых
   * действий (удаление). По умолчанию обычная акцентная (btn-primary). */
  danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  message: string;
  resolve: (v: boolean) => void;
}

export function useConfirm() {
  const [state, setState] = useState<ConfirmState | null>(null);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (state && !dlg.open) dlg.showModal();
    if (!state && dlg.open) dlg.close();
  }, [state]);

  const confirm = useCallback((message: string, opts?: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ message, resolve, ...opts });
    });
  }, []);

  function finish(result: boolean) {
    state?.resolve(result);
    setState(null);
  }

  // 19-й проход, разбор бага "Отмена всё равно закрывает форму": вызывающие
  // компоненты (EquipmentFormModal, EquipmentCategoriesModal и т.д.) кладут
  // {dialog} ВНУТРЬ своего собственного <dialog id="modal"> — этот
  // confirm-modal физически вложен в DOM родительского диалога. showModal()
  // всё равно красит его поверх (top layer не зависит от DOM-позиции — см.
  // комментарий про портал автокомплита категорий, 17-й проход), так что
  // визуально вложенность не мешала. Но клик по кнопке confirm-modal'а
  // (например "Отмена") — это событие, которое всплывает по РЕАЛЬНОМУ DOM
  // до родительского <dialog>, а не только до confirm-modal: конкретный
  // сценарий бага не подтверждён живьём однозначно (нестабильность рендерера
  // при тестировании), но сама вложенность — ненужный и рискованный источник
  // побочных эффектов (всплытие кликов, возврат фокуса при закрытии на
  // соседний топ-левел диалог и т.п.). Портал в document.body убирает
  // confirm-modal из DOM-поддерева родителя целиком, оставляя только
  // top-layer-позиционирование (которое и обеспечивает нужный внешний вид) —
  // так же, как и должен быть устроен любой глобальный/переиспользуемый
  // диалог, не завязанный на конкретное место вызова.
  const dialog = createPortal(
    <dialog
      id="confirm-modal"
      ref={ref}
      onClose={() => finish(false)}
      onCancel={(e) => {
        // Esc закрывает <dialog> сам — трактуем это как явную отмену
        // (resolve(false)), а не как ничего не значащий onClose.
        e.preventDefault();
        finish(false);
      }}
      onClick={(e) => {
        // Клик по затемнённому фону — тоже явная отмена (16-й проход,
        // системная проверка click-outside-to-close по всем модалкам проекта).
        if (e.target === e.currentTarget) finish(false);
      }}
    >
      {state && (
        <>
          <div className="confirm-body">
            <span className={"confirm-icon" + (state.danger ? " critical" : "")}>
              <IconAlert />
            </span>
            <div>
              {state.title && <h3>{state.title}</h3>}
              <p>{state.message}</p>
            </div>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn" onClick={() => finish(false)} autoFocus>
              {state.cancelLabel ?? "Отмена"}
            </button>
            <button type="button" className={"btn " + (state.danger ? "btn-danger" : "btn-primary")} onClick={() => finish(true)}>
              {state.confirmLabel ?? "Удалить"}
            </button>
          </div>
        </>
      )}
    </dialog>,
    document.body
  );

  return { confirm, dialog };
}
