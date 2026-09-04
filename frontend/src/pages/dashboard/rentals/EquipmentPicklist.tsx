/**
 * EquipmentPicklist — мультивыбор оборудования с проверкой занятости на
 * диапазон [start, end]. Общий для CreateRentalModal и EditRentalModal,
 * вынесен в отдельный файл при разноске RentalsTab.tsx по модулям (52-й
 * проход, по образцу round 23/29).
 */
import { Fragment, useState } from "react";
import type { Equipment, Rental } from "../../../api/types";
import { money, fmtDate, spanDays } from "../../../lib/format";
import { IconClose, IconChevronDown, IconSearch } from "../../../lib/icons";
import { usePersistedState } from "../../../lib/persist";
import { equipmentRateLabel, equipmentRateLabelTitle, isEquipmentFreeForRange, conflictEndFor, equipmentCostForDays } from "./helpers";

function isUnderMaintenanceOn(eq: Equipment, dateIso: string): boolean {
  if (eq.status !== "maintenance") return false;
  if (!eq.maintenance_until) return true;
  return dateIso <= eq.maintenance_until;
}

/** Мультивыбор оборудования с проверкой занятости на диапазон [start, end] —
 * порт общей разметки .eq-picklist/.eq-pick-row демо, используется и в
 * создании, и в правке аренды.
 *
 * 46-й проход, по итогам обзора формы "Новая аренда" (пользователь принял
 * все три моих предложения из обзора целиком, поиск — единственное из его
 * собственных трёх вопросов, на которое тоже согласился):
 *  - список теперь отсортирован (категория → название → номер) и разбит на
 *    подписанные группы по категории — раньше порядок совпадал с тем, как
 *    записи лежат в базе (фактически случайным для пользователя), из-за
 *    чего несколько одинаковых по названию единиц оказывались вперемешку с
 *    другим оборудованием без всякой системы;
 *  - под названием — номер (Equipment.code) и склад, тот же принцип
 *    подписи, что "№ …" на вкладке "Оборудование" (EquipmentTab.tsx) —
 *    раньше несколько единиц с одинаковым названием были неотличимы друг от
 *    друга в этом списке;
 *  - ставка сопровождается title-подсказкой (equipmentRateLabelTitle) —
 *    расшифровка ступенчатого тарифа полным предложением при наведении;
 *  - строка поиска по названию/номеру/категории — тот же .search-box, что
 *    в общем поиске шапки (Dashboard.tsx);
 *  - заголовок каждой группы кликабелен — сворачивает/разворачивает её
 *    содержимое (по просьбе пользователя — сезонное оборудование, которое
 *    не нужно видеть полгода). Состояние "что свёрнуто" запоминается
 *    насовсем на конкретный бизнес (usePersistedState — тот же приём, что
 *    уже хранит сортировку/колонки на "Оборудовании"), иначе пришлось бы
 *    заново сворачивать категорию при каждом открытии формы. Пока идёт
 *    активный поиск — сворачивание игнорируется (см. visible ниже): прятать
 *    от пользователя совпадения его же собственного запроса было бы хуже,
 *    чем просто временно проигнорировать его же ранее сохранённые настройки
 *    свёрнутости.
 */
export function EquipmentPicklist({
  items,
  start,
  end,
  rentals,
  excludeRentalId,
  checkedIds,
  onToggle,
  onClearAll,
  alwaysShowIds,
  businessId,
}: {
  items: Equipment[];
  start: string;
  end: string;
  rentals: Rental[];
  excludeRentalId?: string;
  checkedIds: string[];
  onToggle: (id: string) => void;
  // Сброс всего выбранного разом (четвёртый обзор той же формы) — раньше
  // снять отметки можно было только по одной, кликая крестик на каждом
  // чипе; при случайно отмеченных позициях в разных категориях это
  // неудобно. Необязательный проп — родитель решает, что значит "очистить"
  // (просто setCheckedIds([])).
  onClearAll?: () => void;
  alwaysShowIds?: string[];
  businessId: string;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = usePersistedState<string[]>(`eq-picklist-collapsed:${businessId}`, []);

  function toggleCollapsed(category: string) {
    setCollapsed((prev) => (prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]));
  }

  const base = items.filter(
    (e) => (alwaysShowIds?.includes(e.id) ?? false) || (e.status !== "retired" && !isUnderMaintenanceOn(e, start))
  );
  const sorted = [...base].sort((a, b) => {
    const byCategory = a.category.localeCompare(b.category, "ru");
    if (byCategory !== 0) return byCategory;
    const byName = a.name.localeCompare(b.name, "ru");
    if (byName !== 0) return byName;
    return (a.code ?? "").localeCompare(b.code ?? "", "ru");
  });
  const q = query.trim().toLowerCase();
  const visible = q
    ? sorted.filter((e) => (e.name + " " + e.category + " " + (e.code ?? "")).toLowerCase().includes(q))
    : sorted;
  // Во время поиска сворачивание не действует (см. докстринг выше) —
  // применяем сохранённое collapsed только когда поле поиска пустое.
  const collapseActive = !q;

  // Счётчик позиций в каждой категории (повторный обзор формы "Новая
  // аренда") — считается от того же visible, что и сам список: пока идёт
  // поиск, число в свёрнутом заголовке — это то, сколько там совпадений
  // запроса, а не общее число позиций категории вслепую.
  const categoryCounts = new Map<string, number>();
  for (const e of visible) categoryCounts.set(e.category, (categoryCounts.get(e.category) ?? 0) + 1);
  // Сколько из них уже отмечено (четвёртый обзор той же формы) — раньше
  // заголовок свёрнутой категории показывал только общее число позиций, но
  // не намекал, есть ли внутри уже выбранное: отметив пару позиций и
  // свернув категорию, легко забыть, что там что-то выбрано.
  const categorySelected = new Map<string, number>();
  for (const e of visible) {
    if (checkedIds.includes(e.id)) categorySelected.set(e.category, (categorySelected.get(e.category) ?? 0) + 1);
  }

  // Стоимость за весь выбранный срок, а не только ставка за сутки
  // (повторный обзор формы "Новая аренда") — то же previewDays, что
  // считают CreateRentalModal/EditRentalModal для итоговой суммы формы.
  const previewDays = end >= start ? spanDays(start, end) : 0;

  let lastCategory: string | null = null;

  return (
    <div>
      <div className="search-box eq-search-sticky" style={{ width: "100%", marginBottom: "8px" }}>
        <IconSearch width={14} height={14} />
        <input
          type="text"
          placeholder="Поиск по названию, номеру, категории…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {checkedIds.length > 0 && (
        <div className="eq-pick-chips">
          {checkedIds.map((id) => {
            const eq = items.find((e) => e.id === id);
            if (!eq) return null;
            return (
              <span className="eq-pick-chip" key={id}>
                <span>{eq.name}</span>
                <button type="button" onClick={() => onToggle(id)} aria-label={`Убрать «${eq.name}» из выбранного`}>
                  <IconClose />
                </button>
              </span>
            );
          })}
          {onClearAll && (
            <button type="button" className="link-btn" onClick={onClearAll}>
              Очистить
            </button>
          )}
        </div>
      )}
      <div className="eq-picklist">
        {visible.length === 0 ? (
          <div className="empty-note" style={{ padding: "10px 12px" }}>
            Ничего не найдено
          </div>
        ) : (
          visible.map((e) => {
            const free = isEquipmentFreeForRange(e.id, start, end, rentals, excludeRentalId);
            const conflictEnd = free ? null : conflictEndFor(e.id, start, end, rentals, excludeRentalId);
            const checked = checkedIds.includes(e.id);
            const showGroup = e.category !== lastCategory;
            lastCategory = e.category;
            const isCollapsed = collapseActive && collapsed.includes(e.category);
            return (
              // Fragment, а не оборачивающий <div> — .eq-pick-row:last-child
              // (снимает нижнюю границу у последней строки списка) полагается
              // на то, что строки остаются ПРЯМЫМИ детьми .eq-picklist;
              // обёртка сделала бы каждую строку "последним ребёнком" своего
              // персонального div и убрала бы разделители между позициями.
              <Fragment key={e.id}>
                {showGroup && (
                  <button
                    type="button"
                    className={"eq-pick-group" + (isCollapsed ? " collapsed" : "")}
                    onClick={() => toggleCollapsed(e.category)}
                  >
                    <IconChevronDown />
                    <span className="eq-pick-group-name">{e.category}</span>
                    <span className="eq-pick-group-count">
                      {(() => {
                        const selected = categorySelected.get(e.category) ?? 0;
                        const total = categoryCounts.get(e.category);
                        return selected > 0 ? `(${selected} из ${total})` : `(${total})`;
                      })()}
                    </span>
                  </button>
                )}
                {!isCollapsed && (
                  <label className={`eq-pick-row${free ? "" : " disabled"}`}>
                    <input type="checkbox" checked={checked} disabled={!free} onChange={() => onToggle(e.id)} />
                    <span className="eq-pick-info">
                      <span className="eq-pick-name">{e.name}</span>
                      <span className="eq-pick-sub">
                        № {e.code ?? "—"}
                        {e.warehouse ? ` · ${e.warehouse}` : ""}
                      </span>
                    </span>
                    {/* Плашка "занято до" стоит ДО суммы, а не после (третий
                        обзор той же формы) — раньше она была последним flex-
                        элементом строки и, появляясь только у части позиций,
                        отжимала .eq-pick-cost влево ровно на свою ширину: суммы
                        занятых и свободных позиций оказывались на разной
                        горизонтали, мешая сравнивать их взглядом сверху вниз.
                        Теперь у .eq-pick-cost зафиксирована собственная ширина
                        (см. styles.css), и порядок элементов в строке гарантирует,
                        что она всегда последняя — сумма садится в одно и то же
                        место независимо от того, есть плашка или нет. */}
                    {!free && conflictEnd && <span className="eq-pick-conflict">занято до {fmtDate(conflictEnd)}</span>}
                    <span className="eq-pick-cost" title={equipmentRateLabelTitle(e)}>
                      {previewDays > 0 && (
                        <span className="eq-pick-cost-total">{money(equipmentCostForDays(e, previewDays))}</span>
                      )}
                      <span className="eq-pick-cost-rate">{equipmentRateLabel(e)}</span>
                    </span>
                  </label>
                )}
              </Fragment>
            );
          })
        )}
      </div>
    </div>
  );
}
