"""Двадцатый проход: массовое добавление одинаковых позиций (п.3 обзора —
"30 пар одной модели костылей") и независимая длина "шага после" у
ступенчатого тарифа (п.4 обзора — "190₽ за любую часть недели сверху").
См. tests/test_pricing.py для юнит-тестов самой формулы расчёта."""
from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    return client.get("/api/businesses", headers=auth_headers(token)).json()[0]["id"]


# --- Массовое добавление (POST /equipment/bulk) ------------------------------


def test_bulk_create_makes_n_separate_equipment_rows(client):
    owner = register_business(client, email="bulk-owner@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment/bulk",
        json={"name": "Костыли", "category": "Медицинское оборудование", "daily_rate": 100, "quantity": 30},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert len(created) == 30
    # Каждая позиция — своя ОТДЕЛЬНАЯ запись с собственным id (не общая
    # "модель с количеством 30") — так что дальше их статус/история аренд
    # отслеживаются независимо.
    assert len({item["id"] for item in created}) == 30
    for item in created:
        assert item["name"] == "Костыли"
        assert item["status"] == "available"

    listed = client.get(f"/api/businesses/{business_id}/equipment", headers=headers).json()
    assert len(listed) == 30


def test_bulk_create_suffixes_code_when_provided(client):
    owner = register_business(client, email="bulk-code@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment/bulk",
        json={"name": "Костыли", "category": "Мед.", "daily_rate": 100, "code": "INV-100", "quantity": 3},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    codes = sorted(item["code"] for item in resp.json())
    assert codes == ["INV-100-1", "INV-100-2", "INV-100-3"]


def test_bulk_create_without_code_leaves_all_codes_empty(client):
    owner = register_business(client, email="bulk-no-code@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment/bulk",
        json={"name": "Костыли", "category": "Мед.", "daily_rate": 100, "quantity": 2},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    assert all(item["code"] is None for item in resp.json())


def test_bulk_create_quantity_one_does_not_suffix_code(client):
    """quantity=1 (по сути обычное одиночное добавление через тот же
    эндпоинт) не должно менять инвентарный номер добавлением "-1" — только
    quantity>1 создаёт неоднозначность, которую суффикс призван снять."""
    owner = register_business(client, email="bulk-qty1@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment/bulk",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 100, "code": "INV-1", "quantity": 1},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()[0]["code"] == "INV-1"


def test_bulk_create_over_cap_is_rejected(client):
    owner = register_business(client, email="bulk-cap@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment/bulk",
        json={"name": "Костыли", "category": "Мед.", "daily_rate": 100, "quantity": 500},
        headers=headers,
    )
    assert resp.status_code == 422


# --- after_period_days: сквозной путь создание оборудования → аренда --------


def test_equipment_after_period_days_round_trips_through_api(client):
    owner = register_business(client, email="tier-roundtrip@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={
            "name": "Костыли",
            "category": "Мед.",
            "daily_rate": 50,
            "period_days": 14,
            "period_price": 690,
            "period_price_after": 190,
            "after_period_days": 7,
        },
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["after_period_days"] == 7
    assert body["period_price_after"] == 190


def test_rental_snapshot_uses_block_billing_from_equipment_tier(client):
    owner = register_business(client, email="tier-rental@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    eq = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={
            "name": "Костыли",
            "category": "Мед.",
            "daily_rate": 50,
            "period_days": 14,
            "period_price": 690,
            "period_price_after": 190,
            "after_period_days": 7,
        },
        headers=headers,
    ).json()

    client_resp = client.post(f"/api/businesses/{business_id}/clients", json={"name": "Иван"}, headers=headers)
    client_id = client_resp.json()["id"]

    rental = client.post(
        f"/api/businesses/{business_id}/rentals",
        json={
            "client_id": client_id,
            "equipment_ids": [eq["id"]],
            "start_date": "2026-09-01",
            "end_date": "2026-09-16",  # 16 дней — 14 базовых + начатая вторая неделя
        },
        headers=headers,
    )
    assert rental.status_code == 201, rental.text
    body = rental.json()
    assert body["items"][0]["after_period_days_snapshot"] == 7
    # 690 (первые 14 дней) + 190 (один начатый шаг в 7 дней) = 880, а не
    # 690 + 190×2/7 ≈ 744,29, как дала бы старая линейная надбавка.
    assert body["base"] == 690 + 190
