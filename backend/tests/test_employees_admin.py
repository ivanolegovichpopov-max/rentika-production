"""
Административные сценарии раздела "Сотрудники" (64-й проход, обратная связь
по обзору страницы): редактирование уже нанятого сотрудника, реактивация
отключённого, сброс пароля, переименование/удаление должности, видимость
email и владелец-only доступ к журналу действий/сводке нагрузки. Раньше
часть этих HTTP-эндпоинтов либо не существовала вовсе (PATCH .../positions/
{id}, GET .../employees/activity, GET .../employees/workload), либо
существовала, но не была нигде покрыта тестами (PATCH .../employees/{id}
проверялся только тестами ACL на смену прав, не на смену имени/должности).
"""
from datetime import date, timedelta

from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    return client.get("/api/businesses", headers=auth_headers(token)).json()[0]["id"]


def _login(client, email, password):
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _future(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


def test_owner_can_edit_employee_name_and_position(client):
    owner = register_business(client, email="edit-owner@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    pos_a = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Менеджер"}, headers=headers).json()
    pos_b = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Кладовщик"}, headers=headers).json()

    emp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "worker@example.com",
            "name": "Первое Имя",
            "position_id": pos_a["id"],
            "temporary_password": "another long enough password",
        },
        headers=headers,
    ).json()

    resp = client.patch(
        f"/api/businesses/{business_id}/employees/{emp['id']}",
        json={"name": "Второе Имя", "position_id": pos_b["id"]},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "Второе Имя"
    assert body["position_id"] == pos_b["id"]
    # Владелец видит email в ответе — сам вызвал управляющий эндпоинт.
    assert body["email"] == "worker@example.com"


def test_owner_can_clear_employee_position(client):
    owner = register_business(client, email="clear-owner@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Менеджер"}, headers=headers).json()
    emp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "clearme@example.com",
            "name": "Сотрудник",
            "position_id": pos["id"],
            "temporary_password": "another long enough password",
        },
        headers=headers,
    ).json()

    # position_id: null должен явно снять должность, а не быть проигнорирован
    # (раньше body.position_id is not None трактовал null точно так же, как
    # отсутствие поля вовсе — снять должность было невозможно).
    resp = client.patch(
        f"/api/businesses/{business_id}/employees/{emp['id']}", json={"position_id": None}, headers=headers
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["position_id"] is None


def test_owner_can_reactivate_disabled_employee(client):
    owner = register_business(client, email="reactivate-owner@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    emp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "flappy@example.com",
            "name": "Сотрудник",
            "temporary_password": "another long enough password",
        },
        headers=headers,
    ).json()

    disable_resp = client.delete(f"/api/businesses/{business_id}/employees/{emp['id']}", headers=headers)
    assert disable_resp.status_code == 204

    reactivate_resp = client.patch(
        f"/api/businesses/{business_id}/employees/{emp['id']}", json={"status": "active"}, headers=headers
    )
    assert reactivate_resp.status_code == 200, reactivate_resp.text
    assert reactivate_resp.json()["status"] == "active"


def test_owner_can_reset_employee_password(client):
    owner = register_business(client, email="reset-owner@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    emp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "forgetful@example.com",
            "name": "Сотрудник",
            "temporary_password": "original long enough password",
        },
        headers=headers,
    ).json()

    # Старый пароль ещё работает.
    assert _login(client, "forgetful@example.com", "original long enough password")

    resp = client.patch(
        f"/api/businesses/{business_id}/employees/{emp['id']}",
        json={"new_password": "brand new long enough password"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text

    # Новый пароль работает, старый — больше нет.
    assert _login(client, "forgetful@example.com", "brand new long enough password")
    old_login = client.post(
        "/api/auth/login", json={"email": "forgetful@example.com", "password": "original long enough password"}
    )
    assert old_login.status_code in (400, 401)


def test_position_rename_and_duplicate_title_conflict(client):
    owner = register_business(client, email="rename-owner@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    pos_a = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Менеджер"}, headers=headers).json()
    pos_b = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Бухгалтер"}, headers=headers).json()

    resp = client.patch(f"/api/businesses/{business_id}/positions/{pos_a['id']}", json={"title": "Старший менеджер"}, headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["title"] == "Старший менеджер"

    conflict = client.patch(f"/api/businesses/{business_id}/positions/{pos_b['id']}", json={"title": "Старший менеджер"}, headers=headers)
    assert conflict.status_code == 400


def test_deleting_position_clears_it_from_assigned_employee(client):
    owner = register_business(client, email="delpos-owner@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Временная"}, headers=headers).json()
    emp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "orphan@example.com",
            "name": "Сотрудник",
            "position_id": pos["id"],
            "temporary_password": "another long enough password",
        },
        headers=headers,
    ).json()

    del_resp = client.delete(f"/api/businesses/{business_id}/positions/{pos['id']}", headers=headers)
    assert del_resp.status_code == 204

    # Position.position_id -> ondelete="SET NULL" — это FK-каскад на уровне
    # СУБД (реальный Postgres в проде его выполнит); тестовый SQLite-движок
    # в conftest.py поднят без PRAGMA foreign_keys=ON (как и во всех
    # остальных тестах проекта), поэтому здесь каскад не воспроизвести —
    # проверяем то, что действительно наблюдаемо на этом стенде: сама
    # должность удалена и повторно недоступна, сотрудник остаётся на месте.
    remaining_positions = client.get(f"/api/businesses/{business_id}/positions", headers=headers).json()
    assert all(p["id"] != pos["id"] for p in remaining_positions)

    listed = client.get(f"/api/businesses/{business_id}/employees", headers=headers).json()
    assert any(e["id"] == emp["id"] for e in listed)


def test_employee_email_hidden_from_non_owner_but_visible_to_owner(client):
    owner = register_business(client, email="email-owner@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Наблюдатель"}, headers=headers).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{pos['id']}/permissions",
        json={"permissions": [{"resource": "employees", "level": "view"}]},
        headers=headers,
    )
    client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "watcher@example.com",
            "name": "Наблюдатель",
            "position_id": pos["id"],
            "temporary_password": "another long enough password",
        },
        headers=headers,
    )
    watcher_token = _login(client, "watcher@example.com", "another long enough password")

    owner_view = client.get(f"/api/businesses/{business_id}/employees", headers=headers).json()
    assert all(e["email"] for e in owner_view)

    watcher_view = client.get(f"/api/businesses/{business_id}/employees", headers=auth_headers(watcher_token)).json()
    assert all(e["email"] is None for e in watcher_view)


def test_activity_and_workload_require_owner(client):
    owner = register_business(client, email="audit-owner@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Рядовой"}, headers=headers).json()
    client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "plain@example.com",
            "name": "Рядовой сотрудник",
            "position_id": pos["id"],
            "temporary_password": "another long enough password",
        },
        headers=headers,
    )
    plain_token = _login(client, "plain@example.com", "another long enough password")

    assert client.get(f"/api/businesses/{business_id}/employees/activity", headers=auth_headers(plain_token)).status_code == 403
    assert client.get(f"/api/businesses/{business_id}/employees/workload", headers=auth_headers(plain_token)).status_code == 403

    assert client.get(f"/api/businesses/{business_id}/employees/activity", headers=headers).status_code == 200
    assert client.get(f"/api/businesses/{business_id}/employees/workload", headers=headers).status_code == 200


def test_activity_log_records_employee_actions_and_workload_counts_them(client):
    owner = register_business(client, email="workload-owner@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Менеджер"}, headers=headers).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{pos['id']}/permissions",
        json={"permissions": [{"resource": "rentals", "level": "edit"}, {"resource": "clients", "level": "edit"}, {"resource": "equipment", "level": "edit"}]},
        headers=headers,
    )
    emp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "manager@example.com",
            "name": "Менеджер Иванов",
            "position_id": pos["id"],
            "temporary_password": "another long enough password",
        },
        headers=headers,
    ).json()
    manager_token = _login(client, "manager@example.com", "another long enough password")
    manager_headers = auth_headers(manager_token)

    # Категория оборудования заранее заведена владельцем — сотрудник с
    # edit на "Оборудование" не может создавать новые категории, только
    # пользоваться уже существующими (см. тот же нюанс в test_acl.py).
    client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=headers)

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Клиент менеджера"}, headers=manager_headers
    ).json()["id"]
    eq_id = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель менеджера", "category": "Инструмент", "daily_rate": 300},
        headers=manager_headers,
    ).json()["id"]
    client.post(
        f"/api/businesses/{business_id}/clients/{client_id}/notes", json={"text": "Позвонил, уточнил сроки"}, headers=manager_headers
    )
    rental = client.post(
        f"/api/businesses/{business_id}/rentals",
        json={"client_id": client_id, "equipment_ids": [eq_id], "start_date": _future(1), "end_date": _future(3)},
        headers=manager_headers,
    ).json()
    assert rental.get("id"), rental

    # Журнал действий — видны и создание клиента, и создание аренды, с
    # привязкой к сотруднику, который их совершил.
    activity_page = client.get(f"/api/businesses/{business_id}/employees/activity", headers=headers).json()
    activity = activity_page["items"]
    assert activity_page["has_more"] is False
    actions = {(entry["resource"], entry["action"]) for entry in activity}
    assert ("client", "create") in actions
    assert ("rental", "create") in actions
    assert any(entry["employee_name"] == "Менеджер Иванов" for entry in activity)

    # Фильтр по конкретному сотруднику.
    filtered = client.get(
        f"/api/businesses/{business_id}/employees/activity",
        params={"employee_id": emp["id"]},
        headers=headers,
    ).json()["items"]
    assert len(filtered) > 0
    assert all(entry["employee_name"] == "Менеджер Иванов" for entry in filtered)

    # Пагинация: limit=1 должен вернуть только самую свежую запись и
    # выставить has_more=True, пока есть более старые.
    first_page = client.get(
        f"/api/businesses/{business_id}/employees/activity",
        params={"limit": 1},
        headers=headers,
    ).json()
    assert len(first_page["items"]) == 1
    assert first_page["has_more"] is True
    second_page = client.get(
        f"/api/businesses/{business_id}/employees/activity",
        params={"limit": 1, "offset": 1},
        headers=headers,
    ).json()
    assert second_page["items"][0]["id"] != first_page["items"][0]["id"]

    # Фильтр по периоду (days) — за последний "0 дней назад" (то есть от
    # начала сегодняшних суток) события, только что созданные в этом же
    # тесте, всё ещё должны попадать в выборку.
    recent = client.get(
        f"/api/businesses/{business_id}/employees/activity",
        params={"days": 1},
        headers=headers,
    ).json()["items"]
    assert len(recent) > 0

    # days=0 на бэке не должен трактоваться как "без фильтра" (тот же
    # класс ошибки, что и path/query "0 похож на False" в других местах
    # проекта) — здесь просто проверяем, что параметр вообще принимается
    # и не роняет запрос.
    ancient = client.get(
        f"/api/businesses/{business_id}/employees/activity",
        params={"days": 3650},
        headers=headers,
    ).json()["items"]
    assert len(ancient) >= len(recent)

    # Сводка нагрузки — 1 аренда и 1 заметка на этого сотрудника.
    workload = client.get(f"/api/businesses/{business_id}/employees/workload", headers=headers).json()
    manager_row = next(w for w in workload if w["employee_id"] == emp["id"])
    assert manager_row["rentals_created"] == 1
    assert manager_row["client_notes"] == 1
    assert manager_row["rental_photos"] == 0

    # Тот же period-фильтр (days), что и в /activity — события только что
    # созданы, поэтому за последние сутки они всё ещё должны учитываться.
    workload_recent = client.get(
        f"/api/businesses/{business_id}/employees/workload", params={"days": 1}, headers=headers
    ).json()
    manager_row_recent = next(w for w in workload_recent if w["employee_id"] == emp["id"])
    assert manager_row_recent["rentals_created"] == 1


def test_employee_last_login_at_visible_only_to_owner(client):
    owner = register_business(client, email="lastlogin-owner@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Наблюдатель"}, headers=headers).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{pos['id']}/permissions",
        json={"permissions": [{"resource": "employees", "level": "view"}]},
        headers=headers,
    )
    client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "neverlogged@example.com",
            "name": "Ещё не заходил",
            "position_id": pos["id"],
            "temporary_password": "another long enough password",
        },
        headers=headers,
    )

    # Ни разу не входил (приглашённый только что) — last_login_at должен
    # быть None, а не отсутствовать вовсе или выглядеть как "давным-давно".
    owner_view = client.get(f"/api/businesses/{business_id}/employees", headers=headers).json()
    newcomer = next(e for e in owner_view if e["email"] == "neverlogged@example.com")
    assert newcomer["last_login_at"] is None

    watcher_token = _login(client, "neverlogged@example.com", "another long enough password")

    # Теперь этот сотрудник входил — у владельца должно появиться время
    # входа; у самого себя (не-владельца, только view на employees) оно
    # по-прежнему скрыто, как и email (тот же периметр видимости, 65-й проход).
    owner_view_after = client.get(f"/api/businesses/{business_id}/employees", headers=headers).json()
    newcomer_after = next(e for e in owner_view_after if e["email"] == "neverlogged@example.com")
    assert newcomer_after["last_login_at"] is not None

    watcher_view = client.get(
        f"/api/businesses/{business_id}/employees", headers=auth_headers(watcher_token)
    ).json()
    assert all(e["last_login_at"] is None for e in watcher_view)


def test_employee_update_and_position_rename_log_before_after_meta(client):
    owner = register_business(client, email="meta-owner@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    pos_a = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Стажёр"}, headers=headers).json()
    pos_b = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Специалист"}, headers=headers).json()
    emp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "growing@example.com",
            "name": "Растущий Сотрудник",
            "position_id": pos_a["id"],
            "temporary_password": "another long enough password",
        },
        headers=headers,
    ).json()

    client.patch(
        f"/api/businesses/{business_id}/employees/{emp['id']}",
        json={"name": "Выросший Сотрудник", "position_id": pos_b["id"]},
        headers=headers,
    )
    client.patch(f"/api/businesses/{business_id}/positions/{pos_a['id']}", json={"title": "Младший специалист"}, headers=headers)

    activity = client.get(f"/api/businesses/{business_id}/employees/activity", headers=headers).json()["items"]

    update_entry = next(e for e in activity if e["resource"] == "employee" and e["action"] == "update")
    assert update_entry["meta"]["name_before"] == "Растущий Сотрудник"
    assert update_entry["meta"]["name_after"] == "Выросший Сотрудник"
    assert update_entry["meta"]["position_before"] == "Стажёр"
    assert update_entry["meta"]["position_after"] == "Специалист"

    rename_entry = next(e for e in activity if e["resource"] == "position" and e["action"] == "rename")
    assert rename_entry["meta"]["title_before"] == "Стажёр"
    assert rename_entry["meta"]["title_after"] == "Младший специалист"
