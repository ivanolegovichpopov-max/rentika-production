from tests.conftest import auth_headers, register_business


def test_register_creates_business_and_owner(client):
    data = register_business(client)
    assert data["access_token"]

    me = client.get("/api/auth/me", headers=auth_headers(data["access_token"]))
    assert me.status_code == 200
    assert me.json()["email"] == "owner@example.com"


def test_register_rejects_short_password(client):
    resp = client.post(
        "/api/auth/register",
        json={"email": "a@example.com", "password": "short1", "business_name": "Тест"},
    )
    assert resp.status_code == 400


def test_register_rejects_duplicate_email(client):
    register_business(client, email="dup@example.com")
    resp = client.post(
        "/api/auth/register",
        json={"email": "dup@example.com", "password": "another long password", "business_name": "Другой бизнес"},
    )
    assert resp.status_code == 400


def test_login_with_correct_password(client):
    register_business(client, email="login@example.com", password="correct horse battery staple")
    resp = client.post("/api/auth/login", json={"email": "login@example.com", "password": "correct horse battery staple"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["requires_totp"] is False
    assert body["access_token"]


def test_login_with_wrong_password_fails(client):
    register_business(client, email="wrong@example.com", password="correct horse battery staple")
    resp = client.post("/api/auth/login", json={"email": "wrong@example.com", "password": "totally-wrong-password"})
    assert resp.status_code == 401


def test_login_locks_after_many_failed_attempts(client):
    register_business(client, email="lockout@example.com", password="correct horse battery staple")
    for _ in range(10):
        client.post("/api/auth/login", json={"email": "lockout@example.com", "password": "bad-password"})
    resp = client.post("/api/auth/login", json={"email": "lockout@example.com", "password": "correct horse battery staple"})
    assert resp.status_code == 423


def test_refresh_token_rotates_and_old_one_stops_working(client):
    data = register_business(client, email="refresh@example.com")
    first_refresh_cookie = client.cookies.get("rentika_refresh")
    assert first_refresh_cookie

    resp1 = client.post("/api/auth/refresh")
    assert resp1.status_code == 200
    second_refresh_cookie = client.cookies.get("rentika_refresh")
    assert second_refresh_cookie != first_refresh_cookie

    # Подставляем старый (уже отозванный) refresh-токен вручную
    client.cookies.set("rentika_refresh", first_refresh_cookie)
    resp2 = client.post("/api/auth/refresh")
    assert resp2.status_code == 401


def test_logout_revokes_refresh_token(client):
    register_business(client, email="logout@example.com")
    resp = client.post("/api/auth/logout")
    assert resp.status_code == 204
    resp2 = client.post("/api/auth/refresh")
    assert resp2.status_code == 401


def test_change_password_success_and_relogin(client):
    data = register_business(client, email="changepw1@example.com", password="correct horse battery staple")
    resp = client.post(
        "/api/auth/change-password",
        json={"current_password": "correct horse battery staple", "new_password": "a brand new long password"},
        headers=auth_headers(data["access_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["access_token"]

    old_login = client.post(
        "/api/auth/login", json={"email": "changepw1@example.com", "password": "correct horse battery staple"}
    )
    assert old_login.status_code == 401

    new_login = client.post(
        "/api/auth/login", json={"email": "changepw1@example.com", "password": "a brand new long password"}
    )
    assert new_login.status_code == 200


def test_change_password_rejects_wrong_current_password(client):
    data = register_business(client, email="changepw2@example.com", password="correct horse battery staple")
    resp = client.post(
        "/api/auth/change-password",
        json={"current_password": "totally wrong password", "new_password": "a brand new long password"},
        headers=auth_headers(data["access_token"]),
    )
    assert resp.status_code == 401


def test_change_password_enforces_policy_on_new_password(client):
    data = register_business(client, email="changepw3@example.com", password="correct horse battery staple")
    resp = client.post(
        "/api/auth/change-password",
        json={"current_password": "correct horse battery staple", "new_password": "short1"},
        headers=auth_headers(data["access_token"]),
    )
    assert resp.status_code == 400


def test_change_password_revokes_other_sessions(client):
    data = register_business(client, email="changepw4@example.com", password="correct horse battery staple")
    # У нас уже есть refresh-cookie от register — эмулируем "другую сессию".
    first_refresh_cookie = client.cookies.get("rentika_refresh")
    assert first_refresh_cookie

    resp = client.post(
        "/api/auth/change-password",
        json={"current_password": "correct horse battery staple", "new_password": "a brand new long password"},
        headers=auth_headers(data["access_token"]),
    )
    assert resp.status_code == 200
    new_refresh_cookie = client.cookies.get("rentika_refresh")
    assert new_refresh_cookie and new_refresh_cookie != first_refresh_cookie

    # Старый (до смены пароля) refresh-токен — отозван (эмулирует другое
    # устройство/сессию).
    client.cookies.set("rentika_refresh", first_refresh_cookie)
    old_refresh_resp = client.post("/api/auth/refresh")
    assert old_refresh_resp.status_code == 401

    # А НОВЫЙ, выданный вместе со сменой пароля, продолжает работать — текущая
    # сессия не разлогинивается сменой собственного пароля.
    client.cookies.set("rentika_refresh", new_refresh_cookie)
    new_refresh_resp = client.post("/api/auth/refresh")
    assert new_refresh_resp.status_code == 200
