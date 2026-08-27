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
) -> float:
    """Стоимость одной позиции оборудования за `days` дней аренды.

    Без ступенчатого тарифа — просто daily_rate * days.

    Со ступенчатым тарифом: первые `period_days` дней стоят фиксированные
    `period_price` (обычно чуть дешевле, чем `daily_rate * period_days`,
    это и есть стимул для клиента брать технику на неделю сразу).
    Каждый день СВЕРХ period_days стоит `period_price_after / period_days`
    — то есть period_price_after описывает не цену за один лишний день, а
    цену эквивалентного периода при длительной аренде, размазанную на день.
    Это даёт резкое удешевление при аренде на многие недели, что и является
    целью тарифа (стимулировать длинные аренды).
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
    period_days/period_price/period_price_after) — сознательно не завязано
    на ORM-модели, чтобы функция была чистой и юнит-тестируемой в изоляции
    (см. tests/test_pricing.py).

    `today` передаётся явно (а не date.today() внутри) — вызывающий код сам
    решает, что считать "сегодня" (см. app/api/routes/rentals.py), функция
    остаётся чистой и не зависит от системных часов.
    """
    planned_days = span_days(start_date, end_date)

    if actual_return is not None:
        calc_end_date = actual_return
    elif end_date < today:
        calc_end_date = today
    else:
        calc_end_date = end_date

    actual_days = span_days(start_date, calc_end_date)
    late_days = max(0, actual_days - planned_days)

    def _cost_for(days: int) -> float:
        return sum(
            item_cost_for_days(
                daily_rate=it["daily_rate"],
                days=days,
                period_days=it.get("period_days"),
                period_price=it.get("period_price"),
                period_price_after=it.get("period_price_after"),
            )
            for it in items
        )

    # base и actual_cost округляются отдельно, каждый до целого рубля — так
    # late_fee (их разность) тоже получается целым числом рублей для показа
    # в интерфейсе.
    base = round(_cost_for(planned_days))
    actual_cost = round(_cost_for(actual_days))
    late_fee = max(0, actual_cost - base)

    total = max(0, base + late_fee + damage_fee - discount)

    return {
        "planned_days": planned_days,
        "actual_days": actual_days,
        "late_days": late_days,
        "base": base,
        "late_fee": late_fee,
        "damage_fee": damage_fee,
        "discount": discount,
        "total": total,
    }
