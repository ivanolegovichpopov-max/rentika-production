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


# --- Пятнадцатый проход: регистронезависимость, equipment_count, управление
# справочником (переименование/удаление) ------------------------------------


def test_creating_category_case_insensitive_duplicate_fails(client):
    owner = register_business(client, email="ci-cat-dup@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=headers)
    resp = client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "инструмент"}, headers=headers)
    assert resp.status_code == 400


def test_owner_creating_equipment_with_different_case_reuses_canonical_name(client):
    """Владелец создаёт «Инструмент», затем создаёт позицию с категорией
    «инструмент» (другой регистр) — должна переиспользоваться уже
    существующая запись справочника, а сама позиция должна сохранить
    КАНОНИЧЕСКОЕ написание («Инструмент»), не то, что ввёл пользователь —
    иначе точное сравнение в фильтре на фронтенде не находило бы такую
    позицию при выборе категории «Инструмент»."""
    owner = register_business(client, email="ci-canon@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=headers)
    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "инструмент", "daily_rate": 100},
        headers=headers,
    )
    assert resp.status_code == 201
    assert resp.json()["category"] == "Инструмент"

    categories = client.get(f"/api/businesses/{business_id}/equipment-categories", headers=headers).json()
    assert [c["name"] for c in categories] == ["Инструмент"]  # не расплодилось на два варианта регистра


def test_employee_can_use_existing_category_regardless_of_typed_case(client):
    owner = register_business(client, email="ci-emp@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=headers)
    employee_token = _make_edit_employee(client, owner["access_token"], business_id, email="ci-emp-emp@example.com")

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "ИНСТРУМЕНТ", "daily_rate": 100},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 201
    assert resp.json()["category"] == "Инструмент"


def test_equipment_count_reflects_usage(client):
    owner = register_business(client, email="count-cat@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 100},
        headers=headers,
    )
    client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Перфоратор", "category": "Инструмент", "daily_rate": 200},
        headers=headers,
    )
    client.post(
        f"/api/businesses/{business_id}/equipment-categories", json={"name": "Пустая категория"}, headers=headers
    )

    categories = {c["name"]: c["equipment_count"] for c in client.get(f"/api/businesses/{business_id}/equipment-categories", headers=headers).json()}
    assert categories["Инструмент"] == 2
    assert categories["Пустая категория"] == 0


def test_owner_can_rename_category_and_equipment_follows(client):
    owner = register_business(client, email="rename-cat@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    cat = client.post(
        f"/api/businesses/{business_id}/equipment-categories", json={"name": "Стройтехника"}, headers=headers
    ).json()
    eq = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Экскаватор", "category": "Стройтехника", "daily_rate": 5000},
        headers=headers,
    ).json()

    resp = client.patch(
        f"/api/businesses/{business_id}/equipment-categories/{cat['id']}",
        json={"name": "Спецтехника"},
        headers=headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Спецтехника"
    assert body["equipment_count"] == 1

    updated_eq = client.get(f"/api/businesses/{business_id}/equipment", headers=headers).json()[0]
    assert updated_eq["id"] == eq["id"]
    assert updated_eq["category"] == "Спецтехника"


def test_rename_category_rejects_collision_with_another_category(client):
    owner = register_business(client, email="rename-collide@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    cat_a = client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "А"}, headers=headers).json()
    client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Б"}, headers=headers)

    resp = client.patch(
        f"/api/businesses/{business_id}/equipment-categories/{cat_a['id']}", json={"name": "б"}, headers=headers
    )
    assert resp.status_code == 400


def test_rename_category_requires_owner(client):
    owner = register_business(client, email="rename-403@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    cat = client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=headers).json()
    employee_token = _make_edit_employee(client, owner["access_token"], business_id, email="rename-403-emp@example.com")

    resp = client.patch(
        f"/api/businesses/{business_id}/equipment-categories/{cat['id']}",
        json={"name": "Другое"},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 403


def test_rename_category_404_for_other_business(client):
    owner_a = register_business(client, email="rename-a@example.com", password="correct horse battery staple")
    business_a = _get_business_id(client, owner_a["access_token"])
    cat_a = client.post(
        f"/api/businesses/{business_a}/equipment-categories", json={"name": "Инструмент"}, headers=auth_headers(owner_a["access_token"])
    ).json()

    owner_b = register_business(client, email="rename-b@example.com", password="correct horse battery staple")
    business_b = _get_business_id(client, owner_b["access_token"])

    resp = client.patch(
        f"/api/businesses/{business_b}/equipment-categories/{cat_a['id']}",
        json={"name": "Другое"},
        headers=auth_headers(owner_b["access_token"]),
    )
    assert resp.status_code == 404


def test_owner_can_delete_unused_category(client):
    owner = register_business(client, email="delete-cat@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    cat = client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Ненужная"}, headers=headers).json()

    resp = client.delete(f"/api/businesses/{business_id}/equipment-categories/{cat['id']}", headers=headers)
    assert resp.status_code == 204

    categories = client.get(f"/api/businesses/{business_id}/equipment-categories", headers=headers).json()
    assert categories == []


def test_deleting_category_in_use_is_rejected(client):
    owner = register_business(client, email="delete-used@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    cat = client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=headers).json()
    client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 100},
        headers=headers,
    )

    resp = client.delete(f"/api/businesses/{business_id}/equipment-categories/{cat['id']}", headers=headers)
    assert resp.status_code == 400

    categories = client.get(f"/api/businesses/{business_id}/equipment-categories", headers=headers).json()
    assert len(categories) == 1


def test_delete_category_requires_owner(client):
    owner = register_business(client, email="delete-403@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    cat = client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=headers).json()
    employee_token = _make_edit_employee(client, owner["access_token"], business_id, email="delete-403-emp@example.com")

    resp = client.delete(
        f"/api/businesses/{business_id}/equipment-categories/{cat['id']}", headers=auth_headers(employee_token)
    )
    assert resp.status_code == 403


# --- Ручной порядок (двадцатый проход, п.1 обзора) ---------------------------


def test_owner_can_reorder_categories(client):
    owner = register_business(client, email="reorder-cat@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    names = ["Альфа", "Бета", "Гамма"]
    ids = [
        client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": n}, headers=headers).json()["id"]
        for n in names
    ]
    # По умолчанию (без ручной перестановки) список идёт в порядке создания.
    listed = client.get(f"/api/businesses/{business_id}/equipment-categories", headers=headers).json()
    assert [c["name"] for c in listed] == names

    # Переставляем: последняя категория — первой.
    new_order = [ids[2], ids[0], ids[1]]
    resp = client.post(f"/api/businesses/{business_id}/equipment-categories/reorder", json={"order": new_order}, headers=headers)
    assert resp.status_code == 200
    assert [c["name"] for c in resp.json()] == ["Гамма", "Альфа", "Бета"]

    # Порядок сохраняется — виден и при обычном GET, не только в ответе reorder.
    listed_after = client.get(f"/api/businesses/{business_id}/equipment-categories", headers=headers).json()
    assert [c["name"] for c in listed_after] == ["Гамма", "Альфа", "Бета"]


def test_reorder_categories_rejects_incomplete_list(client):
    owner = register_business(client, email="reorder-cat-incomplete@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    ids = [
        client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": n}, headers=headers).json()["id"]
        for n in ["Альфа", "Бета"]
    ]
    # Пропущена одна из двух категорий — список должен быть отклонён, а не
    # молча оставить пропущенную запись с "дырявым" position.
    resp = client.post(f"/api/businesses/{business_id}/equipment-categories/reorder", json={"order": [ids[0]]}, headers=headers)
    assert resp.status_code == 400


def test_reorder_categories_requires_owner(client):
    owner = register_business(client, email="reorder-cat-403@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    owner_headers = auth_headers(owner["access_token"])
    cat_id = client.post(
        f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=owner_headers
    ).json()["id"]
    employee_token = _make_edit_employee(client, owner["access_token"], business_id, email="reorder-cat-403-emp@example.com")

    resp = client.post(
        f"/api/businesses/{business_id}/equipment-categories/reorder",
        json={"order": [cat_id]},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 403
