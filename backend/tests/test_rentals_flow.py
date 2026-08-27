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


def test_return_with_damage_fee_and_discount_reflects_in_breakdown(client):
    owner = register_business(client, email="breakdown@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Клиент раскладки"}, headers=headers
    ).json()["id"]

    eq = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Тестовая техника", "category": "Инструмент", "daily_rate": 500, "deposit": 2000},
        headers=headers,
    ).json()

    rental = client.post(
        f"/api/businesses/{business_id}/rentals",
        json={
            "client_id": client_id,
            "equipment_ids": [eq["id"]],
            "start_date": "2026-09-01",
            "end_date": "2026-09-03",
        },
        headers=headers,
    ).json()
    assert rental["planned_days"] == 3
    assert rental["base"] == 1500
    assert rental["deposit_total"] == 2000
    rental_id = rental["id"]

    client.post(f"/api/businesses/{business_id}/rentals/{rental_id}/issue", headers=headers)

    return_resp = client.post(
        f"/api/businesses/{business_id}/rentals/{rental_id}/return",
        json={"actual_return": "2026-09-03", "damage_fee": 200, "discount": 300},
        headers=headers,
    )
    assert return_resp.status_code == 200
    returned = return_resp.json()
    assert returned["base"] == 1500
    assert returned["late_fee"] == 0
    assert returned["damage_fee"] == 200
    assert returned["discount"] == 300
    assert returned["total"] == 1500 + 0 + 200 - 300
    assert returned["amount"] == returned["total"]
    assert returned["deposit_total"] == 2000


def test_client_email_and_doc_round_trip_through_create_and_update(client):
    owner = register_business(client, email="clientfields@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    create_resp = client.post(
        f"/api/businesses/{business_id}/clients",
        json={"name": "Клиент с почтой", "email": "client@example.com", "doc": "1234 567890"},
        headers=headers,
    )
    assert create_resp.status_code == 201
    created = create_resp.json()
    assert created["email"] == "client@example.com"
    assert created["doc"] == "1234 567890"
    client_id = created["id"]

    # email намеренно без уникальности — второй клиент с тем же email должен
    # спокойно создаваться (см. app/models/inventory.py:Client.email).
    other_resp = client.post(
        f"/api/businesses/{business_id}/clients",
        json={"name": "Другой клиент, та же почта", "email": "client@example.com"},
        headers=headers,
    )
    assert other_resp.status_code == 201

    update_resp = client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}",
        json={"name": "Клиент с почтой", "email": "updated@example.com", "doc": "9999 111222"},
        headers=headers,
    )
    assert update_resp.status_code == 200
    updated = update_resp.json()
    assert updated["email"] == "updated@example.com"
    assert updated["doc"] == "9999 111222"

    list_resp = client.get(f"/api/businesses/{business_id}/clients", headers=headers)
    assert list_resp.status_code == 200
    listed = next(c for c in list_resp.json() if c["id"] == client_id)
    assert listed["email"] == "updated@example.com"
    assert listed["doc"] == "9999 111222"


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
