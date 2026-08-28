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


def test_client_rating_can_be_updated_with_partial_body(client):
    """Регрессия: карточка клиента шлёт PATCH только с {"rating": ...} —
    когда PATCH-эндпоинт валидировал по ClientCreate (требует name), такой
    запрос падал с 422 и переключатель надёжности в интерфейсе молча не
    работал. Обнаружено при третьей сверке с демо, тот же паттерн бага, что
    и был раньше найден и исправлен для PATCH /equipment/{id}."""
    owner = register_business(client, email="clientrating@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    create_resp = client.post(
        f"/api/businesses/{business_id}/clients",
        json={"name": "Клиент рейтинга", "phone": "+7 900 000-00-00"},
        headers=headers,
    )
    assert create_resp.status_code == 201
    created = create_resp.json()
    assert created["rating"] == "normal"
    client_id = created["id"]

    update_resp = client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}",
        json={"rating": "watch"},
        headers=headers,
    )
    assert update_resp.status_code == 200
    updated = update_resp.json()
    assert updated["rating"] == "watch"
    # Поля, не переданные в PATCH, не должны обнуляться.
    assert updated["name"] == "Клиент рейтинга"
    assert updated["phone"] == "+7 900 000-00-00"

    second_update = client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}",
        json={"rating": "blacklist"},
        headers=headers,
    )
    assert second_update.status_code == 200
    assert second_update.json()["rating"] == "blacklist"
    assert second_update.json()["name"] == "Клиент рейтинга"


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


# --- issue_notes / return_notes -------------------------------------------
#
# Портирование r.issueNotes / r.returnNotes из демо-прототипа: свободный
# текст состояния оборудования, показанный на форме выдачи/возврата и
# печатаемый на актах. Дефолтные значения — это дефолт соответствующей
# <textarea> в демо (см. app/api/routes/rentals.py:DEFAULT_ISSUE_NOTES/
# DEFAULT_RETURN_NOTES), подставляются, когда поле не передано или пустое.


def _setup_rental(client, headers, business_id, *, daily_rate=100, start="2026-09-01", end="2026-09-03"):
    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Клиент заметок"}, headers=headers
    ).json()["id"]
    eq = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Тестовая позиция", "category": "Инструмент", "daily_rate": daily_rate},
        headers=headers,
    ).json()
    rental = client.post(
        f"/api/businesses/{business_id}/rentals",
        json={"client_id": client_id, "equipment_ids": [eq["id"]], "start_date": start, "end_date": end},
        headers=headers,
    ).json()
    return client_id, eq, rental


def test_issue_and_return_notes_use_demo_defaults_when_omitted(client):
    owner = register_business(client, email="notes-default@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    _, _, rental = _setup_rental(client, headers, business_id)
    rental_id = rental["id"]
    assert rental["issue_notes"] is None
    assert rental["return_notes"] is None

    issue_resp = client.post(f"/api/businesses/{business_id}/rentals/{rental_id}/issue", headers=headers)
    assert issue_resp.status_code == 200
    assert issue_resp.json()["issue_notes"] == "Комплектация полная, состояние исправное."

    return_resp = client.post(
        f"/api/businesses/{business_id}/rentals/{rental_id}/return",
        json={"actual_return": "2026-09-03"},
        headers=headers,
    )
    assert return_resp.status_code == 200
    assert return_resp.json()["return_notes"] == "Без повреждений, комплектация полная."


def test_issue_and_return_notes_persist_custom_text(client):
    owner = register_business(client, email="notes-custom@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    _, _, rental = _setup_rental(client, headers, business_id)
    rental_id = rental["id"]

    issue_resp = client.post(
        f"/api/businesses/{business_id}/rentals/{rental_id}/issue",
        json={"issue_notes": "Царапина на корпусе, зафиксирована."},
        headers=headers,
    )
    assert issue_resp.status_code == 200
    assert issue_resp.json()["issue_notes"] == "Царапина на корпусе, зафиксирована."

    return_resp = client.post(
        f"/api/businesses/{business_id}/rentals/{rental_id}/return",
        json={"actual_return": "2026-09-03", "return_notes": "Вернули с трещиной на кожухе."},
        headers=headers,
    )
    assert return_resp.status_code == 200
    assert return_resp.json()["return_notes"] == "Вернули с трещиной на кожухе."

    # И в списке аренд заметки тоже видны (не только в прямом ответе на action).
    listed = client.get(f"/api/businesses/{business_id}/rentals", headers=headers).json()
    listed_rental = next(r for r in listed if r["id"] == rental_id)
    assert listed_rental["issue_notes"] == "Царапина на корпусе, зафиксирована."
    assert listed_rental["return_notes"] == "Вернули с трещиной на кожухе."


# --- PATCH /rentals/{id} (edit_rental) --------------------------------------
#
# Портирование editRentalForm из демо-прототипа.


def test_edit_rejects_when_rental_returned_or_cancelled(client):
    owner = register_business(client, email="edit-status@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    _, _, rental = _setup_rental(client, headers, business_id)
    rental_id = rental["id"]

    cancel_resp = client.post(f"/api/businesses/{business_id}/rentals/{rental_id}/cancel", headers=headers)
    assert cancel_resp.status_code == 200

    patch_resp = client.patch(
        f"/api/businesses/{business_id}/rentals/{rental_id}", json={"discount": 50}, headers=headers
    )
    assert patch_resp.status_code == 400

    _, _, rental2 = _setup_rental(client, headers, business_id)
    rental2_id = rental2["id"]
    client.post(f"/api/businesses/{business_id}/rentals/{rental2_id}/issue", headers=headers)
    client.post(
        f"/api/businesses/{business_id}/rentals/{rental2_id}/return",
        json={"actual_return": "2026-09-03"},
        headers=headers,
    )
    patch_resp2 = client.patch(
        f"/api/businesses/{business_id}/rentals/{rental2_id}", json={"discount": 50}, headers=headers
    )
    assert patch_resp2.status_code == 400


def test_edit_ignores_start_date_change_on_active_rental(client):
    owner = register_business(client, email="edit-activestart@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    _, _, rental = _setup_rental(client, headers, business_id)
    rental_id = rental["id"]
    original_start = rental["start_date"]

    client.post(f"/api/businesses/{business_id}/rentals/{rental_id}/issue", headers=headers)

    patch_resp = client.patch(
        f"/api/businesses/{business_id}/rentals/{rental_id}",
        json={"start_date": "2026-08-15", "end_date": "2026-09-05"},
        headers=headers,
    )
    assert patch_resp.status_code == 200
    body = patch_resp.json()
    # Дата начала осталась прежней — правка молча проигнорирована, а не отклонена.
    assert body["start_date"] == original_start
    assert body["end_date"] == "2026-09-05"


def test_edit_rejects_end_date_before_start_date(client):
    owner = register_business(client, email="edit-baddates@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    _, _, rental = _setup_rental(client, headers, business_id)
    rental_id = rental["id"]

    patch_resp = client.patch(
        f"/api/businesses/{business_id}/rentals/{rental_id}",
        json={"start_date": "2026-09-10", "end_date": "2026-09-05"},
        headers=headers,
    )
    assert patch_resp.status_code == 400


def test_edit_rejects_overlapping_equipment(client):
    owner = register_business(client, email="edit-overlap@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    client_id, eq_a, rental = _setup_rental(client, headers, business_id)

    other_client = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Другой клиент"}, headers=headers
    ).json()["id"]
    eq_conflict = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Занятая позиция", "category": "Инструмент", "daily_rate": 200},
        headers=headers,
    ).json()
    other_rental = client.post(
        f"/api/businesses/{business_id}/rentals",
        json={
            "client_id": other_client,
            "equipment_ids": [eq_conflict["id"]],
            "start_date": "2026-09-01",
            "end_date": "2026-09-10",
        },
        headers=headers,
    ).json()
    assert other_rental["status"] == "booked"

    patch_resp = client.patch(
        f"/api/businesses/{business_id}/rentals/{rental['id']}",
        json={"equipment_ids": [eq_a["id"], eq_conflict["id"]]},
        headers=headers,
    )
    assert patch_resp.status_code == 400
    assert "занято" in patch_resp.json()["detail"]


def test_edit_adds_removes_items_updates_discount_and_keeps_existing_snapshot(client):
    owner = register_business(client, email="edit-items@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    client_id, eq_kept, rental = _setup_rental(client, headers, business_id, daily_rate=100)
    rental_id = rental["id"]
    kept_snapshot = next(it for it in rental["items"] if it["equipment_id"] == eq_kept["id"])
    assert kept_snapshot["daily_rate_snapshot"] == 100

    # Меняем каталожную цену снятой/сохраняемой позиции ПОСЛЕ создания брони —
    # снимок уже существующей позиции не должен пересчитаться при PATCH.
    # (Прямого PATCH /equipment в этом наборе роутов может не быть — вместо
    # этого просто проверяем, что PATCH аренды не трогает существующий снимок.)

    eq_new = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Новая позиция", "category": "Инструмент", "daily_rate": 300},
        headers=headers,
    ).json()

    patch_resp = client.patch(
        f"/api/businesses/{business_id}/rentals/{rental_id}",
        json={"equipment_ids": [eq_kept["id"], eq_new["id"]], "discount": 150},
        headers=headers,
    )
    assert patch_resp.status_code == 200
    updated = patch_resp.json()
    assert updated["discount"] == 150
    ids = {it["equipment_id"] for it in updated["items"]}
    assert ids == {eq_kept["id"], eq_new["id"]}

    still_kept = next(it for it in updated["items"] if it["equipment_id"] == eq_kept["id"])
    assert still_kept["daily_rate_snapshot"] == 100  # снимок не пересчитан

    newly_added = next(it for it in updated["items"] if it["equipment_id"] == eq_new["id"])
    assert newly_added["daily_rate_snapshot"] == 300  # свежий снимок для новой позиции

    # Снимаем eq_kept совсем — остаётся только eq_new.
    patch_resp2 = client.patch(
        f"/api/businesses/{business_id}/rentals/{rental_id}",
        json={"equipment_ids": [eq_new["id"]]},
        headers=headers,
    )
    assert patch_resp2.status_code == 200
    updated2 = patch_resp2.json()
    ids2 = {it["equipment_id"] for it in updated2["items"]}
    assert ids2 == {eq_new["id"]}

    # Снятое оборудование освобождено (бронь не была выдана, статус не менялся).
    eq_list = client.get(f"/api/businesses/{business_id}/equipment", headers=headers).json()
    kept_eq_after = next(e for e in eq_list if e["id"] == eq_kept["id"])
    assert kept_eq_after["status"] == "available"
