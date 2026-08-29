"""Тринадцатый проход: жёсткий справочник категорий оборудования (создание —
только владелец бизнеса), поле "Заметка" на позиции, массовый CSV-импорт.
Пользователь явно выбрал "Только владелец бизнеса" в качестве ответа на
уточняющий вопрос про то, кто может пополнять справочник категорий."""
from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    return client.get("/api/businesses", headers=auth_headers(token)).json()[0]["id"]


def _login(client, email, password):
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _make_edit_employee(client, owner_token, business_id, *, email="edit-emp@example.com"):
    position = client.post(
        f"/api/businesses/{business_id}/positions", json={"title": "Редактор оборудования"}, headers=auth_headers(owner_token)
    ).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{position['id']}/permissions",
        json={"permissions": [{"resource": "equipment", "level": "edit"}]},
        headers=auth_headers(owner_token),
    )
    client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": email, "name": "Редактор", "position_id": position["id"], "temporary_password": "another long enough password"},
        headers=auth_headers(owner_token),
    )
    return _login(client, email, "another long enough password")


def _make_view_employee(client, owner_token, business_id, *, email="view-emp@example.com"):
    position = client.post(
        f"/api/businesses/{business_id}/positions", json={"title": "Наблюдатель оборудования"}, headers=auth_headers(owner_token)
    ).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{position['id']}/permissions",
        json={"permissions": [{"resource": "equipment", "level": "view"}]},
        headers=auth_headers(owner_token),
    )
    client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": email, "name": "Наблюдатель", "position_id": position["id"], "temporary_password": "another long enough password"},
        headers=auth_headers(owner_token),
    )
    return _login(client, email, "another long enough password")


# --- Справочник категорий ----------------------------------------------------


def test_owner_can_create_category(client):
    owner = register_business(client, email="cat-owner@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment-categories",
        json={"name": "Спецтехника"},
        headers=auth_headers(owner["access_token"]),
    )
    assert resp.status_code == 201
    assert resp.json()["name"] == "Спецтехника"

    listed = client.get(f"/api/businesses/{business_id}/equipment-categories", headers=auth_headers(owner["access_token"]))
    assert listed.status_code == 200
    assert [c["name"] for c in listed.json()] == ["Спецтехника"]


def test_creating_duplicate_category_name_fails(client):
    owner = register_business(client, email="cat-dup@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=headers)
    resp = client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=headers)
    assert resp.status_code == 400


def test_edit_employee_can_list_but_not_create_category(client):
    owner = register_business(client, email="cat-edit-emp@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    employee_token = _make_edit_employee(client, owner["access_token"], business_id)

    list_resp = client.get(f"/api/businesses/{business_id}/equipment-categories", headers=auth_headers(employee_token))
    assert list_resp.status_code == 200

    create_resp = client.post(
        f"/api/businesses/{business_id}/equipment-categories", json={"name": "Новая"}, headers=auth_headers(employee_token)
    )
    assert create_resp.status_code == 403


def test_view_employee_can_list_but_not_create_category(client):
    owner = register_business(client, email="cat-view-emp@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    employee_token = _make_view_employee(client, owner["access_token"], business_id)

    list_resp = client.get(f"/api/businesses/{business_id}/equipment-categories", headers=auth_headers(employee_token))
    assert list_resp.status_code == 200

    create_resp = client.post(
        f"/api/businesses/{business_id}/equipment-categories", json={"name": "Новая"}, headers=auth_headers(employee_token)
    )
    assert create_resp.status_code == 403


def test_owner_creating_equipment_with_unknown_category_auto_creates_it(client):
    """Владелец не обязан отдельно ходить в справочник перед каждой новой
    позицией — новая категория заводится автоматически при создании
    оборудования, ЕСЛИ создающий — владелец бизнеса."""
    owner = register_business(client, email="cat-autocreate@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Экскаватор", "category": "Спецтехника новая", "daily_rate": 5000},
        headers=headers,
    )
    assert resp.status_code == 201

    listed = client.get(f"/api/businesses/{business_id}/equipment-categories", headers=headers).json()
    assert "Спецтехника новая" in [c["name"] for c in listed]


def test_employee_creating_equipment_with_unknown_category_is_rejected(client):
    owner = register_business(client, email="cat-emp-reject@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    employee_token = _make_edit_employee(client, owner["access_token"], business_id)

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Несуществующая категория", "daily_rate": 100},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 400


def test_employee_creating_equipment_with_known_category_succeeds(client):
    owner = register_business(client, email="cat-emp-ok@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=headers)
    employee_token = _make_edit_employee(client, owner["access_token"], business_id)

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 100},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 201


def test_update_equipment_rejects_unknown_category_for_employee(client):
    owner = register_business(client, email="cat-emp-update@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=headers)
    eq = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 100},
        headers=headers,
    ).json()
    employee_token = _make_edit_employee(client, owner["access_token"], business_id, email="cat-emp-update-emp@example.com")

    resp = client.patch(
        f"/api/businesses/{business_id}/equipment/{eq['id']}",
        json={"category": "Совсем новая"},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 400
    # Существующая позиция при этом не тронута.
    unchanged = client.get(f"/api/businesses/{business_id}/equipment", headers=headers).json()[0]
    assert unchanged["category"] == "Инструмент"


# --- Заметка на позиции -------------------------------------------------------


def test_equipment_notes_field_round_trips(client):
    owner = register_business(client, email="eq-notes@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Перфоратор", "category": "Инструмент", "daily_rate": 500, "notes": "Треснул кожух, но работает"},
        headers=headers,
    )
    assert resp.status_code == 201
    eq = resp.json()
    assert eq["notes"] == "Треснул кожух, но работает"

    update = client.patch(
        f"/api/businesses/{business_id}/equipment/{eq['id']}", json={"notes": "Кожух заменили"}, headers=headers
    )
    assert update.status_code == 200
    assert update.json()["notes"] == "Кожух заменили"


def test_equipment_notes_field_defaults_to_none(client):
    owner = register_business(client, email="eq-notes-none@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 300},
        headers=headers,
    )
    assert resp.status_code == 201
    assert resp.json()["notes"] is None


# --- Массовый импорт (CSV) ----------------------------------------------------


def _csv_upload(client, business_id, token, content: str, filename="import.csv"):
    return client.post(
        f"/api/businesses/{business_id}/equipment/import",
        headers=auth_headers(token),
        files={"file": (filename, content.encode("utf-8"), "text/csv")},
    )


def test_import_creates_valid_rows_and_reports_errors(client):
    owner = register_business(client, email="import-basic@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    csv_content = (
        "name,category,daily_rate,deposit,notes\n"
        "Перфоратор,Инструмент,500,2000,Комплект полный\n"
        ",Инструмент,300,,\n"  # пустое имя — ошибка
        "Дрель,Инструмент,abc,,\n"  # daily_rate не число — ошибка
    )
    resp = _csv_upload(client, business_id, owner["access_token"], csv_content)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["created"] == 1
    assert body["failed"] == 2
    assert body["results"][0]["ok"] is True
    assert body["results"][0]["equipment"]["name"] == "Перфоратор"
    assert body["results"][1]["ok"] is False
    assert body["results"][2]["ok"] is False

    listed = client.get(f"/api/businesses/{business_id}/equipment", headers=headers).json()
    assert len(listed) == 1
    assert listed[0]["name"] == "Перфоратор"


def test_import_by_owner_auto_creates_unknown_categories(client):
    owner = register_business(client, email="import-owner-cat@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    csv_content = "name,category,daily_rate\nЭкскаватор,Спецтехника из импорта,4000\n"
    resp = _csv_upload(client, business_id, owner["access_token"], csv_content)
    assert resp.status_code == 200
    assert resp.json()["created"] == 1

    categories = client.get(f"/api/businesses/{business_id}/equipment-categories", headers=headers).json()
    assert "Спецтехника из импорта" in [c["name"] for c in categories]


def test_import_by_employee_with_unknown_category_fails_that_row(client):
    owner = register_business(client, email="import-emp-cat@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    employee_token = _make_edit_employee(client, owner["access_token"], business_id, email="import-emp@example.com")

    csv_content = "name,category,daily_rate\nЭкскаватор,Спецтехника без справочника,4000\n"
    resp = _csv_upload(client, business_id, employee_token, csv_content)
    assert resp.status_code == 200
    body = resp.json()
    assert body["created"] == 0
    assert body["failed"] == 1
    assert "справочник" in body["results"][0]["error"]


def test_import_rejects_missing_required_columns(client):
    owner = register_business(client, email="import-badheader@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])

    resp = _csv_upload(client, business_id, owner["access_token"], "name,price\nЧто-то,100\n")
    assert resp.status_code == 400


def test_import_requires_edit_permission(client):
    owner = register_business(client, email="import-viewonly@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    employee_token = _make_view_employee(client, owner["access_token"], business_id, email="import-view@example.com")

    resp = _csv_upload(client, business_id, employee_token, "name,category,daily_rate\nШуруповёрт,Инструмент,150\n")
    assert resp.status_code == 403


# --- Пробельная валидация name/category (14-й проход, пункт 2 обзора формы) --


def test_create_equipment_rejects_whitespace_only_name(client):
    owner = register_business(client, email="ws-name@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "   ", "category": "Инструмент", "daily_rate": 100},
        headers=headers,
    )
    assert resp.status_code == 422


def test_create_equipment_rejects_whitespace_only_category(client):
    owner = register_business(client, email="ws-category@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "   ", "daily_rate": 100},
        headers=headers,
    )
    assert resp.status_code == 422


def test_create_equipment_trims_surrounding_whitespace(client):
    owner = register_business(client, email="ws-trim@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "  Дрель  ", "category": "  Инструмент  ", "daily_rate": 100},
        headers=headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Дрель"
    assert body["category"] == "Инструмент"


def test_update_equipment_rejects_whitespace_only_name(client):
    owner = register_business(client, email="ws-update@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    eq = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 100},
        headers=headers,
    ).json()

    resp = client.patch(
        f"/api/businesses/{business_id}/equipment/{eq['id']}", json={"name": "   "}, headers=headers
    )
    assert resp.status_code == 422


def test_create_category_rejects_whitespace_only_name(client):
    owner = register_business(client, email="ws-cat-create@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "   "}, headers=headers)
    assert resp.status_code == 422


def test_create_category_trims_surrounding_whitespace(client):
    owner = register_business(client, email="ws-cat-trim@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment-categories", json={"name": "  Спецтехника  "}, headers=headers
    )
    assert resp.status_code == 201
    assert resp.json()["name"] == "Спецтехника"
