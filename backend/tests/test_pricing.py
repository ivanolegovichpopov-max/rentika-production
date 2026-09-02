"""
Регрессионный тест на тот же эталонный пример, что использовался при
проверке index-supabase.html (smoke_test14_supabase.js): ступенчатый тариф
99/день, period_days=7, period_price=690, period_price_after=190,
29-дневная аренда (2026-09-01..2026-09-29) должна давать ровно 1287 ₽.
Если этот тест когда-нибудь начнёт падать при рефакторинге pricing.py —
значит сломана обратная совместимость с уже посчитанными в проде арендами.
"""
from datetime import date

from app.services.pricing import compute_rental_amount, compute_rental_breakdown, item_cost_for_days, span_days


def test_span_days_inclusive():
    assert span_days(date(2026, 9, 1), date(2026, 9, 29)) == 29


def test_tiered_pricing_matches_original_spec_example():
    days = span_days(date(2026, 9, 1), date(2026, 9, 29))
    cost = item_cost_for_days(
        daily_rate=99, days=days, period_days=7, period_price=690, period_price_after=190
    )
    assert compute_rental_amount([cost]) == 1287


def test_simple_daily_pricing_without_tier():
    assert item_cost_for_days(daily_rate=500, days=3) == 1500


def test_pricing_within_period_uses_daily_rate_not_period_price():
    # 5 дней <= period_days=7 → ступенчатый тариф ещё не включается
    cost = item_cost_for_days(daily_rate=99, days=5, period_days=7, period_price=690, period_price_after=190)
    assert cost == 495


def test_multiple_items_sum_before_rounding():
    days = 29
    cost_a = item_cost_for_days(daily_rate=99, days=days, period_days=7, period_price=690, period_price_after=190)
    cost_b = item_cost_for_days(daily_rate=200, days=days)
    total = compute_rental_amount([cost_a, cost_b], damage_fee=50)
    assert total == round(cost_a + cost_b + 50)


# --- compute_rental_breakdown ------------------------------------------------
#
# Раскладка для карточки аренды во фронтенде (planned_days/actual_days/
# late_days/base/late_fee/total) — см. app/services/pricing.py:compute_rental_breakdown.


def test_breakdown_simple_rental_with_no_overdue_damage_or_discount():
    breakdown = compute_rental_breakdown(
        items=[{"daily_rate": 500}],
        start_date=date(2026, 1, 1),
        end_date=date(2026, 1, 3),
        actual_return=None,
        today=date(2026, 1, 3),  # ещё не просрочена
        damage_fee=0,
        discount=0,
    )
    assert breakdown["planned_days"] == 3
    assert breakdown["actual_days"] == 3
    assert breakdown["late_days"] == 0
    assert breakdown["base"] == 1500
    assert breakdown["late_fee"] == 0
    assert breakdown["total"] == breakdown["base"]


def test_breakdown_overdue_rental_extends_same_tiered_tariff_not_flat_rate():
    """Тот же эталонный пример (daily_rate=99, period_days=7, period_price=690,
    period_price_after=190), что и в test_tiered_pricing_matches_original_spec_example:
    29-дневная аренда (2026-09-01..2026-09-29) без фактического возврата,
    просроченная относительно today=2026-10-05 (35 дней по факту). late_fee —
    это разница тарифа на 35 и на 29 дней ПО ТОЙ ЖЕ ступенчатой формуле, а не
    (actual_days - planned_days) * daily_rate."""
    breakdown = compute_rental_breakdown(
        items=[{"daily_rate": 99, "period_days": 7, "period_price": 690, "period_price_after": 190}],
        start_date=date(2026, 9, 1),
        end_date=date(2026, 9, 29),
        actual_return=None,
        today=date(2026, 10, 5),
        damage_fee=0,
        discount=0,
    )
    assert breakdown["planned_days"] == 29
    assert breakdown["base"] == 1287  # регрессия на эталонный пример
    assert breakdown["actual_days"] == 35
    assert breakdown["late_days"] == 6

    # late_fee посчитан вручную по той же ступенчатой формуле на 35 дней:
    # 690 + (35-7) * (190/7) = 690 + 760 = 1450 → late_fee = 1450 - 1287 = 163.
    manual_actual_cost = item_cost_for_days(
        daily_rate=99, days=35, period_days=7, period_price=690, period_price_after=190
    )
    assert breakdown["late_fee"] == round(manual_actual_cost) - breakdown["base"]
    assert breakdown["late_fee"] == 163

    # Флат-ставка дала бы 6 * 99 = 594 — заметно больше, чем реальные 163:
    # тариф удешевляется на длинной дистанции, штраф не должен «наказывать»
    # сильнее, чем обычная стоимость аренды на эти же дни.
    assert breakdown["late_fee"] != 6 * 99
    assert breakdown["total"] == breakdown["base"] + breakdown["late_fee"]


def test_breakdown_with_damage_fee_and_discount():
    breakdown = compute_rental_breakdown(
        items=[{"daily_rate": 99, "period_days": 7, "period_price": 690, "period_price_after": 190}],
        start_date=date(2026, 9, 1),
        end_date=date(2026, 9, 29),
        actual_return=None,
        today=date(2026, 10, 5),
        damage_fee=200,
        discount=300,
    )
    assert breakdown["total"] == breakdown["base"] + breakdown["late_fee"] + 200 - 300


def test_breakdown_total_floors_at_zero_when_discount_exceeds_the_rest():
    breakdown = compute_rental_breakdown(
        items=[{"daily_rate": 500}],
        start_date=date(2026, 1, 1),
        end_date=date(2026, 1, 3),
        actual_return=None,
        today=date(2026, 1, 3),
        damage_fee=0,
        discount=10_000,
    )
    assert breakdown["base"] == 1500
    assert breakdown["total"] == 0


def test_breakdown_uses_actual_return_over_today_when_present():
    # actual_return в прошлом (аренда была вовремя закрыта) — today не должен
    # переопределять уже зафиксированную фактическую дату возврата.
    breakdown = compute_rental_breakdown(
        items=[{"daily_rate": 99, "period_days": 7, "period_price": 690, "period_price_after": 190}],
        start_date=date(2026, 9, 1),
        end_date=date(2026, 9, 29),
        actual_return=date(2026, 9, 29),
        today=date(2026, 10, 5),
        damage_fee=0,
        discount=0,
    )
    assert breakdown["actual_days"] == 29
    assert breakdown["late_fee"] == 0
    assert breakdown["total"] == 1287


# --- returned_at по позиции: частичный возврат (41-й проход) ----------------


def test_partial_return_uses_per_item_actual_days():
    """Две позиции одной аренды, возвращённые в РАЗНЫЕ дни (одна вовремя,
    другая на 3 дня позже) — late_fee должен считаться по факт. дням КАЖДОЙ
    позиции отдельно, а не по одному общему числу дней на всю аренду."""
    breakdown = compute_rental_breakdown(
        items=[
            {"daily_rate": 100, "returned_at": date(2026, 9, 5)},  # вовремя, 5 дней
            {"daily_rate": 200, "returned_at": date(2026, 9, 8)},  # на 3 дня позже, 8 дней
        ],
        start_date=date(2026, 9, 1),
        end_date=date(2026, 9, 5),
        actual_return=None,
        today=date(2026, 9, 10),
        damage_fee=0,
        discount=0,
    )
    assert breakdown["planned_days"] == 5
    assert breakdown["base"] == 100 * 5 + 200 * 5  # 1500, по плановым дням — как раньше
    assert breakdown["actual_days"] == 8  # по самой долго отсутствовавшей позиции
    assert breakdown["late_days"] == 3
    # actual_cost = 100*5 (вовремя) + 200*8 (на 3 дня позже) = 500 + 1600 = 2100
    assert breakdown["late_fee"] == (100 * 5 + 200 * 8) - breakdown["base"]
    assert breakdown["late_fee"] == 600
    assert breakdown["total"] == breakdown["base"] + breakdown["late_fee"]


def test_partial_return_missing_returned_at_falls_back_like_before():
    """Позиция без своего returned_at считается по общему actual_return/today —
    ТОЧНО так же, как до появления частичного возврата (обратная
    совместимость: перемешанный список, где у одной позиции returned_at
    есть, а у другой нет, потому что вторую вернули обычным полным
    возвратом, который бэкафиллит returned_at всем сразу — см.
    app/api/routes/rentals.py:return_rental)."""
    with_partial = compute_rental_breakdown(
        items=[
            {"daily_rate": 100, "returned_at": date(2026, 9, 6)},
            {"daily_rate": 100},  # нет своего returned_at — использует actual_return ниже
        ],
        start_date=date(2026, 9, 1),
        end_date=date(2026, 9, 5),
        actual_return=date(2026, 9, 6),
        today=date(2026, 9, 10),
        damage_fee=0,
        discount=0,
    )
    without_partial = compute_rental_breakdown(
        items=[{"daily_rate": 100}, {"daily_rate": 100}],
        start_date=date(2026, 9, 1),
        end_date=date(2026, 9, 5),
        actual_return=date(2026, 9, 6),
        today=date(2026, 9, 10),
        damage_fee=0,
        discount=0,
    )
    assert with_partial == without_partial


# --- after_period_days: блочная ("любая часть шага сверху") надбавка --------
#
# Двадцатый проход, п.4 обзора: "190₽ за любую часть недели сверху" — вместо
# старой линейной надбавки (period_price_after, делённая на period_days и
# размазанная на каждый день) теперь у "шага после" СВОЯ длина, и он
# начисляется целиком за любой начатый шаг, а не пропорционально дням.


def test_after_period_days_charges_full_block_for_a_partial_extra_week():
    """Ровно пример из обзора пользователя: костыли — 690₽ за первые 14 дней,
    затем 190₽ за каждую начатую неделю сверху. 16 дней аренды = 14 базовых +
    2 дня в НАЧАТУЮ, но не закрытую вторую неделю → всё равно полные 190₽,
    а не 190×2/7 ≈ 54,29₽, как дала бы старая линейная формула."""
    cost = item_cost_for_days(
        daily_rate=50, days=16, period_days=14, period_price=690, period_price_after=190, after_period_days=7
    )
    assert cost == 690 + 190  # ровно один начатый шаг сверху


def test_after_period_days_charges_two_full_blocks_when_extra_days_fill_them_exactly():
    # 14 базовых + ровно 14 дней сверху (два полных семидневных шага) — без
    # "лишнего" начатого шага.
    cost = item_cost_for_days(
        daily_rate=50, days=28, period_days=14, period_price=690, period_price_after=190, after_period_days=7
    )
    assert cost == 690 + 190 * 2


def test_after_period_days_one_day_matches_old_ui_conversion():
    """Сап-борд из обзора: 2290₽ за первые 3 дня, затем 490₽/сутки. ДО этого
    прохода форма конвертировала введённую пользователем "цену за сутки"
    (490) в period_price_after = 490×period_days ПЕРЕД отправкой на backend
    (см. историю EquipmentTab.tsx:formToPayload/periodPriceAfterPerDay) —
    поэтому реальный старый сквозной сценарий "хочу 490₽/сутки" хранился как
    period_price_after=1470 при period_days=3, а не как 490. Новая механика
    (after_period_days=1, period_price_after=490 — уже без скрытого
    умножения) должна давать РОВНО ТО ЖЕ число для того же самого желания
    пользователя, потому что число дней аренды всегда целое — "любой начатый
    шаг в 1 день" и "линейная надбавка по дням" тождественны. Это и есть
    гарантия того, что бэкафилл существующих позиций
    (0011_equipment_ordering_and_tiered_pricing.py, after_period_days=1 с
    пересчётом period_price_after/period_days) не меняет задним числом уже
    посчитанные суммы."""
    days = 9  # 3 базовых + 6 суток сверху
    old_style_period_price_after = 490 * 3  # то, что раньше реально отправляла форма
    without_after_period_days = item_cost_for_days(
        daily_rate=99, days=days, period_days=3, period_price=2290, period_price_after=old_style_period_price_after
    )
    with_block = item_cost_for_days(
        daily_rate=99, days=days, period_days=3, period_price=2290, period_price_after=490, after_period_days=1
    )
    assert with_block == without_after_period_days == 2290 + 490 * 6


def test_after_period_days_within_first_period_still_uses_daily_rate():
    # Тот же принцип, что и test_pricing_within_period_uses_daily_rate_not_period_price
    # выше — after_period_days вообще не участвует, пока дни аренды не
    # превысили period_days.
    cost = item_cost_for_days(
        daily_rate=50, days=10, period_days=14, period_price=690, period_price_after=190, after_period_days=7
    )
    assert cost == 500


def test_breakdown_with_after_period_days_matches_block_billing():
    breakdown = compute_rental_breakdown(
        items=[
            {
                "daily_rate": 50,
                "period_days": 14,
                "period_price": 690,
                "period_price_after": 190,
                "after_period_days": 7,
            }
        ],
        start_date=date(2026, 9, 1),
        end_date=date(2026, 9, 16),  # 16 дней — 14 + начатая вторая неделя
        actual_return=None,
        today=date(2026, 9, 16),
        damage_fee=0,
        discount=0,
    )
    assert breakdown["planned_days"] == 16
    assert breakdown["base"] == 690 + 190
