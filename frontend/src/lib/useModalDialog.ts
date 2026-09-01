import { useEffect, useRef } from "react";

/**
 * Общий контроллер модалок на нативном <dialog> + showModal()/close() (тот
 * же идиом ref+useEffect по `open`, что был раньше в каждой форме отдельно),
 * но с защитой от "спонтанного" нативного события close.
 *
 * 29-й проход, повторный обзор, п.16 — пользователь явно попросил живую
 * проверку в браузере, а не только чтение кода ("хочу сам проверить это
 * живьём... а не полагаться только на чтение исходников"), и оказался прав:
 * баг был реальным. Подтверждено вживую headless-Chromium: когда внутри
 * такого диалога (форма клиента/оборудования) открыт ВТОРОЙ модальный
 * <dialog> — предупреждение "Несохранённые изменения" через useConfirm — и
 * пользователь закрывает ЕГО кнопкой "Отмена", у ВНЕШНЕГО диалога иногда
 * само по себе срабатывает нативное событие close, хотя пропс `open`
 * остаётся true и явно его никто не закрывал (voidified requestClose() как
 * раз должен был на этом месте просто вернуться, ничего не закрывая — и в
 * JS-логике так и происходит, но браузер всё равно визуально закрывает
 * диалог). Итог был: форма пропадала, а введённые данные терялись прямо на
 * кнопке "Отмена" — то есть ровно тот баг, из-за которого этот пункт вообще
 * попал в обзор.
 *
 * Раз браузер уже реально скрыл диалог, одного игнорирования события
 * недостаточно (диалог остался бы визуально закрытым при open=true) —
 * поэтому при "спонтанном" close (open всё ещё true) диалог немедленно
 * открывается заново тем же showModal(), а обработчик onClose из пропсов
 * компонента не вызывается вовсе.
 */
export function useModalDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  /** Передавайте как `onClose={() => handleNativeClose(onCloseProp)}` на
   * самом <dialog>. */
  function handleNativeClose(onClose: () => void) {
    if (openRef.current) {
      ref.current?.showModal();
      return;
    }
    onClose();
  }

  return { ref, handleNativeClose };
}
