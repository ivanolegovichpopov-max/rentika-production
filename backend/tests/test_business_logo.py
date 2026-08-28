"""Логотип бизнеса — PATCH /businesses/{id}/logo (см. миграцию 0007,
BusinessLogoUpdate, AccountSettings.tsx). Хранится как ссылка ИЛИ data: URL,
своего файлового хранилища у проекта нет. Менять может только владелец
бизнеса — та же проверка прав, что и на notes_mode/messaging_permission."""
from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    return client.get("/api/businesses", headers=auth_headers(token)).json()[0]["id"]


def _login(client, email, password):
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _invite(client, business_id, owner_token, email, name="Сотрудник"):
    resp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": email, "name": name, "temporary_password": "another long enough password"},
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 201, resp.text
    return _login(client, email, "another long enough password")


def test_business_has_no_logo_by_default(client):
    owner = register_business(client, email="logo1@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    resp = client.get(f"/api/businesses/{business_id}", headers=auth_headers(owner["access_token"]))
    assert resp.status_code == 200
    assert resp.json()["logo_url"] is None


def test_owner_can_set_and_clear_logo(client):
    owner = register_business(client, email="logo2@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])

    data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    set_resp = client.patch(
        f"/api/businesses/{business_id}/logo",
        json={"logo_url": data_url},
        headers=auth_headers(owner["access_token"]),
    )
    assert set_resp.status_code == 200, set_resp.text
    assert set_resp.json()["logo_url"] == data_url

    # Виден дальше через обычный GET бизнеса.
    get_resp = client.get(f"/api/businesses/{business_id}", headers=auth_headers(owner["access_token"]))
    assert get_resp.json()["logo_url"] == data_url

    # Можно убрать, передав null.
    clear_resp = client.patch(
        f"/api/businesses/{business_id}/logo",
        json={"logo_url": None},
        headers=auth_headers(owner["access_token"]),
    )
    assert clear_resp.status_code == 200
    assert clear_resp.json()["logo_url"] is None


def test_employee_cannot_change_logo(client):
    owner = register_business(client, email="logo3@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    employee_token = _invite(client, business_id, owner["access_token"], "worker3@example.com")

    resp = client.patch(
        f"/api/businesses/{business_id}/logo",
        json={"logo_url": "https://example.com/logo.png"},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 403
