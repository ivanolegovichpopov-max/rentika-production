"""
Портированная бизнес-логика тарификации из клиентского прототипа
(index.html / index-supabase.html, функции spanDays/itemCostForDays —
см. SPEC.md разделы 4.1-4.8 исходного проекта). Формула ступенчатого тарифа
проверена регрессионным тестом (см. tests/test_pricing.py) на эталонном
примере из спецификации: dailyRate=99, periodDays=7, periodPrice=690,
periodPriceAfter=190, 29-дневная аренда → 1287 ₽.
"""
from datetime import date


def span_days(start_date: date, end_date: date) -> int:
    """Число дней аренды включительно (последний день засчитывается) — так
    исторически считает прототип: 1-29 сентября = 29 дней, не 28."""
    return (end_date - start_date).days + 1


def item_cost_for_days(
    *,
    daily_rate: float,
    days: int,
    period_days: int | None = None,
    period_price: float | None = None,
    period_price_after: float | None = None,
    after_period_days: int | None = None,
) -> float:
    """Стоимость одной позиции оборудования за `days` дней аренды.

    Без ступенчатого тарифа — просто daily_rate * days.

    Со ступенчатым тарифом: первые `period_days` дней стоят фиксированные
    `period_price` (обычно чуть дешевле, чем `daily_rate * period_days`,
    это и есть стимул для клиента брать технику на неделю сразу).

    Цена ПОСЛЕ period_days зависит от того, передан ли `after_period_days`
    (двадцатый проход, п.4 обзора — "190₽ за любую часть недели сверху"):

    - `after_period_days` задан (так теперь всегда хранится в БД, если у
      позиции вообще настроен ступенчатый тариф — см. Equipment.
      after_period_days) — БЛОЧНАЯ надбавка: каждый ПОЛНЫЙ ИЛИ НАЧАТЫЙ шаг
      длиной `after_period_days` дней сверх `period_days` стоит
      `period_price_after` целиком (не делится и не размазывается). Пример
      из обзора: period_days=14, period_price=690, after_period_days=7,
      period_price_after=190 — 16 дней аренды (14 + начатая вторая неделя)
      стоят 690+190=880, а не 690 + 190×2/7.

    - `after_period_days` не задан (None) — СТАРАЯ линейная механика:
      `period_price_after / period_days` за каждый день сверх period_days
      без округления до целых шагов. Это НЕ отдельный отдельный от блочной
      механики "второй тариф" — это ровно то же самое семейство формул при
      after_period_days == 1 (extra_days всегда целое число дней, поэтому
      "полный или начатый шаг в 1 день" и "линейная надбавка по дням"
      численно совпадают), просто оставленное как явный фолбэк для сырых
      вызовов этой функции без after_period_days — ТАК ЖЕ, как и до
      двадцатого прохода. Существующие записи в БД после миграции
      0011_equipment_ordering_and_tiered_pricing.py всегда несут явный
      after_period_days=1 (с уже пересчитанным period_price_after под цену
      за одни сутки) и в этот фолбэк не попадают — им не нужно: см.
      докстринг миграции про тождественность обеих формул при шаге в 1 день.
      Регрессионный тест на эталонный пример из старой спецификации
      (tests/test_pricing.py:test_tiered_pricing_matches_original_spec_example)
      сознательно вызывает функцию БЕЗ after_period_days и должен продолжать
      давать то же число — это гарантия того, что рефакторинг не поменял
      задним числом уже посчитанные в проде (до этого прохода) суммы.
    """
    # Намеренно НЕ округляется здесь — промежуточное округление на каждой
    # позиции разошлось бы с итоговой суммой аренды из нескольких позиций.
    # Округление до целого рубля происходит один раз, в compute_rental_amount,
    # ровно как в оригинальном клиентском прототипе.
    if not period_days or not period_price:
        return daily_rate * days

    if days <= period_days:
        return daily_rate * days

    extra_days = days - period_days

    if after_period_days:
        # Целочисленное деление с округлением ВВЕРХ ("полный или начатый
        # шаг") — extra_days и after_period_days всегда положительные целые,
        # так что классический приём -(-a // b) корректен и не требует
        # import math/float-деления (никакого риска погрешности округления).
        blocks = -(-extra_days // after_period_days)
        return period_price + blocks * (period_price_after or 0)

    per_day_after = (period_price_after or 0) / period_days
    return period_price + extra_days * per_day_after


def compute_rental_amount(item_costs: list[float], damage_fee: float = 0) -> int:
    """Итоговая сумма аренды в целых рублях (копейки в интерфейсе не
    показываются нигде в проекте — округление до целого здесь единственное
    и финальное)."""
    return round(sum(item_costs) + damage_fee)


def compute_rental_breakdown(
    *,
    items: list[dict],
    start_date: date,
    end_date: date,
    actual_return: date | None,
    today: date,
    damage_fee: float = 0,
    discount: float = 0,
    # Доп. услуги (46-й проход, см. Rental.extra_fee) — ОДНО значение,
    # заменяемое целиком (как discount), а не накопительная сумма (как
    # damage_fee технически тоже одно поле, но пополняется несколькими
    # заходами через return-items). Входит в total наравне с damage_fee.
    extra_fee: float = 0,
) -> dict:
    """Полная финансовая раскладка аренды для карточки в интерфейсе (перенос
    логики прототипа — см. index.html/index-supabase.html, отрисовка
    plannedDays/actualDays/lateDays/base/lateFee/total в карточке аренды).

    Ключевая идея прототипа: пени за просрочку — это НЕ отдельная штрафная
    ставка, а тот же ступенчатый тариф, просто применённый к фактическому
    (более длинному) числу дней вместо планового. late_fee — это разница
    между стоимостью аренды на факт. дни и стоимостью на план. дни: продлевая
    аренду сверх end_date, клиент просто "доезжает" по тому же тарифу дальше,
    в том числе попадая в более выгодную ступень, если период достаточно
    длинный — это НЕ штраф по дневной ставке.

    `items` — список словарей со снимком цены каждой позиции оборудования
    (те же ключи, что принимает item_cost_for_days: daily_rate, опционально
    period_days/period_price/period_price_after/after_period_days) — сознательно не завязано
    на ORM-модели, чтобы функция была чистой и юнит-тестируемой в изоляции
    (см. tests/test_pricing.py).

    `today` передаётся явно (а не date.today() внутри) — вызывающий код сам
    решает, что считать "сегодня" (см. app/api/routes/rentals.py), функция
    остаётся чистой и не зависит от системных часов.

    Каждый элемент `items` может дополнительно нести свой собственный
    `returned_at` (date | None) — 41-й проход, частичный возврат по позициям
    (см. RentalItem.returned_at в app/models/inventory.py): если клиент
    вернул часть оборудования раньше остальных, у РАЗНЫХ позиций аренды
    оказываются РАЗНЫЕ фактические сроки. Раньше actual_days был одним
    числом на всю аренду — теперь считается ПО КАЖДОЙ позиции отдельно (её
    собственный returned_at, а если его нет — тот же общий `actual_return`/
    "сегодня"/end_date, что и раньше), и в сумму на факт. дни каждая позиция
    входит со своим числом дней. Если ни у одной позиции returned_at не
    задан (все обычные, не частично возвращённые аренды — подавляющее
    большинство, включая все аренды до этого прохода), это математически
    ТО ЖЕ САМОЕ значение для каждой позиции, что и раньше — обратная
    совместимость гарантирована, а не просто предполагается (см.
    tests/test_pricing.py:test_partial_return_uses_per_item_actual_days и
    неизменный test_tiered_pricing_matches_original_spec_example рядом).
    """
    planned_days = span_days(start_date, end_date)

    if actual_return is not None:
        fallback_end_date = actual_return
    elif end_date < today:
        fallback_end_date = today
    else:
        fallback_end_date = end_date

    def _item_actual_days(it: dict) -> int:
        item_end = it.get("returned_at") or fallback_end_date
        return span_days(start_date, item_end)

    def _cost_for_planned() -> float:
        return sum(
            item_cost_for_days(
                daily_rate=it["daily_rate"],
                days=planned_days,
                period_days=it.get("period_days"),
                period_price=it.get("period_price"),
                period_price_after=it.get("period_price_after"),
                after_period_days=it.get("after_period_days"),
            )
            for it in items
        )

    def _cost_for_actual() -> float:
        return sum(
            item_cost_for_days(
                daily_rate=it["daily_rate"],
                days=_item_actual_days(it),
                period_days=it.get("period_days"),
                period_price=it.get("period_price"),
                period_price_after=it.get("period_price_after"),
                after_period_days=it.get("after_period_days"),
            )
            for it in items
        )

    # base и actual_cost округляются отдельно, каждый до целого рубля — так
    # late_fee (их разность) тоже получается целым числом рублей для показа
    # в интерфейсе.
    base = round(_cost_for_planned())
    actual_cost = round(_cost_for_actual())
    late_fee = max(0, actual_cost - base)

    # actual_days/late_days для интерфейса — по САМОЙ ДОЛГО отсутствующей
    # позиции (если все позиции делят один и тот же факт. срок, как раньше,
    # max по одинаковым числам даёт то же самое число — снова обратная
    # совместимость "бесплатно", без отдельной ветки кода на этот случай).
    actual_days = max((_item_actual_days(it) for it in items), default=planned_days)
    late_days = max(0, actual_days - planned_days)

    total = max(0, base + late_fee + damage_fee + extra_fee - discount)

    return {
        "planned_days": planned_days,
        "actual_days": actual_days,
        "late_days": late_days,
        "base": base,
        "late_fee": late_fee,
        "damage_fee": damage_fee,
        "extra_fee": extra_fee,
        "discount": discount,
        "total": total,
    }
