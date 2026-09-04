"""
66-й проход, "Должности и права" / "Активность" / "Команда" (по итогам
обзора страницы "Сотрудники", подпункт "делаем всё"):
- ручной порядок карточек должностей (sort_order) + счётчик сотрудников;
- копирование прав при создании должности (copy_permissions_from);
- обязательная 2FA для отдельных должностей (require_2fa) и её проверка в
  get_business_context;
- реальный сценарий invited -> active при первом входе;
- before/after meta для update_permissions;
- фильтр журнала по resource/action;
- тренд нагрузки (сравнение с предыдущим периодом);
- упрощённый CSV-импорт сотрудников.
"""
import io
from datetime import datetime, timedelta, timezone

import pyotp

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


# --------------------------------------------------------------- sort_order / employee_count --


def test_new_position_defaults_and_employee_count(client):
    headers, business_id = _setup(client, "pos66-count@example.com")

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Менеджер"}, headers=headers).json()
    assert pos["sort_order"] == 0
    assert pos["require_2fa"] is False
    assert pos["employee_count"] == 0

    client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "counted@example.com", "name": "Сотрудник", "position_id": pos["id"], "temporary_password": "another long enough password"},
        headers=headers,
    )
    listed = client.get(f"/api/businesses/{business_id}/positions", headers=headers).json()
    updated = next(p for p in listed if p["id"] == pos["id"])
    assert updated["employee_count"] == 1


def test_position_reorder(client):
    headers, business_id = _setup(client, "pos66-reorder@example.com")

    a = client.post(f"/api/businesses/{business_id}/positions", json={"title": "А"}, headers=headers).json()
    b = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Б"}, headers=headers).json()
    c = client.post(f"/api/businesses/{business_id}/positions", json={"title": "В"}, headers=headers).json()

    # Изначально по sort_order (порядок создания): А, Б, В.
    listed = client.get(f"/api/businesses/{business_id}/positions", headers=headers).json()
    assert [p["id"] for p in listed] == [a["id"], b["id"], c["id"]]

    reorder_resp = client.post(
        f"/api/businesses/{business_id}/positions/reorder", json={"order": [c["id"], a["id"], b["id"]]}, headers=headers
    )
    assert reorder_resp.status_code == 200, reorder_resp.text
    assert [p["id"] for p in reorder_resp.json()] == [c["id"], a["id"], b["id"]]

    listed_after = client.get(f"/api/businesses/{business_id}/positions", headers=headers).json()
    assert [p["id"] for p in listed_after] == [c["id"], a["id"], b["id"]]

    # Частичный список — 400, ни одна карточка не должна остаться "без пары".
    partial = client.post(
        f"/api/businesses/{business_id}/positions/reorder", json={"order": [a["id"], b["id"]]}, headers=headers
    )
    assert partial.status_code == 400


def test_position_copy_permissions_from(client):
    headers, business_id = _setup(client, "pos66-copy@example.com")

    source = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Источник"}, headers=headers).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{source['id']}/permissions",
        json={"permissions": [{"resource": "equipment", "level": "edit"}, {"resource": "clients", "level": "view"}]},
        headers=headers,
    )

    copy = client.post(
        f"/api/businesses/{business_id}/positions",
        json={"title": "Копия", "copy_permissions_from": source["id"]},
        headers=headers,
    )
    assert copy.status_code == 201, copy.text
    perms = {p["resource"]: p["level"] for p in copy.json()["permissions"]}
    assert perms["equipment"] == "edit"
    assert perms["clients"] == "view"
    assert perms["rentals"] == "none"

    missing_source = client.post(
        f"/api/businesses/{business_id}/positions",
        json={"title": "Без источника", "copy_permissions_from": "00000000-0000-0000-0000-000000000000"},
        headers=headers,
    )
    assert missing_source.status_code == 404


def test_update_permissions_logs_before_after_meta(client):
    headers, business_id = _setup(client, "pos66-permsmeta@example.com")

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Кассир"}, headers=headers).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{pos['id']}/permissions",
        json={"permissions": [{"resource": "clients", "level": "view"}]},
        headers=headers,
    )
    client.put(
        f"/api/businesses/{business_id}/positions/{pos['id']}/permissions",
        json={"permissions": [{"resource": "clients", "level": "edit"}, {"resource": "equipment", "level": "view"}]},
        headers=headers,
    )

    activity = client.get(f"/api/businesses/{business_id}/employees/activity", headers=headers).json()["items"]
    entries = [e for e in activity if e["resource"] == "position" and e["action"] == "update_permissions"]
    assert len(entries) == 2

    # Первое изменение: clients none->view — есть в meta.
    first = entries[-1]
    assert {"resource": "clients", "level_before": "none", "level_after": "view"} in first["meta"]["changes"]

    # Второе: clients view->edit и equipment none->view, но НЕ то, что не менялось.
    second = entries[0]
    changes = second["meta"]["changes"]
    assert {"resource": "clients", "level_before": "view", "level_after": "edit"} in changes
    assert {"resource": "equipment", "level_before": "none", "level_after": "view"} in changes
    assert len(changes) == 2


# --------------------------------------------------------------- обязательная 2FA --


def test_require_2fa_toggle_blocks_and_unblocks_employee(client):
    headers, business_id = _setup(client, "pos66-2fa@example.com")

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Бухгалтер"}, headers=headers).json()
    assert pos["require_2fa"] is False
    client.put(
        f"/api/businesses/{business_id}/positions/{pos['id']}/permissions",
        json={"permissions": [{"resource": "equipment", "level": "view"}]},
        headers=headers,
    )
    client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "accountant66@example.com", "name": "Бухгалтер", "position_id": pos["id"], "temporary_password": "another long enough password"},
        headers=headers,
    )
    employee_token = _login(client, "accountant66@example.com", "another long enough password")

    # До включения require_2fa — обычный доступ (в рамках его прав, здесь
    # достаточно проверить, что запрос вообще не 403 по причине 2FA).
    ok = client.get(f"/api/businesses/{business_id}/equipment", headers=auth_headers(employee_token))
    assert ok.status_code == 200

    toggle = client.patch(
        f"/api/businesses/{business_id}/positions/{pos['id']}/require-2fa", json={"require_2fa": True}, headers=headers
    )
    assert toggle.status_code == 200, toggle.text
    assert toggle.json()["require_2fa"] is True

    blocked = client.get(f"/api/businesses/{business_id}/equipment", headers=auth_headers(employee_token))
    assert blocked.status_code == 403
    assert "двухфакторная аутентификация" in blocked.json()["detail"]

    # Владельца (без position_id) обязательная 2FA должности не касается.
    owner_ok = client.get(f"/api/businesses/{business_id}/equipment", headers=headers)
    assert owner_ok.status_code == 200

    # Сотрудник включает 2FA — доступ должен вернуться.
    setup = client.post("/api/auth/2fa/setup", headers=auth_headers(employee_token)).json()
    code = pyotp.TOTP(setup["secret"]).now()
    confirm = client.post("/api/auth/2fa/confirm", json={"code": code}, headers=auth_headers(employee_token))
    assert confirm.status_code == 200

    unblocked = client.get(f"/api/businesses/{business_id}/equipment", headers=auth_headers(employee_token))
    assert unblocked.status_code == 200

    # Выключение требования тоже логируется (before/after) и снова открывает доступ без 2FA.
    toggle_off = client.patch(
        f"/api/businesses/{business_id}/positions/{pos['id']}/require-2fa", json={"require_2fa": False}, headers=headers
    )
    assert toggle_off.status_code == 200
    activity = client.get(f"/api/businesses/{business_id}/employees/activity", headers=headers).json()["items"]
    toggles = [e for e in activity if e["action"] == "update_require_2fa"]
    assert len(toggles) == 2
    assert toggles[0]["meta"] == {"require_2fa_before": True, "require_2fa_after": False}
    assert toggles[1]["meta"] == {"require_2fa_before": False, "require_2fa_after": True}


# --------------------------------------------------------------- invited -> active --


def test_invited_employee_becomes_active_only_after_first_login(client):
    headers, business_id = _setup(client, "pos66-invited@example.com")

    invited = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "newbie66@example.com", "name": "Новичок", "temporary_password": "another long enough password"},
        headers=headers,
    ).json()
    assert invited["status"] == "invited"

    still_invited = next(
        e for e in client.get(f"/api/businesses/{business_id}/employees", headers=headers).json() if e["id"] == invited["id"]
    )
    assert still_invited["status"] == "invited"

    _login(client, "newbie66@example.com", "another long enough password")

    activated = next(
        e for e in client.get(f"/api/businesses/{business_id}/employees", headers=headers).json() if e["id"] == invited["id"]
    )
    assert activated["status"] == "active"

    activity = client.get(f"/api/businesses/{business_id}/employees/activity", headers=headers).json()["items"]
    assert any(e["resource"] == "employee" and e["action"] == "activate" for e in activity)


# --------------------------------------------------------------- журнал: фильтр resource/action --


def test_activity_filters_by_resource_and_action(client):
    headers, business_id = _setup(client, "pos66-filter@example.com")

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Раз"}, headers=headers).json()
    client.patch(f"/api/businesses/{business_id}/positions/{pos['id']}", json={"title": "Один"}, headers=headers)
    client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "filterme@example.com", "name": "Кто-то", "temporary_password": "another long enough password"},
        headers=headers,
    )

    only_positions = client.get(
        f"/api/businesses/{business_id}/employees/activity", params={"resource": "position"}, headers=headers
    ).json()["items"]
    assert only_positions
    assert all(e["resource"] == "position" for e in only_positions)

    only_renames = client.get(
        f"/api/businesses/{business_id}/employees/activity", params={"action": "rename"}, headers=headers
    ).json()["items"]
    assert only_renames
    assert all(e["action"] == "rename" for e in only_renames)

    combo = client.get(
        f"/api/businesses/{business_id}/employees/activity",
        params={"resource": "employee", "action": "invite"},
        headers=headers,
    ).json()["items"]
    assert combo
    assert all(e["resource"] == "employee" and e["action"] == "invite" for e in combo)

    nothing = client.get(
        f"/api/businesses/{business_id}/employees/activity",
        params={"resource": "position", "action": "invite"},
        headers=headers,
    ).json()["items"]
    assert nothing == []


# --------------------------------------------------------------- тренд нагрузки --


def test_workload_trend_compares_with_previous_period(client, db_session):
    headers, business_id = _setup(client, "pos66-trend@example.com")

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Прокатчик"}, headers=headers).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{pos['id']}/permissions",
        json={"permissions": [{"resource": "rentals", "level": "edit"}, {"resource": "clients", "level": "edit"}, {"resource": "equipment", "level": "edit"}]},
        headers=headers,
    )
    emp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "trend66@example.com", "name": "Прокатчик Иванов", "position_id": pos["id"], "temporary_password": "another long enough password"},
        headers=headers,
    ).json()
    emp_token = _login(client, "trend66@example.com", "another long enough password")
    emp_headers = auth_headers(emp_token)

    client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Разное"}, headers=headers)
    client_id = client.post(f"/api/businesses/{business_id}/clients", json={"name": "Клиент"}, headers=emp_headers).json()["id"]
    eq_id = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Штука", "category": "Разное", "daily_rate": 100},
        headers=emp_headers,
    ).json()["id"]
    today = datetime.now().date()
    rental_id = client.post(
        f"/api/businesses/{business_id}/rentals",
        json={
            "client_id": client_id,
            "equipment_ids": [eq_id],
            "start_date": (today + timedelta(days=1)).isoformat(),
            "end_date": (today + timedelta(days=3)).isoformat(),
        },
        headers=emp_headers,
    ).json()["id"]

    # Сдвигаем created_at этой аренды на 7 дней назад — тот же приём, что и
    # test_trash.py::test_client_purge_after_30_days_only_without_history:
    # напрямую через db_session, так как через HTTP API "подделать" дату
    # создания нельзя (и не должно быть можно).
    old_ts = datetime.now(timezone.utc) - timedelta(days=7)
    db_session.query(Rental).filter(Rental.id == rental_id).update({"created_at": old_ts}, synchronize_session=False)
    db_session.commit()

    # Текущий период — последние 5 дней: аренда 7-дневной давности сюда не
    # попадает, но должна попасть в "предыдущий период" (5-10 дней назад).
    workload = client.get(
        f"/api/businesses/{business_id}/employees/workload", params={"days": 5}, headers=headers
    ).json()
    row = next(w for w in workload if w["employee_id"] == emp["id"])
    assert row["rentals_created"] == 0
    assert row["rentals_created_prev"] == 1

    # Без days сравнение недоступно вовсе — *_prev остаются None, а не 0.
    workload_all = client.get(f"/api/businesses/{business_id}/employees/workload", headers=headers).json()
    row_all = next(w for w in workload_all if w["employee_id"] == emp["id"])
    assert row_all["rentals_created"] == 1
    assert row_all["rentals_created_prev"] is None


# --------------------------------------------------------------- CSV-импорт сотрудников --


def test_employee_csv_import_creates_and_reports_errors(client):
    headers, business_id = _setup(client, "pos66-import@example.com")

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Курьер"}, headers=headers).json()

    csv_text = (
        "email,name,position,temporary_password\n"
        "courier1@example.com,Курьер Один,Курьер,another long enough password\n"
        "courier2@example.com,Курьер Два,,another long enough password\n"
        "bademail,Без почты,,another long enough password\n"
        "courier3@example.com,Плохая должность,Несуществующая,another long enough password\n"
    )
    resp = client.post(
        f"/api/businesses/{business_id}/employees/import",
        files={"file": ("employees.csv", io.BytesIO(csv_text.encode("utf-8")), "text/csv")},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 4
    assert body["created"] == 2
    assert body["failed"] == 2

    by_row = {r["row"]: r for r in body["results"]}
    assert by_row[2]["ok"] is True
    assert by_row[2]["employee"]["position_id"] == pos["id"]
    assert by_row[3]["ok"] is True
    assert by_row[3]["employee"]["position_id"] is None
    assert by_row[4]["ok"] is False  # пустой email
    assert by_row[5]["ok"] is False  # несуществующая должность
    assert "Несуществующая" in by_row[5]["error"]

    listed = client.get(f"/api/businesses/{business_id}/employees", headers=headers).json()
    emails = {e["email"] for e in listed}
    assert "courier1@example.com" in emails
    assert "courier2@example.com" in emails
    statuses = {e["email"]: e["status"] for e in listed}
    assert statuses["courier1@example.com"] == "invited"


def test_employee_csv_import_requires_owner(client):
    headers, business_id = _setup(client, "pos66-import-acl@example.com")
    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Наблюдатель"}, headers=headers).json()
    client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "watcher66@example.com", "name": "Наблюдатель", "position_id": pos["id"], "temporary_password": "another long enough password"},
        headers=headers,
    )
    watcher_token = _login(client, "watcher66@example.com", "another long enough password")

    csv_text = "email,name,temporary_password\nx@example.com,X,another long enough password\n"
    resp = client.post(
        f"/api/businesses/{business_id}/employees/import",
        files={"file": ("employees.csv", io.BytesIO(csv_text.encode("utf-8")), "text/csv")},
        headers=auth_headers(watcher_token),
    )
    assert resp.status_code == 403
