"""
Дополнительные доработки после 67-го прохода (по итогам разбора "что бы я
ещё добавил" к уже сделанным пунктам):
- видимость Employee.totp_enabled (владелец/платформенный админ, тот же
  круг, что email/phone) — нужна фронту, чтобы подсветить сотрудника без
  включённой 2FA при обязательном требовании должности;
- фильтр журнала действий по resource_id (мини-история изменений одной
  конкретной должности);
- POST /positions/{id}/duplicate — полное дублирование должности со всеми
  правами, цветом, описанием и требованием 2FA.
"""
import pyotp

from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    return client.get("/api/businesses", headers=auth_headers(token)).json()[0]["id"]


def _setup(client, email):
    owner = register_business(client, email=email, password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])
    return headers, business_id


# --------------------------------------------------------------- totp_enabled --


def test_employee_totp_enabled_visible_to_owner_and_reflects_real_state(client):
    headers, business_id = _setup(client, "emp67b-totp@example.com")

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Кассир"}, headers=headers).json()
    emp = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "totpemp@example.com", "name": "Без 2FA", "position_id": pos["id"], "temporary_password": "another long enough password"},
        headers=headers,
    ).json()
    # Свежеприглашённый — заведомо без 2FA.
    assert emp["totp_enabled"] is False

    emp_login = client.post("/api/auth/login", json={"email": "totpemp@example.com", "password": "another long enough password"}).json()
    emp_token = emp_login["access_token"]
    setup = client.post("/api/auth/2fa/setup", headers=auth_headers(emp_token)).json()
    code = pyotp.TOTP(setup["secret"]).now()
    client.post("/api/auth/2fa/confirm", json={"code": code}, headers=auth_headers(emp_token))

    refreshed = next(
        e for e in client.get(f"/api/businesses/{business_id}/employees", headers=headers).json() if e["id"] == emp["id"]
    )
    assert refreshed["totp_enabled"] is True


def test_employee_totp_enabled_hidden_from_teammates(client):
    headers, business_id = _setup(client, "emp67b-totphide@example.com")

    pos = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Стажёр"}, headers=headers).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{pos['id']}/permissions",
        json={"permissions": [{"resource": "employees", "level": "view"}]},
        headers=headers,
    )
    target = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "totptarget@example.com", "name": "Целевой", "position_id": pos["id"], "temporary_password": "another long enough password"},
        headers=headers,
    ).json()
    viewer_login = client.post(
        f"/api/businesses/{business_id}/employees",
        json={"email": "totpviewer@example.com", "name": "Смотрящий", "position_id": pos["id"], "temporary_password": "another long enough password"},
        headers=headers,
    ).json()
    viewer_token = client.post(
        "/api/auth/login", json={"email": "totpviewer@example.com", "password": "another long enough password"}
    ).json()["access_token"]

    seen = next(
        e for e in client.get(f"/api/businesses/{business_id}/employees", headers=auth_headers(viewer_token)).json()
        if e["id"] == target["id"]
    )
    assert seen["totp_enabled"] is None
    assert viewer_login  # просто чтобы не ругался линтер на неиспользуемую переменную


# --------------------------------------------------------------- resource_id фильтр --


def test_activity_filter_by_resource_id_scopes_to_one_position(client):
    headers, business_id = _setup(client, "emp67b-resid@example.com")

    pos_a = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Первая"}, headers=headers).json()
    pos_b = client.post(f"/api/businesses/{business_id}/positions", json={"title": "Вторая"}, headers=headers).json()

    client.patch(f"/api/businesses/{business_id}/positions/{pos_a['id']}", json={"color": "blue"}, headers=headers)
    client.patch(f"/api/businesses/{business_id}/positions/{pos_b['id']}", json={"color": "green"}, headers=headers)
    client.patch(f"/api/businesses/{business_id}/positions/{pos_a['id']}", json={"description": "Обновлено ещё раз"}, headers=headers)

    only_a = client.get(
        f"/api/businesses/{business_id}/employees/activity",
        params={"resource": "position", "resource_id": pos_a["id"]},
        headers=headers,
    ).json()["items"]
    # create + два update (цвет, потом описание) — все три пишутся с тем же resource_id.
    assert len(only_a) == 3
    assert all(e["resource_id"] == pos_a["id"] for e in only_a)
    assert {e["action"] for e in only_a} == {"create", "update"}

    only_b = client.get(
        f"/api/businesses/{business_id}/employees/activity",
        params={"resource": "position", "resource_id": pos_b["id"]},
        headers=headers,
    ).json()["items"]
    assert len(only_b) == 2  # create + один update (цвет)
    assert all(e["resource_id"] == pos_b["id"] for e in only_b)


# --------------------------------------------------------------- дублирование должности --


def test_duplicate_position_clones_everything(client):
    headers, business_id = _setup(client, "pos67b-dup@example.com")

    source = client.post(
        f"/api/businesses/{business_id}/positions",
        json={"title": "Менеджер смены", "color": "purple", "description": "Открытие и закрытие смены"},
        headers=headers,
    ).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{source['id']}/permissions",
        json={"permissions": [{"resource": "rentals", "level": "edit"}, {"resource": "finance", "level": "view"}]},
        headers=headers,
    )
    client.patch(f"/api/businesses/{business_id}/positions/{source['id']}/require-2fa", json={"require_2fa": True}, headers=headers)

    resp = client.post(f"/api/businesses/{business_id}/positions/{source['id']}/duplicate", headers=headers)
    assert resp.status_code == 201, resp.text
    dup = resp.json()
    assert dup["title"] == "Менеджер смены (копия)"
    assert dup["color"] == "purple"
    assert dup["description"] == "Открытие и закрытие смены"
    assert dup["require_2fa"] is True
    assert dup["employee_count"] == 0
    perms = {p["resource"]: p["level"] for p in dup["permissions"]}
    assert perms["rentals"] == "edit"
    assert perms["finance"] == "view"
    assert perms["clients"] == "none"

    # Повторное дублирование того же источника — не конфликтует по названию.
    resp2 = client.post(f"/api/businesses/{business_id}/positions/{source['id']}/duplicate", headers=headers).json()
    assert resp2["title"] == "Менеджер смены (копия 2)"

    positions = client.get(f"/api/businesses/{business_id}/positions", headers=headers).json()
    assert len(positions) == 3  # источник + 2 копии

    missing = client.post(
        f"/api/businesses/{business_id}/positions/00000000-0000-0000-0000-000000000000/duplicate", headers=headers
    )
    assert missing.status_code == 404
