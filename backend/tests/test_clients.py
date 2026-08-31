"""
Вкладка «Клиенты» — 24-й проход, доработки по итогам обзора: удаление
клиента с историей аренд (баг: раньше падало необработанным IntegrityError
на клиенте с ЗАКРЫТОЙ историей), массовый CSV-импорт и слияние дублей
(merge). Сквозные сценарии через реальные HTTP-эндпоинты, тот же стиль, что
и test_rentals_flow.py.
"""
from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    return client.get("/api/businesses", headers=auth_headers(token)).json()[0]["id"]


def _rent_and_return(client, business_id, headers, client_id, name="Тестовая техника"):
    """Полный цикл аренда → выдача → возврат, чтобы получить клиента с
    ЗАКРЫТОЙ (не открытой) историей аренд — именно этот случай раньше падал
    на удалении."""
    eq = client.post(
        f"/api/businesses/{business_id}/equipment",
        json={"name": name, "category": "Инструмент", "daily_rate": 100, "deposit": 500},
        headers=headers,
    ).json()
    rental = client.post(
        f"/api/businesses/{business_id}/rentals",
        json={
            "client_id": client_id,
            "equipment_ids": [eq["id"]],
            "start_date": "2026-09-01",
            "end_date": "2026-09-02",
        },
        headers=headers,
    ).json()
    client.post(f"/api/businesses/{business_id}/rentals/{rental['id']}/issue", headers=headers)
    ret = client.post(
        f"/api/businesses/{business_id}/rentals/{rental['id']}/return",
        json={"actual_return": "2026-09-02", "damage_fee": 0},
        headers=headers,
    )
    assert ret.status_code == 200
    return rental["id"]


def test_delete_client_with_closed_rental_history_is_rejected_cleanly(client):
    """Регрессия на баг, найденный при обзоре: клиент с ЗАКРЫТОЙ (returned)
    историей аренд раньше проходил проверку на "открытую аренду" и падал на
    ограничении внешнего ключа необработанным исключением. Теперь должен
    отклоняться понятным 400, а не 500."""
    owner = register_business(client, email="clients-delete@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Клиент с историей"}, headers=headers
    ).json()["id"]

    _rent_and_return(client, business_id, headers, client_id)

    resp = client.delete(f"/api/businesses/{business_id}/clients/{client_id}", headers=headers)
    assert resp.status_code == 400
    assert "историю аренд" in resp.json()["detail"] or "историей аренд" in resp.json()["detail"]

    # Клиент по-прежнему на месте — удаление действительно не произошло.
    still_there = client.get(f"/api/businesses/{business_id}/clients", headers=headers).json()
    assert any(c["id"] == client_id for c in still_there)


def test_delete_client_without_any_rental_still_works(client):
    owner = register_business(client, email="clients-delete2@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Клиент без аренд"}, headers=headers
    ).json()["id"]

    resp = client.delete(f"/api/businesses/{business_id}/clients/{client_id}", headers=headers)
    assert resp.status_code == 204

    remaining = client.get(f"/api/businesses/{business_id}/clients", headers=headers).json()
    assert not any(c["id"] == client_id for c in remaining)


def test_merge_client_moves_rental_history_and_deletes_source(client):
    owner = register_business(client, email="clients-merge@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    source_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Иванов Иван (дубль)"}, headers=headers
    ).json()["id"]
    target_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Иванов Иван"}, headers=headers
    ).json()["id"]

    rental_id = _rent_and_return(client, business_id, headers, source_id, name="Техника для слияния")

    merge_resp = client.post(
        f"/api/businesses/{business_id}/clients/{source_id}/merge",
        json={"into_client_id": target_id},
        headers=headers,
    )
    assert merge_resp.status_code == 200
    assert merge_resp.json()["id"] == target_id

    # Источник удалён.
    remaining = client.get(f"/api/businesses/{business_id}/clients", headers=headers).json()
    assert not any(c["id"] == source_id for c in remaining)
    assert any(c["id"] == target_id for c in remaining)

    # История аренды переехала на цель.
    rentals = client.get(f"/api/businesses/{business_id}/rentals", headers=headers).json()
    moved = next(r for r in rentals if r["id"] == rental_id)
    assert moved["client_id"] == target_id

    # После слияния цель (уже с историей) по-прежнему нельзя удалить — тот же
    # инвариант "нельзя терять финансовую историю", что и до слияния.
    delete_target = client.delete(f"/api/businesses/{business_id}/clients/{target_id}", headers=headers)
    assert delete_target.status_code == 400


def test_merge_client_rejects_self_and_unknown_target(client):
    owner = register_business(client, email="clients-merge2@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Одиночка"}, headers=headers
    ).json()["id"]

    self_merge = client.post(
        f"/api/businesses/{business_id}/clients/{client_id}/merge",
        json={"into_client_id": client_id},
        headers=headers,
    )
    assert self_merge.status_code == 400

    unknown_merge = client.post(
        f"/api/businesses/{business_id}/clients/{client_id}/merge",
        json={"into_client_id": "00000000-0000-0000-0000-000000000000"},
        headers=headers,
    )
    assert unknown_merge.status_code == 400


def test_import_clients_csv_reports_per_row_and_duplicate_warning(client):
    owner = register_business(client, email="clients-import@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    # Уже существующий клиент с телефоном — для проверки duplicate_warning.
    client.post(
        f"/api/businesses/{business_id}/clients",
        json={"name": "Существующий клиент", "phone": "+7 900 111-22-33"},
        headers=headers,
    )

    csv_text = (
        "name,phone,email,doc,rating,notes\n"
        "Новый клиент,+7 900 111-22-33,,,,\n"  # дубль по телефону — создастся, но с предупреждением
        "На контроле,,watch2@example.com,,На контроле,\n"  # рейтинг русской подписью
        "Чёрный список,,black@example.com,,blacklist,плохой опыт\n"
        ",,noname@example.com,,,\n"  # пустое имя — строка с ошибкой
        "Плохой рейтинг,,bad@example.com,,unknown_value,\n"  # невалидный рейтинг — строка с ошибкой
    )
    files = {"file": ("clients.csv", csv_text.encode("utf-8"), "text/csv")}
    resp = client.post(f"/api/businesses/{business_id}/clients/import", files=files, headers=headers)
    assert resp.status_code == 200
    result = resp.json()
    assert result["total"] == 5
    assert result["created"] == 3
    assert result["failed"] == 2

    by_name = {r["name"]: r for r in result["results"]}
    assert by_name["Новый клиент"]["ok"] is True
    assert by_name["Новый клиент"]["duplicate_warning"] is True
    assert by_name["На контроле"]["client"]["rating"] == "watch"
    assert by_name["Чёрный список"]["client"]["rating"] == "blacklist"
    assert by_name["Плохой рейтинг"]["ok"] is False

    all_clients = client.get(f"/api/businesses/{business_id}/clients", headers=headers).json()
    assert len(all_clients) == 1 + 3  # существующий + 3 успешно импортированных


def test_import_clients_csv_requires_name_column(client):
    owner = register_business(client, email="clients-import2@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    csv_text = "phone,email\n+7 900 000-00-00,x@example.com\n"
    files = {"file": ("clients.csv", csv_text.encode("utf-8"), "text/csv")}
    resp = client.post(f"/api/businesses/{business_id}/clients/import", files=files, headers=headers)
    assert resp.status_code == 400
