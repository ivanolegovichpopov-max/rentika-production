"""Восемнадцатый проход: справочник складов/точек хранения — точная
аналогия справочника категорий (test_equipment_categories.py), с поправкой
на то, что склад необязателен (равно как и все проверки на "не указан")."""
from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    return client.get("/api/businesses", headers=auth_headers(token)).json()[0]["id"]


def _login(client, email, password):
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _make_edit_employee(client, owner_token, business_id, *, email="wh-edit-emp@example.com"):
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


def test_owner_can_create_warehouse(client):
    owner = register_business(client, email="wh-owner@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment-warehouses",
        json={"name": "Склад №1"},
        headers=auth_headers(owner["access_token"]),
    )
    assert resp.status_code == 201
    assert resp.json()["name"] == "Склад №1"

    listed = client.get(f"/api/businesses/{business_id}/equipment-warehouses", headers=auth_headers(owner["access_token"]))
    assert listed.status_code == 200
    assert [w["name"] for w in listed.json()] == ["Склад №1"]


def test_creating_duplicate_warehouse_name_fails(client):
    owner = register_business(client, email="wh-dup@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    client.post(f"/api/businesses/{business_id}/equipment-warehouses", json={"name": "Центральный"}, headers=headers)
    resp = client.post(f"/api/businesses/{business_id}/equipment-warehouses", json={"name": "центральный"}, headers=headers)
    assert resp.status_code == 400


def test_edit_employee_can_list_but_not_create_warehouse(client):
    owner = register_business(client, email="wh-edit@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    employee_token = _make_edit_employee(client, owner["access_token"], business_id)

    list_resp = client.get(f"/api/businesses/{business_id}/equipment-warehouses", headers=auth_headers(employee_token))
    assert list_resp.status_code == 200

    create_resp = client.post(
        f"/api/businesses/{business_id}/equipment-warehouses", json={"name": "Новый"}, headers=auth_headers(employee_token)
    )
    assert create_resp.status_code == 403


def test_equipment_without_warehouse_is_allowed(client):
    """Склад необязателен — в отличие от категории, оборудование без него
    создаётся и обновляется без каких-либо ошибок."""
    owner = register_business(client, email="wh-optional@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 100},
        headers=headers,
    )
    assert resp.status_code == 201
    assert resp.json()["warehouse"] is None

    eq_id = resp.json()["id"]
    patch_resp = client.patch(f"/api/businesses/{business_id}/equipment/{eq_id}", json={"daily_rate": 150}, headers=headers)
    assert patch_resp.status_code == 200
    assert patch_resp.json()["warehouse"] is None


def test_owner_creating_equipment_with_unknown_warehouse_auto_creates_it(client):
    owner = register_business(client, email="wh-autocreate@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Экскаватор", "category": "Спецтехника", "daily_rate": 5000, "warehouse": "Новый склад"},
        headers=headers,
    )
    assert resp.status_code == 201
    assert resp.json()["warehouse"] == "Новый склад"

    warehouses = [w["name"] for w in client.get(f"/api/businesses/{business_id}/equipment-warehouses", headers=headers).json()]
    assert "Новый склад" in warehouses


def test_employee_creating_equipment_with_unknown_warehouse_is_rejected(client):
    owner = register_business(client, email="wh-emp-reject@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    owner_headers = auth_headers(owner["access_token"])
    # Категория заведена заранее владельцем — иначе ошибка 400 могла бы
    # прийти из-за неизвестной КАТЕГОРИИ (она валидируется первой в
    # create_equipment), маскируя то, что реально проверяет этот тест.
    client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=owner_headers)
    employee_token = _make_edit_employee(client, owner["access_token"], business_id)

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 100, "warehouse": "Неизвестный склад"},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 400
    assert "Склад" in resp.json()["detail"]


def test_employee_can_use_existing_warehouse_regardless_of_typed_case(client):
    owner = register_business(client, email="wh-emp-case@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    owner_headers = auth_headers(owner["access_token"])
    client.post(f"/api/businesses/{business_id}/equipment-warehouses", json={"name": "Центральный"}, headers=owner_headers)
    client.post(f"/api/businesses/{business_id}/equipment-categories", json={"name": "Инструмент"}, headers=owner_headers)
    employee_token = _make_edit_employee(client, owner["access_token"], business_id)

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 100, "warehouse": "ЦЕНТРАЛЬНЫЙ"},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 201
    assert resp.json()["warehouse"] == "Центральный"  # каноническое написание справочника


def test_warehouse_equipment_count_reflects_usage(client):
    owner = register_business(client, email="wh-count@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 100, "warehouse": "Склад А"},
        headers=headers,
    )
    client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Перфоратор", "category": "Инструмент", "daily_rate": 200, "warehouse": "Склад А"},
        headers=headers,
    )
    client.post(f"/api/businesses/{business_id}/equipment-warehouses", json={"name": "Пустой склад"}, headers=headers)

    warehouses = {w["name"]: w["equipment_count"] for w in client.get(f"/api/businesses/{business_id}/equipment-warehouses", headers=headers).json()}
    assert warehouses["Склад А"] == 2
    assert warehouses["Пустой склад"] == 0


def test_owner_can_rename_warehouse_and_equipment_follows(client):
    owner = register_business(client, email="wh-rename@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    wh = client.post(f"/api/businesses/{business_id}/equipment-warehouses", json={"name": "Старый склад"}, headers=headers).json()
    eq = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Экскаватор", "category": "Спецтехника", "daily_rate": 5000, "warehouse": "Старый склад"},
        headers=headers,
    ).json()

    resp = client.patch(
        f"/api/businesses/{business_id}/equipment-warehouses/{wh['id']}", json={"name": "Новое имя"}, headers=headers
    )
    assert resp.status_code == 200
    assert resp.json()["equipment_count"] == 1

    updated_eq = client.get(f"/api/businesses/{business_id}/equipment", headers=headers).json()[0]
    assert updated_eq["id"] == eq["id"]
    assert updated_eq["warehouse"] == "Новое имя"


def test_rename_warehouse_requires_owner(client):
    owner = register_business(client, email="wh-rename-403@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    wh = client.post(f"/api/businesses/{business_id}/equipment-warehouses", json={"name": "Склад"}, headers=headers).json()
    employee_token = _make_edit_employee(client, owner["access_token"], business_id, email="wh-rename-403-emp@example.com")

    resp = client.patch(
        f"/api/businesses/{business_id}/equipment-warehouses/{wh['id']}",
        json={"name": "Другое"},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 403


def test_owner_can_delete_unused_warehouse(client):
    owner = register_business(client, email="wh-delete@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    wh = client.post(f"/api/businesses/{business_id}/equipment-warehouses", json={"name": "Ненужный"}, headers=headers).json()

    resp = client.delete(f"/api/businesses/{business_id}/equipment-warehouses/{wh['id']}", headers=headers)
    assert resp.status_code == 204

    warehouses = client.get(f"/api/businesses/{business_id}/equipment-warehouses", headers=headers).json()
    assert warehouses == []


def test_deleting_warehouse_in_use_is_rejected(client):
    owner = register_business(client, email="wh-delete-used@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    wh = client.post(f"/api/businesses/{business_id}/equipment-warehouses", json={"name": "Склад"}, headers=headers).json()
    client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 100, "warehouse": "Склад"},
        headers=headers,
    )

    resp = client.delete(f"/api/businesses/{business_id}/equipment-warehouses/{wh['id']}", headers=headers)
    assert resp.status_code == 400

    warehouses = client.get(f"/api/businesses/{business_id}/equipment-warehouses", headers=headers).json()
    assert len(warehouses) == 1


def test_delete_warehouse_404_for_other_business(client):
    owner_a = register_business(client, email="wh-404-a@example.com", password="correct horse battery staple")
    business_a = _get_business_id(client, owner_a["access_token"])
    wh_a = client.post(
        f"/api/businesses/{business_a}/equipment-warehouses", json={"name": "Склад"}, headers=auth_headers(owner_a["access_token"])
    ).json()

    owner_b = register_business(client, email="wh-404-b@example.com", password="correct horse battery staple")
    business_b = _get_business_id(client, owner_b["access_token"])

    resp = client.delete(
        f"/api/businesses/{business_b}/equipment-warehouses/{wh_a['id']}", headers=auth_headers(owner_b["access_token"])
    )
    assert resp.status_code == 404


def test_import_row_with_warehouse_column(client):
    owner = register_business(client, email="wh-import@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])

    csv_content = "name,category,daily_rate,warehouse\nДрель,Инструмент,100,Склад Б\n"
    resp = client.post(
        f"/api/businesses/{business_id}/equipment/import",
        headers=headers,
        files={"file": ("import.csv", csv_content.encode("utf-8"), "text/csv")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["created"] == 1
    assert body["results"][0]["equipment"]["warehouse"] == "Склад Б"


# --- Ручной порядок (двадцатый проход, п.1 обзора) — см. точную копию тестов
# в test_equipment_categories.py.


def test_owner_can_reorder_warehouses(client):
    owner = register_business(client, email="reorder-wh@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    headers = auth_headers(owner["access_token"])
    names = ["Центральный", "Северный", "Южный"]
    ids = [
        client.post(f"/api/businesses/{business_id}/equipment-warehouses", json={"name": n}, headers=headers).json()["id"]
        for n in names
    ]
    new_order = [ids[1], ids[2], ids[0]]
    resp = client.post(f"/api/businesses/{business_id}/equipment-warehouses/reorder", json={"order": new_order}, headers=headers)
    assert resp.status_code == 200
    assert [w["name"] for w in resp.json()] == ["Северный", "Южный", "Центральный"]

    listed_after = client.get(f"/api/businesses/{business_id}/equipment-warehouses", headers=headers).json()
    assert [w["name"] for w in listed_after] == ["Северный", "Южный", "Центральный"]


def test_reorder_warehouses_requires_owner(client):
    owner = register_business(client, email="reorder-wh-403@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    owner_headers = auth_headers(owner["access_token"])
    wh_id = client.post(
        f"/api/businesses/{business_id}/equipment-warehouses", json={"name": "Склад"}, headers=owner_headers
    ).json()["id"]
    employee_token = _make_edit_employee(client, owner["access_token"], business_id, email="reorder-wh-403-emp@example.com")

    resp = client.post(
        f"/api/businesses/{business_id}/equipment-warehouses/reorder",
        json={"order": [wh_id]},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 403
