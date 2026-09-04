/**
 * Слайд-панель с деталями клиента — вынесена из ClientsTab.tsx в отдельный
 * модуль (38-й проход, "прибраться в коде", по образцу
 * equipment/EquipmentDetailPanel.tsx). Единственный внешний потребитель
 * помимо ClientsTab.tsx (которая ре-экспортирует этот компонент без
 * изменений, см. её докстринг) — Dashboard.tsx.
 */
import { useState, type ReactNode } from "react";
import { api, ApiError } from "../../../api/client";
import { useData } from "../../../context/DataContext";
import type { Client } from "../../../api/types";
import { RATING_META, RENTAL_META, Badge, rentalDisplayStatus } from "../../../lib/statusMeta";
import { money, fmtDate, initials, formatPhoneInput } from "../../../lib/format";
import { IconClose, IconPhone, IconSend } from "../../../lib/icons";
import { useToast } from "../../../components/Toast";
import { MoreActionsMenu } from "../../../components/MoreActionsMenu";
import { DocModal, buildContractDoc } from "../documents";
import {
  clientDisplayRating,
  computeClientValueTiers,
  isIncompleteProfile,
  lastRentalDate,
  normalizePhoneDigits,
  ratingAvatarClass,
  VALUE_TIER_META,
} from "./helpers";
import { pickSummaryRental, buildRentalSummaryText } from "./summary";
import { MiniActivityChart, monthKeyToLabel } from "./MiniActivityChart";
import { ClientDocumentsSection } from "./ClientDocumentsSection";
import { ClientNotesJournal } from "./ClientNotesJournal";
import { MergeClientModal } from "./MergeClientModal";
import { BlacklistReasonModal } from "./BlacklistReasonModal";

export function ClientDetailPanel({
  businessId,
  clientId,
  onClose,
  onEdit,
  onDelete,
  onCreateRental,
}: {
  businessId: string;
  clientId: string;
  onClose: () => void;
  // Необязательный — с дашборда слайдовер открывается в сокращённом
  // варианте без кнопки "Изменить" (тот же принцип, что и у onCopy в
  // EquipmentDetailPanel: полноценные действия нужны только во вкладке
  // «Клиенты», где и живёт сама форма/модалка).
  onEdit?: (id: string) => void;
  onDelete: (id: string) => void;
  // "+ Новая аренда" прямо из карточки (25-й проход, п.1 обзора) —
  // необязательный по тому же принципу, что и onEdit: открывает ГЛОБАЛЬНУЮ
  // модалку "Новая аренда", которая живёт на уровне DashboardShell (см.
  // Dashboard.tsx), а не здесь — панель клиента сама модалку не рендерит,
  // только сообщает наверх, для кого её открыть.
  onCreateRental?: (clientId: string) => void;
}) {
  const { clients, rentals, equipment, reloadClients, reloadRentals } = useData();
  const client = clients.find((c) => c.id === clientId);
  const { notify } = useToast();
  // См. комментарий у computeClientValueTiers в clients/helpers.ts —
  // считается по всем клиентам бизнеса, не зависит от того, как открыта эта
  // карточка.
  const valueTier = computeClientValueTiers(clients, rentals).get(clientId);
  // Смена рейтинга на "чёрный список" — по весу последствий сопоставима с
  // удалением (это сигнал всей команде "не работать с этим клиентом"), но
  // раньше применялась одним кликом без подтверждения (24-й проход, п.6
  // обзора). Начиная с 25-го прохода (п.5) подтверждение заменено на
  // BlacklistReasonModal — не просто "да/нет", а обязательный ввод причины,
  // чтобы через полгода кто-то другой из команды видел, ПОЧЕМУ клиент
  // проблемный. Понижение из чёрного списка обратно и переход в "На
  // контроле" подтверждения не требуют — необратимого в них ничего нет.
  const [showBlacklistReason, setShowBlacklistReason] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [docModal, setDocModal] = useState<{ title: string; node: ReactNode } | null>(null);
  const [showMerge, setShowMerge] = useState(false);
  // 26-й проход: карточка разрослась (журнал, документы, доп. контакты,
  // график активности…) настолько, что один длинный скролл стал неудобен
  // для клиентов с большой историей/журналом — разбито на вкладки, тем же
  // простым idiom "кнопка + активное состояние", что и сегментированные
  // переключатели в остальном проекте (RATING_FILTERS и т.п.), без
  // отдельной библиотеки вкладок.
  const [panelTab, setPanelTab] = useState<"overview" | "history" | "journal">("overview");

  if (!client) return null;

  // См. clientDisplayRating выше — "На контроле" больше не хранится как
  // ручной выбор, а вычисляется по текущей просрочке (29-й проход, п.6 обзора).
  const displayRating = clientDisplayRating(client, rentals);

  const history = rentals
    .filter((r) => r.client_id === clientId)
    .slice()
    .sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  // Список ограничен по умолчанию (24-й проход, п.5 обзора) — у постоянного
  // клиента с десятками аренд слайдовер иначе растягивался бы бесконечно.
  const HISTORY_PAGE = 6;
  // Фильтр истории по месяцу из мини-графика активности (29-й проход, п.4
  // обзора, "клик по графику должен фильтровать историю по месяцу") — "YYYY-MM"
  // или null ("не фильтровать"). Сбрасывается при закрытии/переоткрытии
  // карточки естественным образом (компонент размонтируется целиком).
  const [historyMonthFilter, setHistoryMonthFilter] = useState<string | null>(null);
  const monthFilteredHistory = historyMonthFilter
    ? history.filter((r) => r.start_date.startsWith(historyMonthFilter))
    : history;
  const visibleHistory = showAllHistory ? monthFilteredHistory : monthFilteredHistory.slice(0, HISTORY_PAGE);

  const lifetimeRevenue = history.filter((r) => r.status === "returned").reduce((s, r) => s + r.total, 0);
  const lateReturns = history.filter((r) => r.status === "returned" && r.actual_return && r.actual_return > r.end_date).length;
  const currentlyOverdue = history.filter((r) => rentalDisplayStatus(r) === "overdue").length;
  const totalLate = lateReturns + currentlyOverdue;
  const depositHeld = history
    .filter((r) => {
      const s = rentalDisplayStatus(r);
      return s === "active" || s === "overdue";
    })
    .reduce((s, r) => s + r.deposit_total, 0);

  async function applyRating(rating: Client["rating"], blacklistReason: string | null) {
    try {
      await api.patch(`/businesses/${businessId}/clients/${clientId}`, {
        rating,
        // Причина чёрного списка очищается фронтом при снятии статуса (см.
        // комментарий у Client.blacklist_reason в app/models/inventory.py) —
        // не тащим за собой старую причину, если клиент потом реабилитирован
        // и снова туда же попал по новой причине.
        blacklist_reason: blacklistReason,
      });
      await reloadClients();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось изменить рейтинг");
    }
  }

  async function setRating(rating: Client["rating"]) {
    // Ненулевое утверждение: TS не протягивает сужение "client всегда
    // определён" (см. `if (!client) return null;` выше по компоненту) через
    // вложенное ОБЪЯВЛЕНИЕ функции (в отличие от стрелочной функции) — а
    // setRating вызывается уже после того, как ранний return null отработал.
    if (rating === "blacklist" && client!.rating !== "blacklist") {
      // Причина вводится в отдельной модалке (см. BlacklistReasonModal) —
      // сама смена рейтинга откладывается до её отправки.
      setShowBlacklistReason(true);
      return;
    }
    await applyRating(rating, rating === "blacklist" ? client!.blacklist_reason : null);
  }

  const tagList = (client.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const additionalContacts = client.additional_contacts ?? [];
  const incompleteProfile = isIncompleteProfile(client);
  // Для кнопок "Отправить сводку" ниже (26-й проход) — берём открытую
  // аренду, если есть, иначе последнюю завершённую (см. pickSummaryRental).
  const summaryRental = pickSummaryRental(history);

  return (
    <div className="slideover">
      <div className="slideover-head">
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {/* Цвет по рейтингу (62-й проход, прямое указание — "в карточке
              тоже поменяй") — тот же displayRating, что и у бейджа "На
              контроле" ниже (см. ratingAvatarClass в clients/helpers.tsx),
              единообразно со списком клиентов (ClientsTab.tsx). */}
          <span className={"avatar " + ratingAvatarClass(displayRating)} style={{ width: 36, height: 36, fontSize: "14px" }}>
            {initials(client.name)}
          </span>
          <div>
            <h3>
              {client.name}
              {client.client_type === "company" && (
                <span className="badge-tag" title="Организация" style={{ marginLeft: "6px" }}>
                  Орг.
                </span>
              )}
            </h3>
            <div style={{ color: "var(--muted)", fontSize: "12.5px", marginTop: "2px" }}>
              {client.phone ? formatPhoneInput(client.phone) : "—"}
            </div>
            {valueTier && (
              <div style={{ marginTop: "4px" }}>
                <Badge meta={VALUE_TIER_META[valueTier]} />
              </div>
            )}
          </div>
        </div>
        {/* "Ещё" перенесена сюда, в шапку, рядом с крестиком закрытия (37-й
            проход, обзор "кнопка Ещё рвёт карточку клиента"): раньше стояла
            в одном flex-ряду с "+ Новая аренда"/"Изменить"/"Удалить" и на
            узкой панели (420px) этот ряд не помещался по ширине — "Ещё"
            переносилась на отдельную строку и повисала в пустоте между
            рядом действий и вкладками. Место в шапке не зависит от того,
            сколько влезло кнопок ниже — здесь всегда достаточно свободного
            места, а по смыслу это даже точнее: крестик и "Ещё" — управление
            самой карточкой (закрыть / прочие действия над ней), а
            "+ Новая аренда"/"Изменить"/"Удалить" — операции с клиентом, две
            разные категории кнопок больше не смешаны в одном ряду. */}
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          {((onEdit && clients.length > 1) || (summaryRental && (client.phone || client.email))) && (
            <MoreActionsMenu
              align="right"
              iconOnly
              actions={[
                // Слияние дублей (24-й проход, п.7 обзора) — доступно только
                // там же, где и полноценное редактирование, и только если в
                // бизнесе есть с кем объединять.
                ...(onEdit && clients.length > 1
                  ? [{ key: "merge", label: "Объединить с другим клиентом", onClick: () => setShowMerge(true) }]
                  : []),
                // Сводка по аренде (26-й проход, «глазами обычного
                // пользователя», п.5) — ТОЛЬКО текстом: ни wa.me, ни mailto:
                // не умеют вкладывать файл, это ограничение самих
                // протоколов, не проекта. Договор целиком по-прежнему
                // открывается по клику на строку истории — это просто
                // быстрый способ переслать клиенту суть.
                ...(summaryRental && client.phone
                  ? [
                      {
                        key: "summary-wa",
                        label: "Сводка в WhatsApp",
                        onClick: () =>
                          window.open(
                            `https://wa.me/${normalizePhoneDigits(client.phone!)}?text=${encodeURIComponent(
                              buildRentalSummaryText(summaryRental, client, equipment)
                            )}`,
                            "_blank",
                            "noreferrer"
                          ),
                      },
                    ]
                  : []),
                ...(summaryRental && client.email
                  ? [
                      {
                        key: "summary-email",
                        label: "Сводка на почту",
                        onClick: () => {
                          window.location.href = `mailto:${client.email}?subject=${encodeURIComponent(
                            "Информация по аренде"
                          )}&body=${encodeURIComponent(buildRentalSummaryText(summaryRental, client, equipment))}`;
                        },
                      },
                    ]
                  : []),
              ]}
            />
          )}
          <button className="icon-btn" onClick={onClose}>
            <IconClose />
          </button>
        </div>
      </div>

      {/* Кнопки действий (29-й проход, п.13 обзора: "перенести действия
          наверх, не заставлять листать всю карточку до конца ради простого
          удаления") — раньше были самым последним блоком слайдовера, теперь
          сразу под шапкой, тем же принципом, что и заголовок/аватар выше:
          самое частое взаимодействие с карточкой не должно требовать скролла.
          35-й проход, обзор "карточка перегружена" — в основном ряду
          остались только действия на каждый день (аренда/правка/удаление);
          "Объединить с другим клиентом" и отправка сводки (редкие действия)
          перенесены в "Ещё" — которая с 37-го прохода живёт в шапке, см.
          комментарий там. Отдельный ряд кнопок "Позвонить"/WhatsApp/"Почта"
          под этим блоком убран целиком — те же действия теперь иконками
          прямо у "Телефон"/Email в блоке "Контакты" ниже, рядом со
          значением, к которому относятся, вместо того чтобы дублировать
          один и тот же номер тремя разными элементами на экране (текст в
          шапке → кнопка здесь → ссылка в "Контактах"). */}
      <div className="slideover-section" style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        {/* "+ Новая аренда" прямо из карточки (25-й проход, п.1 обзора) —
            открывает глобальную модалку выше по дереву (см. комментарий у
            onCreateRental в сигнатуре компонента), доступна везде, где
            открыта карточка (и во вкладке "Клиенты", и с дашборда). */}
        {onCreateRental && (
          <button className="btn btn-primary" onClick={() => onCreateRental(clientId)}>
            + Новая аренда
          </button>
        )}
        {onEdit && (
          <button className="btn" onClick={() => onEdit(clientId)}>
            Изменить
          </button>
        )}
        <button
          className="btn btn-danger-ghost"
          onClick={() => {
            onDelete(clientId);
          }}
        >
          Удалить
        </button>
      </div>

      {incompleteProfile && (
        <div className="slideover-section">
          <div className="form-error">
            Неполный профиль: не указан ни телефон, ни документ — стоит дозаполнить перед выдачей техники.
          </div>
        </div>
      )}

      {/* margin слева убран (36-й проход, обзор карточки клиента) — .slideover
          уже даёт всем секциям отступ 22px по padding контейнера, а тут
          сверху добавлялся ещё и свой margin-left: 16px, из-за чего вкладки
          съезжали на 38px вместо 22px и не совпадали по левому краю с
          кнопками действий/заголовками секций над и под ними. Нижний
          отступ (4px) оставлен — не про выравнивание, а про зазор до
          следующего блока. */}
      <div className="segmented" style={{ margin: "0 0 4px" }}>
        <button type="button" className={panelTab === "overview" ? "active" : ""} onClick={() => setPanelTab("overview")}>
          Обзор
        </button>
        <button type="button" className={panelTab === "history" ? "active" : ""} onClick={() => setPanelTab("history")}>
          История · {history.length}
        </button>
        <button type="button" className={panelTab === "journal" ? "active" : ""} onClick={() => setPanelTab("journal")}>
          Журнал
        </button>
      </div>

      {panelTab === "overview" && (
        <>
          <div className="slideover-section">
            <h4>Надёжность</h4>
            {/* Бейдж(и) статуса и кнопки выбора — в одном ряду (37-й проход,
                обзор "На контроле как будто просится в один ряд с
                остальными статусами"): раньше бейдж рисовался отдельным
                блоком над переключателем, из-за чего визуально выглядел
                самостоятельным полем, а не тем же статусом. Бейдж
                displayRating === "watch" показан по той же причине, что и
                раньше (35-й проход) — normal/blacklist подсветка активной
                кнопки в переключателе уже однозначно показывает то же самое
                состояние без дублирования, а "Watch" переключатель показать
                не может: кнопок в нём всего две (Надёжный/Чёрный список —
                "На контроле" из них намеренно убран ещё в 29-м проходе, п.6,
                см. комментарий ниже), а "На контроле" — не третье ручное
                состояние, а вычисляется поверх "Надёжного" при текущей
                просрочке, поэтому бейдж — единственное место, где это вообще
                видно. */}
            {/* "На контроле" убран из кнопок выбора (29-й проход, п.6 обзора)
                — это больше не ручное состояние, а вычисляется само по
                текущей просрочке (см. clientDisplayRating/displayRating
                выше), поэтому выбирать остаётся только между "Надёжный" и
                "Чёрный список". */}
            <div className="rating-picker" style={{ alignItems: "center" }}>
              {displayRating === "watch" && <Badge meta={RATING_META[displayRating]} />}
              {/* Постоянная пометка "когда-то был в чёрном списке" (29-й
                  проход, п.8 обзора) — не сбрасывается автоматически, видна
                  и после того, как клиента реабилитировали. */}
              {client.was_blacklisted && client.rating !== "blacklist" && (
                <span title="Раньше уже был в чёрном списке" style={{ display: "inline-block" }}>
                  <Badge meta={{ label: "Был в чёрном списке", tone: "muted" }} />
                </span>
              )}
              <button
                className={"btn btn-sm" + (client.rating === "normal" ? " btn-primary" : "")}
                onClick={() => void setRating("normal")}
              >
                Надёжный
              </button>
              <button
                className={"btn btn-sm" + (client.rating === "blacklist" ? " btn-primary" : "")}
                onClick={() => void setRating("blacklist")}
              >
                Чёрный список
              </button>
            </div>
            {client.rating === "blacklist" && client.blacklist_reason && (
              <div className="field-hint" style={{ marginTop: "8px" }}>
                Причина: {client.blacklist_reason}
              </div>
            )}
            {displayRating === "watch" && client.rating !== "blacklist" && (
              <div className="field-hint" style={{ marginTop: "8px" }}>
                Статус «На контроле» выставляется автоматически, пока у клиента есть просрочка прямо сейчас — вручную
                его включать/выключать не нужно.
              </div>
            )}
          </div>

          <div className="slideover-section">
            <h4>Показатели</h4>
            <div className="kv-grid">
              <span className="k">Выручка за всё время</span>
              <span className="mono">{money(lifetimeRevenue)}</span>
              <span className="k">Просрочек за всё время</span>
              <span className={"mono" + (totalLate > 0 ? " text-critical" : "")}>{totalLate}</span>
              <span className="k">Депозит на удержании сейчас</span>
              <span className="mono">{money(depositHeld)}</span>
              <span className="k">Последняя аренда</span>
              <span>{lastRentalDate(client.id, rentals) ? fmtDate(lastRentalDate(client.id, rentals)) : "—"}</span>
            </div>
          </div>

          <MiniActivityChart
            rentals={history}
            onSelectMonth={(key) => {
              setHistoryMonthFilter(key);
              setShowAllHistory(false);
              setPanelTab("history");
            }}
          />

          <div className="slideover-section">
            <h4>Контакты</h4>
            <div className="kv-grid">
              {/* Телефон отдельной строкой в блоке "Контакты" (29-й проход,
                  п.1 обзора: раньше номер был виден только под именем в
                  шапке, а сам блок "Контакты" его не показывал вовсе) —
                  кликабельная tel:-ссылка. Иконка WhatsApp рядом (35-й
                  проход, обзор "карточка перегружена") — раньше это был
                  отдельный ряд кнопок "Позвонить"/WhatsApp/"Почта" наверху
                  карточки, дублировавший номер, который и так виден здесь;
                  теперь оба способа связаться стоят прямо у значения, к
                  которому относятся, а не оторваны в свой блок. */}
              <span className="k">Телефон</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                {client.phone ? <a href={`tel:${client.phone}`}>{formatPhoneInput(client.phone)}</a> : "—"}
                {client.phone && (
                  <a
                    className="icon-btn"
                    href={`https://wa.me/${normalizePhoneDigits(client.phone)}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Написать в WhatsApp"
                  >
                    <IconSend />
                  </a>
                )}
              </span>
              <span className="k">Email</span>
              <span>{client.email ? <a href={`mailto:${client.email}`}>{client.email}</a> : "—"}</span>
              <span className="k">Документ</span>
              <span>{client.doc ?? "—"}</span>
              {client.client_type === "company" && (
                <>
                  <span className="k">Контактное лицо</span>
                  <span>{client.contact_person ?? "—"}</span>
                  <span className="k">ИНН</span>
                  <span>{client.inn ?? "—"}</span>
                </>
              )}
              <span className="k">День рождения</span>
              <span>{client.birthday ? fmtDate(client.birthday) : "—"}</span>
              <span className="k">Скидка по умолчанию</span>
              <span>{client.default_discount_percent != null ? `${client.default_discount_percent}%` : "—"}</span>
              <span className="k">В базе с</span>
              <span>{fmtDate(client.created_at.slice(0, 10))}</span>
            </div>
            {tagList.length > 0 && (
              <div style={{ marginTop: "10px", display: "flex", gap: "4px", flexWrap: "wrap" }}>
                {tagList.map((t) => (
                  <span key={t} className="badge-tag-custom">
                    {t}
                  </span>
                ))}
              </div>
            )}
            {/* Доп. контакты организации (26-й проход) — только чтение здесь,
                редактируются в форме (ClientFormModal). */}
            {additionalContacts.length > 0 && (
              <div style={{ marginTop: "10px" }}>
                <div className="k" style={{ marginBottom: "4px" }}>
                  Другие контакты
                </div>
                {additionalContacts.map((c, idx) => (
                  <div key={idx} className="mini-item">
                    <span>
                      {c.name}
                      {c.role ? ` · ${c.role}` : ""}
                    </span>
                    {c.phone && (
                      <a className="icon-btn" href={`tel:${c.phone}`} title="Позвонить">
                        <IconPhone />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {client.notes && (
            <div className="slideover-section">
              <h4>Заметки</h4>
              <div style={{ fontSize: "13.5px" }}>{client.notes}</div>
            </div>
          )}

          <ClientDocumentsSection businessId={businessId} clientId={clientId} />
        </>
      )}

      {panelTab === "history" && (
        <div className="slideover-section">
          {historyMonthFilter && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
              <span className="field-hint">Показаны аренды, начатые в {monthKeyToLabel(historyMonthFilter)}</span>
              <button type="button" className="btn btn-sm" onClick={() => setHistoryMonthFilter(null)}>
                Сбросить
              </button>
            </div>
          )}
          {history.length === 0 ? (
            <div className="empty-note">Ещё не сдавалось в аренду</div>
          ) : monthFilteredHistory.length === 0 ? (
            <div className="empty-note">В этом месяце аренд не было</div>
          ) : (
            <>
              {visibleHistory.map((r) => (
                // Клик открывает договор аренды (24-й проход, п.5 обзора: раньше
                // история была статичным текстом, ни одна строка никуда не вела).
                <div
                  className="mini-item clickable"
                  key={r.id}
                  title="Открыть договор аренды"
                  onClick={() => setDocModal({ title: "Договор аренды", node: buildContractDoc(r, client, equipment) })}
                >
                  <span>
                    {r.items.map((it) => equipment.find((eq) => eq.id === it.equipment_id)?.name ?? "—").join(", ")} ·{" "}
                    {fmtDate(r.start_date)}—{fmtDate(r.end_date)}
                  </span>
                  <Badge meta={RENTAL_META[rentalDisplayStatus(r)]} />
                </div>
              ))}
              {monthFilteredHistory.length > HISTORY_PAGE && (
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginTop: "8px" }}
                  onClick={() => setShowAllHistory((v) => !v)}
                >
                  {showAllHistory ? "Свернуть" : `Показать ещё ${monthFilteredHistory.length - HISTORY_PAGE}`}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {panelTab === "journal" && <ClientNotesJournal businessId={businessId} clientId={clientId} />}

      <DocModal title={docModal?.title ?? ""} open={!!docModal} onClose={() => setDocModal(null)}>
        {docModal?.node}
      </DocModal>

      {showMerge && (
        <MergeClientModal
          businessId={businessId}
          source={client}
          clients={clients}
          onClose={() => setShowMerge(false)}
          onMerged={async () => {
            setShowMerge(false);
            await Promise.all([reloadClients(), reloadRentals()]);
            onClose();
          }}
        />
      )}

      {showBlacklistReason && (
        <BlacklistReasonModal
          clientName={client.name}
          onClose={() => setShowBlacklistReason(false)}
          onConfirm={async (reason) => {
            setShowBlacklistReason(false);
            await applyRating("blacklist", reason);
          }}
        />
      )}
    </div>
  );
}
