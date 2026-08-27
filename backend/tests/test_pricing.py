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
