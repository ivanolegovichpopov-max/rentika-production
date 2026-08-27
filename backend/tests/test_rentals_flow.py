"""
Сквозной сценарий через реальные HTTP-эндпоинты (не напрямую через
app/services/pricing.py, как в test_pricing.py) — тот же эталонный пример
из истории проекта: 29-дневная аренда с двухступенчатым тарифом даёт 1287 ₽.
Дополнительно проверяет побочные эффекты: статус оборудования меняется на
"в аренде" при выдаче и возвращается в "свободно" после возврата, а клиента
с открытой арендой нельзя удалить.
"""
from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    return client.get("/api/businesses", headers=auth_headers(token)).json()[0]["id"]


def test_full_rental_cycle_matches_reference_price(client):
    owner = register_business(client, email="rentals@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    client_resp = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Тестовый клиент"}, headers=headers
    )
    assert client_resp.status_code == 201
    client_id = client_resp.json()["id"]

    eq_resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={
            "name": "Костыли тест",
            "category": "Медтехника",
            "code": "INV-900",
            "daily_rate": 99,
            "deposit": 1500,
            "period_days": 7,
            "period_price": 690,
            "period_price_after": 190,
        },
        headers=headers,
    )
    assert eq_resp.status_code == 201
    equipment_id = eq_resp.json()["id"]
    assert eq_resp.json()["status"] == "available"

    rental_resp = client.post(
        f"/api/businesses/{business_id}/rentals",
        json={
            "client_id": client_id,
            "equipment_ids": [equipment_id],
            "start_date": "2026-09-01",
            "end_date": "2026-09-29",
        },
        headers=headers,
    )
    assert rental_resp.status_code == 201
    rental = rental_resp.json()
    assert rental["amount"] == 1287
    rental_id = rental["id"]
    # Дата начала (2026-09-01) в будущем относительно "сегодня" тестового
    # окружения — аренда создаётся как бронь, а не сразу активная.
    assert rental["status"] == "booked"

    issue_resp = client.post(f"/api/businesses/{business_id}/rentals/{rental_id}/issue", headers=headers)
    assert issue_resp.status_code == 200
    assert issue_resp.json()["status"] == "active"

    eq_after = client.get(f"/api/businesses/{business_id}/equipment", headers=headers).json()
    assert eq_after[0]["status"] == "rented"

    # Пока аренда не возвращена — оборудование нельзя ещё раз выдать в новую аренду
    conflict_client = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Другой клиент"}, headers=headers
    ).json()
    conflict_resp = client.post(
        f"/api/businesses/{business_id}/rentals",
        json={
            "client_id": conflict_client["id"],
            "equipment_ids": [equipment_id],
            "start_date": "2026-09-05",
            "end_date": "2026-09-10",
        },
        headers=headers,
    )
    assert conflict_resp.status_code == 400

    # Клиента с открытой арендой удалить нельзя
    delete_client_resp = client.delete(f"/api/businesses/{business_id}/clients/{client_id}", headers=headers)
    assert delete_client_resp.status_code == 400

    return_resp = client.post(
        f"/api/businesses/{business_id}/rentals/{rental_id}/return",
        json={"actual_return": "2026-09-29", "damage_fee": 0},
        headers=headers,
    )
    assert return_resp.status_code == 200
    assert return_resp.json()["amount"] == 1287
    assert return_resp.json()["status"] == "returned"

    eq_final = client.get(f"/api/businesses/{business_id}/equipment", headers=headers).json()
    assert eq_final[0]["status"] == "available"


def test_cannot_rent_equipment_that_does_not_belong_to_business(client):
    owner_a = register_business(client, email="rentalsA@example.com", password="correct horse battery staple")
    owner_b = register_business(client, email="rentalsB@example.com", password="correct horse battery staple")

    business_a_id = _get_business_id(client, owner_a["access_token"])
    business_b_id = _get_business_id(client, owner_b["access_token"])

    eq_b = client.post(
        f"/api/businesses/{business_b_id}/equipment",
        json={"name": "Чужое оборудование", "category": "Инструмент", "daily_rate": 100},
        headers=auth_headers(owner_b["access_token"]),
    ).json()

    own_client = client.post(
        f"/api/businesses/{business_a_id}/clients", json={"name": "Клиент A"}, headers=auth_headers(owner_a["access_token"])
    ).json()

    resp = client.post(
        f"/api/businesses/{business_a_id}/rentals",
        json={
            "client_id": own_client["id"],
            "equipment_ids": [eq_b["id"]],
            "start_date": "2026-09-01",
            "end_date": "2026-09-05",
        },
        headers=auth_headers(owner_a["access_token"]),
    )
    assert resp.status_code == 400
