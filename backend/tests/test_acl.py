from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    resp = client.get("/api/businesses", headers=auth_headers(token))
    assert resp.status_code == 200
    businesses = resp.json()
    assert len(businesses) == 1
    return businesses[0]["id"]


def _login(client, email, password):
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def test_owner_has_full_access_without_explicit_permissions(client):
    owner = register_business(client, email="owner1@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Перфоратор", "category": "Инструмент", "daily_rate": 500},
        headers=auth_headers(owner["access_token"]),
    )
    assert resp.status_code == 201


def test_employee_with_view_only_cannot_create(client):
    owner = register_business(client, email="owner2@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])

    position = client.post(
        f"/api/businesses/{business_id}/positions", json={"title": "Наблюдатель"}, headers=auth_headers(owner["access_token"])
    ).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{position['id']}/permissions",
        json={"permissions": [{"resource": "equipment", "level": "view"}]},
        headers=auth_headers(owner["access_token"]),
    )
    client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "watcher@example.com",
            "name": "Наблюдатель Иванов",
            "position_id": position["id"],
            "temporary_password": "another long enough password",
        },
        headers=auth_headers(owner["access_token"]),
    )

    employee_token = _login(client, "watcher@example.com", "another long enough password")

    list_resp = client.get(f"/api/businesses/{business_id}/equipment", headers=auth_headers(employee_token))
    assert list_resp.status_code == 200

    create_resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 300},
        headers=auth_headers(employee_token),
    )
    assert create_resp.status_code == 403


def test_employee_with_edit_permission_can_create(client):
    owner = register_business(client, email="owner3@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])

    position = client.post(
        f"/api/businesses/{business_id}/positions", json={"title": "Менеджер"}, headers=auth_headers(owner["access_token"])
    ).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{position['id']}/permissions",
        json={"permissions": [{"resource": "equipment", "level": "edit"}]},
        headers=auth_headers(owner["access_token"]),
    )
    client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "manager@example.com",
            "name": "Менеджер Петров",
            "position_id": position["id"],
            "temporary_password": "another long enough password",
        },
        headers=auth_headers(owner["access_token"]),
    )

    employee_token = _login(client, "manager@example.com", "another long enough password")
    resp = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": "Дрель", "category": "Инструмент", "daily_rate": 300},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 201


def test_employee_without_position_has_no_access(client):
    owner = register_business(client, email="owner4@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])

    client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "noposition@example.com",
            "name": "Без должности",
            "temporary_password": "another long enough password",
        },
        headers=auth_headers(owner["access_token"]),
    )
    employee_token = _login(client, "noposition@example.com", "another long enough password")

    resp = client.get(f"/api/businesses/{business_id}/equipment", headers=auth_headers(employee_token))
    assert resp.status_code == 403


def test_only_owner_can_manage_positions(client):
    owner = register_business(client, email="owner5@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])

    position = client.post(
        f"/api/businesses/{business_id}/positions", json={"title": "Всё-редактор"}, headers=auth_headers(owner["access_token"])
    ).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{position['id']}/permissions",
        json={"permissions": [{"resource": "employees", "level": "edit"}]},
        headers=auth_headers(owner["access_token"]),
    )
    client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "poweruser@example.com",
            "name": "Пользователь с edit на employees",
            "position_id": position["id"],
            "temporary_password": "another long enough password",
        },
        headers=auth_headers(owner["access_token"]),
    )
    employee_token = _login(client, "poweruser@example.com", "another long enough password")

    # Даже с edit на employees — управлять самими должностями (ACL-матрицей)
    # нельзя, это привилегия исключительно владельца (см. positions.py:_require_owner).
    resp = client.post(
        f"/api/businesses/{business_id}/positions", json={"title": "Новая должность"}, headers=auth_headers(employee_token)
    )
    assert resp.status_code == 403
