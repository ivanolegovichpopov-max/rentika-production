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
 */
type ToastType = "error" | "info" | "success";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  notify: (message: string, type?: ToastType) => void;
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
    (message: string, type: ToastType = "error") => {
      const id = nextId.current++;
      setItems((prev) => [...prev, { id, message, type }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS[type]);
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
