import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { IconAlert, IconClose } from "../lib/icons";

/**
 * Замена browser alert() на стилизованные всплывающие уведомления —
 * 16-й проход (обзор по скриншотам): нажатие "Удалить" на категории с
 * привязанным оборудованием всплывало нативным браузерным alert() поверх
 * страницы ("подтвердите действие на rentika-frontend.onrender.com") — не в
 * стиле приложения и не может быть отключено/не мешать. alert()/confirm()
 * были СОЗНАТЕЛЬНЫМ решением на весь проект раньше (см. комментарий в
 * CalendarTab.tsx) — но пользователь явно попросил системную замену.
 *
 * useConfirm() (ConfirmDialog.tsx) уже закрывает сценарий "да/нет" — этот
 * компонент закрывает второй сценарий: одностороннее уведомление (ошибка
 * запроса, информация об итоге массового действия), которое раньше шло
 * через alert(). Использование:
 *
 *   const { notify } = useToast();
 *   ...
 *   notify("Не удалось удалить"); // type по умолчанию "error"
 *   notify("Категория изменена у 3 из 5. Ошибок: 2.", "info");
 *
 * Необязательная кнопка-действие в самом уведомлении (доп. проход после
 * 67-го, "Отменить" после массового отключения сотрудников) — четвёртый
 * параметр; клик по ней сразу закрывает тост, отдельно от авто-скрытия по
 * таймеру:
 *
 *   notify("Отключено 3 сотрудника", "success", { label: "Отменить", onClick: undoBulkDisable });
 */
type ToastType = "error" | "info" | "success";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

interface ToastContextValue {
  notify: (message: string, type?: ToastType, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// Ошибки держим на экране дольше — их чаще нужно успеть прочитать/дождаться
// коллегу, информационные/успешные можно убирать быстрее.
const AUTO_DISMISS_MS: Record<ToastType, number> = {
  error: 7000,
  info: 5000,
  success: 4000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, type: ToastType = "error", action?: ToastAction) => {
      const id = nextId.current++;
      setItems((prev) => [...prev, { id, message, type, action }]);
      // С кнопкой-действием держим тост дольше обычного (10 с) — иначе
      // "Отменить" рискует исчезнуть раньше, чем владелец успеет заметить
      // уведомление и нажать её.
      window.setTimeout(() => dismiss(id), action ? 10000 : AUTO_DISMISS_MS[type]);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="toast-stack">
        {items.map((t) => (
          <div key={t.id} className={"toast toast-" + t.type} role={t.type === "error" ? "alert" : "status"}>
            {t.type === "error" && (
              <span className="toast-icon">
                <IconAlert />
              </span>
            )}
            <span className="toast-message">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="btn btn-sm toast-action"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="icon-btn toast-close" onClick={() => dismiss(t.id)} title="Закрыть">
              <IconClose />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast() должен вызываться внутри <ToastProvider>");
  return ctx;
}
