"""
67-й проход, "Сотрудники" (по итогам третьего раунда обзора страницы):
- телефон/заметки/фото сотрудника и их видимость;
- цвет/описание должности, независимое обновление через PATCH;
- копирование прав на уже существующую должность (не только при создании);
- генерация нового временного пароля владельцем (reset-password);
- массовые действия над несколькими сотрудниками (bulk-update);
- фильтр журнала по нескольким действиям через запятую;
- дневная динамика нагрузки одного сотрудника (workload/timeseries).
"""
from datetime import datetime, timedelta, timezone

from app.models.inventory import Rental
from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    return client.get("/api/businesses", headers=auth_headers(token)).json()[0]["id"]


def _login(client, email, password):
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _setup(client, email):
    owner = register_business(client, email=email, password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])
    return headers, business_id


# --------------------------------------------------------------- телефон/заметки/фото --


def test_employee_phone_notes_photo_visibility(client):
    headers, business_id = _setup(client, "emp67-contact@example.com")

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Продавец"}, headers=headers).json()
    invited = client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "contact67@example.com",
            "name": "Контактов",
            "position_id": pos["id"],
            "temporary_password": "another long enough password",
            "phone": "+7 900 111-22-33",
        },
        headers=headers,
    ).json()
    assert invited["phone"] == "+7 900 111-22-33"
    assert invited["notes"] is None
    assert invited["photo_url"] is None

    upd = client.patch(
        f"/api/businesses/{business_id}/employees/{invited['id']}",
        json={"notes": "Отличная работа с VIP-клиентами", "photo_url": "data:image/png;base64,AAAA"},
        headers=headers,
    ).json()
    assert upd["notes"] == "Отличная работа с VIP-клиентами"
    assert upd["photo_url"] == "data:image/png;base64,AAAA"
    assert upd["phone"] == "+7 900 111-22-33"  # не тронуто

    # Явная очистка телефона — model_fields_set отличает "не передано" от "".
    cleared = client.patch(
        f"/api/businesses/{business_id}/employees/{invited['id']}", json={"phone": None}, headers=headers
    ).json()
    assert cleared["phone"] is None

    _login(client, "contact67@example.com", "another long enough password")
    other_token = _login(client, "emp67-contact@example.com", "correct horse battery staple")

    as_owner = next(
        e for e in client.get(f"/api/businesses/{business_id}/employees", headers=auth_headers(other_token)).json()
        if e["id"] == invited["id"]
    )
    assert as_owner["notes"] == "Отличная работа с VIP-клиентами"
    assert as_owner["photo_url"] == "data:image/png;base64,AAAA"

    # Журнал не должен содержать сам текст заметки/фото — только факт изменения.
    activity = client.get(f"/api/businesses/{business_id}/employees/activity", headers=headers).json()["items"]
    upd_entry = next(e for e in activity if e["resource"] == "employee" and e["action"] == "update" and e["meta"] and e["meta"].get("notes_changed"))
    assert upd_entry["meta"] == {"notes_changed": True, "photo_changed": True}


def test_employee_phone_notes_hidden_from_teammates(client):
    headers, business_id = _setup(client, "emp67-hide@example.com")

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Стажёр"}, headers=headers).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{pos['id']}/permissions",
        json={"permissions": [{"resource": "employees", "level": "view"}]},
        headers=headers,
    )
    target = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "target67@example.com", "name": "Целевой", "position_id": pos["id"], "temporary_password": "another long enough password", "phone": "123"},
        headers=headers,
    ).json()
    client.patch(f"/api/businesses/{business_id}/employees/{target['id']}", json={"notes": "секретная заметка"}, headers=headers)

    viewer = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "viewer67@example.com", "name": "Смотрящий", "position_id": pos["id"], "temporary_password": "another long enough password"},
        headers=headers,
    ).json()
    viewer_token = _login(client, "viewer67@example.com", "another long enough password")

    seen = next(
        e for e in client.get(f"/api/businesses/{business_id}/employees", headers=auth_headers(viewer_token)).json()
        if e["id"] == target["id"]
    )
    assert seen["email"] is None
    assert seen["phone"] is None
    assert seen["notes"] is None
    assert seen["photo_url"] is None  # у target фото не задано, но поле в принципе видно всем


# --------------------------------------------------------------- цвет/описание должности --


def test_position_color_and_description(client):
    headers, business_id = _setup(client, "pos67-appearance@example.com")

    pos = client.post(
        f"/api/businesses/{business_id}/positions",
        json={"title": "Механик", "color": "blue", "description": "Обслуживание оборудования"},
        headers=headers,
    ).json()
    assert pos["color"] == "blue"
    assert pos["description"] == "Обслуживание оборудования"

    bad_color = client.post(
        f"/api/businesses/{business_id}/positions", json={"title": "Другая", "color": "not-a-color"}, headers=headers
    )
    assert bad_color.status_code == 422

    # Независимое изменение только цвета, без затрагивания title/description.
    only_color = client.patch(
        f"/api/businesses/{business_id}/positions/{pos['id']}", json={"color": "green"}, headers=headers
    ).json()
    assert only_color["color"] == "green"
    assert only_color["title"] == "Механик"
    assert only_color["description"] == "Обслуживание оборудования"

    activity = client.get(f"/api/businesses/{business_id}/employees/activity", headers=headers).json()["items"]
    upd = next(e for e in activity if e["resource"] == "position" and e["action"] == "update")
    assert upd["meta"] == {"color_before": "blue", "color_after": "green"}


def test_position_copy_permissions_onto_existing(client):
    headers, business_id = _setup(client, "pos67-copyexisting@example.com")

    source = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Источник"}, headers=headers).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{source['id']}/permissions",
        json={"permissions": [{"resource": "finance", "level": "edit"}]},
        headers=headers,
    )
    target = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Цель"}, headers=headers).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{target['id']}/permissions",
        json={"permissions": [{"resource": "clients", "level": "view"}]},
        headers=headers,
    )

    resp = client.post(
        f"/api/businesses/{business_id}/positions/{target['id']}/copy-permissions",
        json={"source_position_id": source["id"]},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    perms = {p["resource"]: p["level"] for p in resp.json()["permissions"]}
    assert perms["finance"] == "edit"
    assert perms["clients"] == "none"  # перезаписано источником (там clients=none)

    self_copy = client.post(
        f"/api/businesses/{business_id}/positions/{target['id']}/copy-permissions",
        json={"source_position_id": target["id"]},
        headers=headers,
    )
    assert self_copy.status_code == 400

    missing = client.post(
        f"/api/businesses/{business_id}/positions/{target['id']}/copy-permissions",
        json={"source_position_id": "00000000-0000-0000-0000-000000000000"},
        headers=headers,
    )
    assert missing.status_code == 404


# --------------------------------------------------------------- reset-password --


def test_reset_password_generates_working_password(client):
    headers, business_id = _setup(client, "emp67-reset@example.com")

    emp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "reset67@example.com", "name": "Забывчивый", "temporary_password": "another long enough password"},
        headers=headers,
    ).json()

    resp = client.post(f"/api/businesses/{business_id}/employees/{emp['id']}/reset-password", headers=headers)
    assert resp.status_code == 200, resp.text
    new_password = resp.json()["temporary_password"]
    assert len(new_password) >= 12

    # Старый пароль больше не работает, новый — работает.
    old_login = client.post("/api/auth/login", json={"email": "reset67@example.com", "password": "another long enough password"})
    assert old_login.status_code in (401, 400)
    new_login = client.post("/api/auth/login", json={"email": "reset67@example.com", "password": new_password})
    assert new_login.status_code == 200, new_login.text

    activity = client.get(f"/api/businesses/{business_id}/employees/activity", headers=headers).json()["items"]
    assert any(e["resource"] == "employee" and e["action"] == "reset_password" for e in activity)


# --------------------------------------------------------------- bulk-update --


def test_bulk_update_assigns_position_and_skips_owner(client):
    headers, business_id = _setup(client, "emp67-bulk@example.com")

    pos_a = client.post(f"/api/businesses/{business_id}/positions", json={"title": "А"}, headers=headers).json()
    pos_b = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Б"}, headers=headers).json()
    e1 = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "bulk1@example.com", "name": "Один", "position_id": pos_a["id"], "temporary_password": "another long enough password"},
        headers=headers,
    ).json()
    e2 = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "bulk2@example.com", "name": "Два", "position_id": pos_a["id"], "temporary_password": "another long enough password"},
        headers=headers,
    ).json()
    owner_id = next(e["id"] for e in client.get(f"/api/businesses/{business_id}/employees", headers=headers).json() if e["is_owner"])

    resp = client.post(
        f"/api/businesses/{business_id}/employees/bulk-update",
        json={"employee_ids": [e1["id"], e2["id"], owner_id], "position_id": pos_b["id"]},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["updated"]) == 2
    assert body["skipped"] == 1  # владелец пропущен
    assert all(e["position_id"] == pos_b["id"] for e in body["updated"])

    bulk_disable = client.post(
        f"/api/businesses/{business_id}/employees/bulk-update",
        json={"employee_ids": [e1["id"], e2["id"]], "status": "disabled"},
        headers=headers,
    ).json()
    assert all(e["status"] == "disabled" for e in bulk_disable["updated"])

    activity = client.get(f"/api/businesses/{business_id}/employees/activity", headers=headers).json()["items"]
    bulk_entries = [e for e in activity if e["action"] == "bulk_update"]
    assert len(bulk_entries) == 2


def test_bulk_update_clear_position(client):
    headers, business_id = _setup(client, "emp67-bulkclear@example.com")
    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Временная"}, headers=headers).json()
    emp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "bulkclear@example.com", "name": "Без должности скоро", "position_id": pos["id"], "temporary_password": "another long enough password"},
        headers=headers,
    ).json()

    resp = client.post(
        f"/api/businesses/{business_id}/employees/bulk-update",
        json={"employee_ids": [emp["id"]], "clear_position": True},
        headers=headers,
    ).json()
    assert resp["updated"][0]["position_id"] is None


# --------------------------------------------------------------- журнал: несколько action через запятую --


def test_activity_filter_by_multiple_actions(client):
    headers, business_id = _setup(client, "emp67-multiaction@example.com")

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Тест"}, headers=headers).json()
    emp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "multi67@example.com", "name": "Мульти", "position_id": pos["id"], "temporary_password": "another long enough password"},
        headers=headers,
    ).json()
    client.delete(f"/api/businesses/{business_id}/positions/{pos['id']}", headers=headers)  # ещё одна должность нужна ниже
    pos2 = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Тест2"}, headers=headers).json()
    client.patch(f"/api/businesses/{business_id}/positions/{pos2['id']}/require-2fa", json={"require_2fa": True}, headers=headers)
    client.delete(f"/api/businesses/{business_id}/employees/{emp['id']}", headers=headers)

    combo = client.get(
        f"/api/businesses/{business_id}/employees/activity",
        params={"action": "delete,update_require_2fa,disable"},
        headers=headers,
    ).json()["items"]
    actions = {e["action"] for e in combo}
    assert actions == {"delete", "update_require_2fa", "disable"}

    single = client.get(
        f"/api/businesses/{business_id}/employees/activity", params={"action": "disable"}, headers=headers
    ).json()["items"]
    assert all(e["action"] == "disable" for e in single)
    assert len(single) == 1


# --------------------------------------------------------------- дневная динамика (timeseries) --


def test_workload_timeseries_buckets_by_day(client, db_session):
    headers, business_id = _setup(client, "emp67-series@example.com")

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Прокатчик"}, headers=headers).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{pos['id']}/permissions",
        json={"permissions": [{"resource": "rentals", "level": "edit"}, {"resource": "clients", "level": "edit"}, {"resource": "equipment", "level": "edit"}]},
        headers=headers,
    )
    emp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "series67@example.com", "name": "Прокатчик Ряд", "position_id": pos["id"], "temporary_password": "another long enough password"},
        headers=headers,
    ).json()
    emp_token = _login(client, "series67@example.com", "another long enough password")
    emp_headers = auth_headers(emp_token)

    client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Разное"}, headers=headers)
    client_id = client.post(f"/api/businesses/{business_id}/clients", json={"name": "Клиент"}, headers=emp_headers).json()["id"]
    eq_id = client.post(
        f"/api/businesses/{business_id}/equipment", json={"name": "Штука", "category": "Разное", "daily_rate": 100}, headers=emp_headers
    ).json()["id"]
    today = datetime.now().date()
    rental_id = client.post(
        f"/api/businesses/{business_id}/rentals",
        json={"client_id": client_id, "equipment_ids": [eq_id], "start_date": (today + timedelta(days=1)).isoformat(), "end_date": (today + timedelta(days=3)).isoformat()},
        headers=emp_headers,
    ).json()["id"]

    three_days_ago = datetime.now(timezone.utc) - timedelta(days=3)
    db_session.query(Rental).filter(Rental.id == rental_id).update({"created_at": three_days_ago}, synchronize_session=False)
    db_session.commit()

    resp = client.get(f"/api/businesses/{business_id}/employees/{emp['id']}/workload/timeseries", params={"days": 7}, headers=headers)
    assert resp.status_code == 200, resp.text
    points = resp.json()["points"]
    assert len(points) == 7
    assert points[-1]["date"] == today.isoformat()
    total_rentals = sum(p["rentals_created"] for p in points)
    assert total_rentals == 1
    day_key = three_days_ago.date().isoformat()
    matching = next(p for p in points if p["date"] == day_key)
    assert matching["rentals_created"] == 1

    not_owner = client.get(
        f"/api/businesses/{business_id}/employees/{emp['id']}/workload/timeseries", headers=emp_headers
    )
    assert not_owner.status_code == 403
