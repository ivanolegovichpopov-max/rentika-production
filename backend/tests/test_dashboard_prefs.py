"""Личные настройки дашборда (скрытые блоки/переименованные подписи) —
GET/PUT /businesses/{business_id}/dashboard-prefs.

Проверяет: пустые настройки по умолчанию для нового бизнеса, что PUT
сохраняет и GET возвращает ровно то же самое (round-trip), что настройки
одного бизнеса не видны в другом (изоляция per-Employee), и что PUT можно
слать частично (например, только hidden, без labels — но т.к. схема
не partial-update, а полноценная замена, оба поля должны быть переданы
явно, как и делает фронтенд)."""
from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    return client.get("/api/businesses", headers=auth_headers(token)).json()[0]["id"]


def test_dashboard_prefs_default_empty(client):
    owner = register_business(client, email="dashprefs1@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    resp = client.get(f"/api/businesses/{business_id}/dashboard-prefs", headers=headers)
    assert resp.status_code == 200
    assert resp.json() == {"hidden": [], "labels": {}}


def test_dashboard_prefs_round_trip(client):
    owner = register_business(client, email="dashprefs2@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    payload = {
        "hidden": ["panel-topequip", "stat-damage30"],
        "labels": {"panel-due": "Мои возвраты", "stat-active": "Сейчас в работе"},
    }
    put_resp = client.put(f"/api/businesses/{business_id}/dashboard-prefs", json=payload, headers=headers)
    assert put_resp.status_code == 200
    assert put_resp.json() == payload

    get_resp = client.get(f"/api/businesses/{business_id}/dashboard-prefs", headers=headers)
    assert get_resp.status_code == 200
    assert get_resp.json() == payload

    # Второй PUT полностью заменяет настройки (не мёрджит) — фронтенд всегда
    # шлёт полный объект, поэтому "снятие" скрытия достигается отправкой
    # hidden без соответствующего id, а не отдельным DELETE-эндпоинтом.
    put_resp2 = client.put(
        f"/api/businesses/{business_id}/dashboard-prefs",
        json={"hidden": [], "labels": {}},
        headers=headers,
    )
    assert put_resp2.status_code == 200
    assert put_resp2.json() == {"hidden": [], "labels": {}}


def test_dashboard_prefs_isolated_per_business(client):
    """Один и тот же алгоритм проверки изоляции, что и в test_tenant_isolation —
    настройки дашборда бизнеса A не должны быть видны из бизнеса B, даже если
    оба принадлежат одному и тому же пользователю-владельцу с двумя разными
    регистрациями (иначе персональная настройка UI протекла бы между
    формально разными тенантами)."""
    owner_a = register_business(client, email="dashprefs3a@example.com", password="correct horse battery staple")
    owner_b = register_business(client, email="dashprefs3b@example.com", password="correct horse battery staple")
    headers_a = auth_headers(owner_a["access_token"])
    headers_b = auth_headers(owner_b["access_token"])
    business_a = _get_business_id(client, owner_a["access_token"])
    business_b = _get_business_id(client, owner_b["access_token"])

    client.put(
        f"/api/businesses/{business_a}/dashboard-prefs",
        json={"hidden": ["stat-active"], "labels": {}},
        headers=headers_a,
    )

    resp = client.get(f"/api/businesses/{business_b}/dashboard-prefs", headers=headers_b)
    assert resp.status_code == 200
    assert resp.json() == {"hidden": [], "labels": {}}

    # И бизнес A по-прежнему видит только своё, не задето вызовом для B.
    resp_a = client.get(f"/api/businesses/{business_a}/dashboard-prefs", headers=headers_a)
    assert resp_a.json() == {"hidden": ["stat-active"], "labels": {}}


def test_dashboard_prefs_rejects_oversized_labels(client):
    owner = register_business(client, email="dashprefs4@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    too_many_labels = {f"id-{i}": "x" for i in range(65)}
    resp = client.put(
        f"/api/businesses/{business_id}/dashboard-prefs",
        json={"hidden": [], "labels": too_many_labels},
        headers=headers,
    )
    assert resp.status_code == 422
