"""
Регрессионный тест на тот же эталонный пример, что использовался при
проверке index-supabase.html (smoke_test14_supabase.js): ступенчатый тариф
99/день, period_days=7, period_price=690, period_price_after=190,
29-дневная аренда (2026-09-01..2026-09-29) должна давать ровно 1287 ₽.
Если этот тест когда-нибудь начнёт падать при рефакторинге pricing.py —
значит сломана обратная совместимость с уже посчитанными в проде арендами.
"""
from datetime import date

from app.services.pricing import compute_rental_amount, item_cost_for_days, span_days


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
