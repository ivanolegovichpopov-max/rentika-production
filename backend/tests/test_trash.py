"""
Корзина (мягкое удаление) для клиентов и оборудования, плюс пункты обзора,
тесно связанные с ней по духу — "не терять данные без предупреждения" —
двадцать девятый проход (20-пунктовый обзор живого прода, "реализовываем
всё в полном объёме"): п.14 (корзина), п.19 (обязательные поля организации,
формат ИНН/телефона), п.8 (постоянная пометка "был в чёрном списке").
"""
from datetime import datetime, timedelta, timezone

from app.models.inventory import Client, Equipment
from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    return client.get("/api/businesses", headers=auth_headers(token)).json()[0]["id"]


def _setup(client, email):
    owner = register_business(client, email=email, password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])
    return headers, business_id


# ---------------------------------------------------------------- Клиенты --


def test_client_trash_restore_roundtrip(client):
    headers, business_id = _setup(client, "trash-client@example.com")

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "На выброс"}, headers=headers
    ).json()["id"]

    resp = client.delete(f"/api/businesses/{business_id}/clients/{client_id}", headers=headers)
    assert resp.status_code == 204

    active = client.get(f"/api/businesses/{business_id}/clients", headers=headers).json()
    assert not any(c["id"] == client_id for c in active)

    trash = client.get(f"/api/businesses/{business_id}/clients/trash", headers=headers).json()
    assert len(trash) == 1
    assert trash[0]["id"] == client_id
    assert trash[0]["deleted_at"] is not None
    assert trash[0]["deleted_by_name"]  # владелец бизнеса — сотрудник, имя есть

    # В корзине клиент недоступен обычным маршрутам (ведёт себя как 404).
    assert client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}", json={"name": "Правка"}, headers=headers
    ).status_code == 404
    assert client.get(f"/api/businesses/{business_id}/clients/{client_id}/notes", headers=headers).status_code == 404

    restore = client.post(f"/api/businesses/{business_id}/clients/{client_id}/restore", headers=headers)
    assert restore.status_code == 200

    active_again = client.get(f"/api/businesses/{business_id}/clients", headers=headers).json()
    assert any(c["id"] == client_id for c in active_again)
    trash_again = client.get(f"/api/businesses/{business_id}/clients/trash", headers=headers).json()
    assert trash_again == []


def test_client_with_open_rental_cannot_be_trashed(client):
    headers, business_id = _setup(client, "trash-open-client@example.com")

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Активная аренда"}, headers=headers
    ).json()["id"]
    eq_id = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Штука", "category": "Инструмент", "daily_rate": 100, "deposit": 0},
        headers=headers,
    ).json()["id"]
    client.post(
        f"/api/businesses/{business_id}/rentals",
        json={"client_id": client_id, "equipment_ids": [eq_id], "start_date": "2026-09-01", "end_date": "2026-09-05"},
        headers=headers,
    )

    resp = client.delete(f"/api/businesses/{business_id}/clients/{client_id}", headers=headers)
    assert resp.status_code == 400


def test_client_purge_after_30_days_only_without_history(client, db_session):
    headers, business_id = _setup(client, "trash-purge-client@example.com")

    with_history_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "С историей"}, headers=headers
    ).json()["id"]
    eq_id = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Штука 2", "category": "Инструмент", "daily_rate": 50, "deposit": 0},
        headers=headers,
    ).json()["id"]
    rental_id = client.post(
        f"/api/businesses/{business_id}/rentals",
        json={
            "client_id": with_history_id,
            "equipment_ids": [eq_id],
            "start_date": "2026-09-01",
            "end_date": "2026-09-02",
        },
        headers=headers,
    ).json()["id"]
    client.post(f"/api/businesses/{business_id}/rentals/{rental_id}/issue", headers=headers)
    client.post(
        f"/api/businesses/{business_id}/rentals/{rental_id}/return",
        json={"actual_return": "2026-09-02", "damage_fee": 0},
        headers=headers,
    )

    without_history_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Без истории"}, headers=headers
    ).json()["id"]

    client.delete(f"/api/businesses/{business_id}/clients/{with_history_id}", headers=headers)
    client.delete(f"/api/businesses/{business_id}/clients/{without_history_id}", headers=headers)

    # "Перематываем" deleted_at на 31 день назад напрямую в БД — тест не
    # может физически подождать 30 дней (см. app/services/trash.py:
    # TRASH_RETENTION_DAYS, зачистка ленивая, срабатывает при следующем
    # обращении к корзине).
    old_ts = datetime.now(timezone.utc) - timedelta(days=31)
    db_session.query(Client).filter(Client.id.in_([with_history_id, without_history_id])).update(
        {"deleted_at": old_ts}, synchronize_session=False
    )
    db_session.commit()

    trash = client.get(f"/api/businesses/{business_id}/clients/trash", headers=headers).json()
    trashed_ids = {c["id"] for c in trash}
    # С историей — остаётся в корзине бессрочно (ondelete=RESTRICT не даёт
    # физически удалить, см. app/services/trash.py:purge_expired).
    assert with_history_id in trashed_ids
    # Без истории — уже зачищен окончательно.
    assert without_history_id not in trashed_ids


# --------------------------------------------------------------- Оборудование --


def test_equipment_trash_restore_roundtrip(client):
    headers, business_id = _setup(client, "trash-equipment@example.com")

    eq_id = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 100, "deposit": 0},
        headers=headers,
    ).json()["id"]

    resp = client.delete(f"/api/businesses/{business_id}/equipment/{eq_id}", headers=headers)
    assert resp.status_code == 204

    active = client.get(f"/api/businesses/{business_id}/equipment", headers=headers).json()
    assert not any(e["id"] == eq_id for e in active)

    trash = client.get(f"/api/businesses/{business_id}/equipment/trash", headers=headers).json()
    assert len(trash) == 1 and trash[0]["id"] == eq_id

    restore = client.post(f"/api/businesses/{business_id}/equipment/{eq_id}/restore", headers=headers)
    assert restore.status_code == 200
    active_again = client.get(f"/api/businesses/{business_id}/equipment", headers=headers).json()
    assert any(e["id"] == eq_id for e in active_again)


def test_equipment_with_open_rental_cannot_be_trashed_but_closed_history_can(client):
    headers, business_id = _setup(client, "trash-equipment-open@example.com")

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Клиент"}, headers=headers
    ).json()["id"]
    eq_id = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Перфоратор", "category": "Инструмент", "daily_rate": 100, "deposit": 0},
        headers=headers,
    ).json()["id"]
    rental_id = client.post(
        f"/api/businesses/{business_id}/rentals",
        json={"client_id": client_id, "equipment_ids": [eq_id], "start_date": "2026-09-01", "end_date": "2026-09-05"},
        headers=headers,
    ).json()["id"]

    # Аренда активна (start_date сегодня-ish) — удалить оборудование нельзя.
    assert client.delete(f"/api/businesses/{business_id}/equipment/{eq_id}", headers=headers).status_code == 400

    client.post(
        f"/api/businesses/{business_id}/rentals/{rental_id}/return",
        json={"actual_return": "2026-09-05", "damage_fee": 0},
        headers=headers,
    )

    # История закрыта — теперь можно (раньше это тихо переводило в "Списано",
    # теперь честно уходит в корзину).
    resp = client.delete(f"/api/businesses/{business_id}/equipment/{eq_id}", headers=headers)
    assert resp.status_code == 204


def test_deleted_equipment_not_offered_for_new_rentals(client):
    headers, business_id = _setup(client, "trash-equipment-rental@example.com")

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Клиент 2"}, headers=headers
    ).json()["id"]
    eq_id = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Лобзик", "category": "Инструмент", "daily_rate": 100, "deposit": 0},
        headers=headers,
    ).json()["id"]
    client.delete(f"/api/businesses/{business_id}/equipment/{eq_id}", headers=headers)

    resp = client.post(
        f"/api/businesses/{business_id}/rentals",
        json={"client_id": client_id, "equipment_ids": [eq_id], "start_date": "2026-09-01", "end_date": "2026-09-02"},
        headers=headers,
    )
    assert resp.status_code == 400


# ------------------------------------------------------- Валидация/рейтинг --


def test_company_client_requires_contact_person_and_inn(client):
    headers, business_id = _setup(client, "company-required@example.com")

    resp = client.post(
        f"/api/businesses/{business_id}/clients",
        json={"name": "ООО Ромашка", "client_type": "company"},
        headers=headers,
    )
    assert resp.status_code == 400
    assert "контактное лицо" in resp.json()["detail"] and "ИНН" in resp.json()["detail"]

    created = client.post(
        f"/api/businesses/{business_id}/clients",
        json={"name": "ООО Ромашка", "client_type": "company", "contact_person": "Петров Пётр", "inn": "7701234567"},
        headers=headers,
    )
    assert created.status_code == 201
    client_id = created.json()["id"]

    # Регрессия на реальный баг из обзора (п.19): стереть контактное лицо и
    # сохранить организацию больше нельзя — понятная 400, а не тихая потеря.
    wipe = client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}", json={"contact_person": ""}, headers=headers
    )
    assert wipe.status_code == 400

    # Тем же способом переключение обратно на физлицо снимает требование.
    switch = client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}",
        json={"client_type": "individual", "contact_person": "", "inn": ""},
        headers=headers,
    )
    assert switch.status_code == 200


def test_inn_and_phone_format_validation(client):
    headers, business_id = _setup(client, "format-validation@example.com")

    bad_inn = client.post(
        f"/api/businesses/{business_id}/clients",
        json={"name": "Тест", "client_type": "company", "contact_person": "П.П.", "inn": "12345"},
        headers=headers,
    )
    assert bad_inn.status_code == 422

    bad_phone = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Тест 2", "phone": "+70"}, headers=headers
    )
    assert bad_phone.status_code == 422

    ok = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Тест 3", "phone": "+79001234567"}, headers=headers
    )
    assert ok.status_code == 201


def test_was_blacklisted_flag_persists_after_leaving_blacklist(client):
    headers, business_id = _setup(client, "was-blacklisted@example.com")

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Проблемный клиент"}, headers=headers
    ).json()["id"]

    to_bl = client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}",
        json={"rating": "blacklist", "blacklist_reason": "Не вернул технику"},
        headers=headers,
    )
    assert to_bl.status_code == 200
    assert to_bl.json()["was_blacklisted"] is True

    back_to_normal = client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}",
        json={"rating": "normal", "blacklist_reason": None},
        headers=headers,
    )
    assert back_to_normal.status_code == 200
    # Пометка не сбрасывается сама — постоянная память карточки (29-й
    # проход, п.8 обзора).
    assert back_to_normal.json()["was_blacklisted"] is True
