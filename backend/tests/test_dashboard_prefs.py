"""Личные настройки дашборда (скрытые блоки/раскладка) —
GET/PUT /businesses/{business_id}/dashboard-prefs.

Проверяет: пустые настройки по умолчанию для нового бизнеса, что PUT
сохраняет и GET возвращает ровно то же самое (round-trip: скрытые id,
порядок стат-плашек, построчную раскладку панелей), что настройки одного
бизнеса не видны в другом (изоляция per-Employee), и лимиты на размер
raskладки (защита от отправки произвольно большого JSON)."""
from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    return client.get("/api/businesses", headers=auth_headers(token)).json()[0]["id"]


def test_dashboard_prefs_default_empty(client):
    owner = register_business(client, email="dashprefs1@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    resp = client.get(f"/api/businesses/{business_id}/dashboard-prefs", headers=headers)
    assert resp.status_code == 200
    assert resp.json() == {"hidden": [], "stat_order": [], "panel_rows": []}


def test_dashboard_prefs_round_trip(client):
    owner = register_business(client, email="dashprefs2@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    payload = {
        "hidden": ["panel-topequip", "stat-damage30"],
        "stat_order": ["stat-free", "stat-active", "stat-overdue", "stat-revenue30", "stat-deposits", "stat-damage30"],
        "panel_rows": [["panel-notes"], ["panel-due", "panel-categories"], ["panel-risky"]],
    }
    put_resp = client.put(f"/api/businesses/{business_id}/dashboard-prefs", json=payload, headers=headers)
    assert put_resp.status_code == 200
    assert put_resp.json() == payload

    get_resp = client.get(f"/api/businesses/{business_id}/dashboard-prefs", headers=headers)
    assert get_resp.status_code == 200
    assert get_resp.json() == payload

    # Второй PUT полностью заменяет настройки (не мёрджит) — фронтенд всегда
    # шлёт полный объект.
    put_resp2 = client.put(
        f"/api/businesses/{business_id}/dashboard-prefs",
        json={"hidden": [], "stat_order": [], "panel_rows": []},
        headers=headers,
    )
    assert put_resp2.status_code == 200
    assert put_resp2.json() == {"hidden": [], "stat_order": [], "panel_rows": []}


def test_dashboard_prefs_isolated_per_business(client):
    """Настройки дашборда бизнеса A не должны быть видны из бизнеса B, даже
    если оба принадлежат одному и тому же пользователю-владельцу с двумя
    разными регистрациями (та же логика, что и test_tenant_isolation)."""
    owner_a = register_business(client, email="dashprefs3a@example.com", password="correct horse battery staple")
    owner_b = register_business(client, email="dashprefs3b@example.com", password="correct horse battery staple")
    headers_a = auth_headers(owner_a["access_token"])
    headers_b = auth_headers(owner_b["access_token"])
    business_a = _get_business_id(client, owner_a["access_token"])
    business_b = _get_business_id(client, owner_b["access_token"])

    client.put(
        f"/api/businesses/{business_a}/dashboard-prefs",
        json={"hidden": ["stat-active"], "stat_order": [], "panel_rows": []},
        headers=headers_a,
    )

    resp = client.get(f"/api/businesses/{business_b}/dashboard-prefs", headers=headers_b)
    assert resp.status_code == 200
    assert resp.json() == {"hidden": [], "stat_order": [], "panel_rows": []}

    resp_a = client.get(f"/api/businesses/{business_a}/dashboard-prefs", headers=headers_a)
    assert resp_a.json()["hidden"] == ["stat-active"]


def test_dashboard_prefs_rejects_oversized_panel_row(client):
    owner = register_business(client, email="dashprefs4@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    resp = client.put(
        f"/api/businesses/{business_id}/dashboard-prefs",
        json={"hidden": [], "stat_order": [], "panel_rows": [["a", "b", "c"]]},
        headers=headers,
    )
    assert resp.status_code == 422


def test_dashboard_prefs_rejects_too_many_panel_rows(client):
    owner = register_business(client, email="dashprefs5@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    resp = client.put(
        f"/api/businesses/{business_id}/dashboard-prefs",
        json={"hidden": [], "stat_order": [], "panel_rows": [["p" + str(i)] for i in range(65)]},
        headers=headers,
    )
    assert resp.status_code == 422


def test_dashboard_prefs_ignores_legacy_labels_field(client):
    """Данные, сохранённые ДО отказа от переименования (старый формат с полем
    "labels"), не должны приводить к ошибке при чтении — pydantic по
    умолчанию игнорирует лишние поля. Симулируем это, кладя старый JSON
    напрямую в БД в обход API."""
    from app.database import Base, get_db
    from app.main import app
    from app.models.business import Employee

    owner = register_business(client, email="dashprefs6@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    db_gen = app.dependency_overrides[get_db]()
    db = next(db_gen)
    employee = db.query(Employee).filter(Employee.business_id == business_id).one()
    employee.dashboard_prefs = '{"hidden": ["stat-active"], "labels": {"stat-active": "Старое имя"}}'
    db.commit()

    resp = client.get(f"/api/businesses/{business_id}/dashboard-prefs", headers=headers)
    assert resp.status_code == 200
    assert resp.json() == {"hidden": ["stat-active"], "stat_order": [], "panel_rows": []}
