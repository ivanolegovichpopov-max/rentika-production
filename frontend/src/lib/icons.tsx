/**
 * Инлайн-SVG иконки — перенесены из демо-прототипа как React-компоненты
 * (там были инлайн-строки SVG, здесь то же самое, но JSX). Единый размер
 * 16px, stroke=currentColor, stroke-width=2 (кроме plus — 2.4, trend — 3),
 * без внешних иконных библиотек — 1:1 с оригиналом.
 */
import type { SVGProps } from "react";

function Svg({ children, strokeWidth, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
      strokeWidth={strokeWidth ?? 2}
    >
      {children}
    </svg>
  );
}

export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></Svg>
);
export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <Svg strokeWidth={2.4} {...p}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></Svg>
);
export const IconPrinter = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></Svg>
);
export const IconEdit = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></Svg>
);
export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></Svg>
);
export const IconSun = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22" /><line x1="4.93" y1="4.93" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.07" y2="19.07" /><line x1="2" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22" y2="12" /><line x1="4.93" y1="19.07" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.07" y2="4.93" /></Svg>
);
export const IconMoon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></Svg>
);
export const IconAlert = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></Svg>
);
export const IconTrendUp = (p: SVGProps<SVGSVGElement>) => (
  <Svg strokeWidth={3} {...p}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></Svg>
);
export const IconTrendDown = (p: SVGProps<SVGSVGElement>) => (
  <Svg strokeWidth={3} {...p}><polyline points="23 18 13.5 8.5 8.5 13.5 1 6" /><polyline points="17 18 23 18 23 12" /></Svg>
);
export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><polyline points="9 18 15 12 9 6" /></Svg>
);
export const IconDashboard = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></Svg>
);
export const IconEquipment = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></Svg>
);
export const IconClients = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></Svg>
);
// 16-й проход (обзор вкладки «Оборудование», п.8): раньше эта иконка была
// нарисована буквально теми же координатами, что IconCalendar (обе —
// прямоугольник с двумя "ушками" сверху и горизонтальной чертой, т.е. один и
// тот же значок календаря) — в сайдбаре "Аренды" и "Календарь" визуально не
// отличались. Теперь у "Аренд" свой значок — две стрелки навстречу друг
// другу ("выдача / возврат"), стандартный глиф обмена.
export const IconRentals = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M17 3l4 4-4 4" /><path d="M21 7H3" /><path d="M7 21l-4-4 4-4" /><path d="M3 17h18" /></Svg>
);
export const IconFinance = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><line x1="12" y1="20" x2="12" y2="10" /><line x1="18" y1="20" x2="18" y2="4" /><line x1="6" y1="20" x2="6" y2="16" /></Svg>
);
export const IconEmployees = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Svg>
);
export const IconSecurity = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></Svg>
);
export const IconAdmin = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" /></Svg>
);
export const IconCalendar = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></Svg>
);
export const IconChevronDown = (p: SVGProps<SVGSVGElement>) => (
  <Svg strokeWidth={2.4} {...p}><polyline points="6 9 12 15 18 9" /></Svg>
);
export const IconEye = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></Svg>
);
export const IconEyeOff = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></Svg>
);
export const IconSliders = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></Svg>
);
export const IconTrash = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></Svg>
);
export const IconMessages = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></Svg>
);
export const IconUser = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Svg>
);
export const IconSend = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></Svg>
);
export const IconGrip = (p: SVGProps<SVGSVGElement>) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" {...p}>
    <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
  </svg>
);
// "Сбросить настройки дашборда" (кнопка в режиме редактирования) — обычная
// стрелка-разворот по кругу, тот же idiom Svg(), что и остальные иконки выше.
export const IconReset = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></Svg>
);
// Быстрое "Копировать" прямо в строке таблицы (пятнадцатый проход, вкладка
// «Оборудование») — стандартный значок "два перекрывающихся прямоугольника".
export const IconCopy = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Svg>
);
// Галочка выбранного пункта в кастомном мульти-select фильтре категорий
// (16-й проход, обзор по скриншотам, п.5) — заменяет нативный чекбокс,
// который "выглядит неаккуратно" по мнению пользователя.
export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <Svg strokeWidth={2.6} {...p}><polyline points="20 6 9 17 4 12" /></Svg>
);
// Быстрый звонок клиенту прямо из строки таблицы (25-й проход, п.10 обзора
// «глазами обычного пользователя») — стандартный глиф телефонной трубки.
export const IconPhone = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" /></Svg>
);
