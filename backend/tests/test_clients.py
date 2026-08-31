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


def test_import_clients_csv_tags_column(client):
    """25-й проход, п.8: tags — единственное новое поле 25-го прохода,
    добавленное в CSV-импорт (реквизиты организации/скидка — сознательно
    нет, см. docstring import_clients)."""
    owner = register_business(client, email="clients-import-tags@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    csv_text = 'name,tags\nОптовик,"постоянный,оптовик"\n'
    files = {"file": ("clients.csv", csv_text.encode("utf-8"), "text/csv")}
    resp = client.post(f"/api/businesses/{business_id}/clients/import", files=files, headers=headers)
    assert resp.status_code == 200
    result = resp.json()
    assert result["created"] == 1
    assert result["results"][0]["client"]["tags"] == "постоянный,оптовик"


def test_create_client_with_org_fields_and_tags(client):
    """25-й проход, п.2/8: client_type=company + реквизиты, plus tags."""
    owner = register_business(client, email="clients-org@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/clients",
        json={
            "name": "ООО Ромашка",
            "client_type": "company",
            "contact_person": "Петров Пётр",
            "inn": "7701234567",
            "default_discount_percent": 10,
            "tags": "постоянный,оптовик",
        },
        headers=headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["client_type"] == "company"
    assert body["contact_person"] == "Петров Пётр"
    assert body["inn"] == "7701234567"
    assert body["default_discount_percent"] == 10
    assert body["tags"] == "постоянный,оптовик"

    # По умолчанию — физлицо, без реквизитов.
    default_resp = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Иванов Иван"}, headers=headers
    )
    assert default_resp.json()["client_type"] == "individual"
    assert default_resp.json()["default_discount_percent"] is None


def test_set_and_clear_blacklist_reason(client):
    """25-й проход, п.5: причина чёрного списка — задаётся и очищается через
    обычный PATCH (см. ClientUpdate), эндпоинт не проверяет, что рейтинг
    и причина меняются вместе — это ответственность фронта."""
    owner = register_business(client, email="clients-blacklist@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Проблемный клиент"}, headers=headers
    ).json()["id"]

    resp = client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}",
        json={"rating": "blacklist", "blacklist_reason": "Не вернул технику вовремя дважды"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["rating"] == "blacklist"
    assert resp.json()["blacklist_reason"] == "Не вернул технику вовремя дважды"

    cleared = client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}",
        json={"rating": "normal", "blacklist_reason": None},
        headers=headers,
    )
    assert cleared.json()["rating"] == "normal"
    assert cleared.json()["blacklist_reason"] is None


def test_client_notes_journal_crud(client):
    """25-й проход, п.4: журнал заметок — append-only лента, отдельная от
    Client.notes, с автором и порядком от новых к старым."""
    owner = register_business(client, email="clients-notes@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Клиент с журналом"}, headers=headers
    ).json()["id"]

    empty = client.get(f"/api/businesses/{business_id}/clients/{client_id}/notes", headers=headers)
    assert empty.status_code == 200
    assert empty.json() == []

    first = client.post(
        f"/api/businesses/{business_id}/clients/{client_id}/notes", json={"text": "Звонил, спрашивал про виброплиту"}, headers=headers
    )
    assert first.status_code == 201
    assert first.json()["text"] == "Звонил, спрашивал про виброплиту"
    assert first.json()["employee_name"] is not None  # владелец бизнеса — тоже сотрудник (см. deps.py)

    second = client.post(
        f"/api/businesses/{business_id}/clients/{client_id}/notes", json={"text": "Приходил, забрал перфоратор"}, headers=headers
    )
    assert second.status_code == 201

    listed = client.get(f"/api/businesses/{business_id}/clients/{client_id}/notes", headers=headers).json()
    assert len(listed) == 2
    # От новых к старым.
    assert listed[0]["text"] == "Приходил, забрал перфоратор"
    assert listed[1]["text"] == "Звонил, спрашивал про виброплиту"


def test_create_and_update_client_birthday_and_contacts(client):
    """26-й проход: день рождения + доп. контакты организации (JSON-список,
    целиком перезаписывается при сохранении формы)."""
    owner = register_business(client, email="clients-extras@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/clients",
        json={
            "name": "ООО Ромашка",
            "client_type": "company",
            "birthday": "1990-05-14",
            "additional_contacts": [
                {"name": "Петров Пётр", "role": "Снабжение", "phone": "+7 900 000-00-01"},
                {"name": "Сидорова Анна", "role": "Бухгалтерия", "phone": None},
            ],
        },
        headers=headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["birthday"] == "1990-05-14"
    assert len(body["additional_contacts"]) == 2
    assert body["additional_contacts"][0]["name"] == "Петров Пётр"
    assert body["additional_contacts"][0]["role"] == "Снабжение"
    assert body["additional_contacts"][1]["phone"] is None

    client_id = body["id"]
    # Перезапись списка контактов — старый список целиком заменяется новым,
    # не сливается по элементам (тот же принцип, что и у tags).
    updated = client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}",
        json={"additional_contacts": [{"name": "Новый контакт", "role": None, "phone": None}]},
        headers=headers,
    )
    assert updated.status_code == 200
    assert len(updated.json()["additional_contacts"]) == 1
    assert updated.json()["additional_contacts"][0]["name"] == "Новый контакт"

    # Клиент без этих полей — birthday/additional_contacts спокойно None.
    plain = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Иванов Иван"}, headers=headers
    ).json()
    assert plain["birthday"] is None
    assert plain["additional_contacts"] is None


def test_client_documents_upload_list_delete(client):
    """26-й проход: прикреплённые сканы/фото документов клиента —
    загрузка/список/удаление, с проверкой лимита размера файла."""
    owner = register_business(client, email="clients-docs@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Клиент с документами"}, headers=headers
    ).json()["id"]

    empty = client.get(f"/api/businesses/{business_id}/clients/{client_id}/documents", headers=headers)
    assert empty.status_code == 200
    assert empty.json() == []

    files = {"file": ("passport.jpg", b"\xff\xd8\xff\xe0fake-jpeg-bytes", "image/jpeg")}
    uploaded = client.post(
        f"/api/businesses/{business_id}/clients/{client_id}/documents", files=files, headers=headers
    )
    assert uploaded.status_code == 201
    doc = uploaded.json()
    assert doc["filename"] == "passport.jpg"
    assert doc["content_type"] == "image/jpeg"
    assert doc["size_bytes"] == len(b"\xff\xd8\xff\xe0fake-jpeg-bytes")
    assert doc["employee_name"] is not None
    import base64 as _b64

    assert _b64.b64decode(doc["data_base64"]) == b"\xff\xd8\xff\xe0fake-jpeg-bytes"

    listed = client.get(f"/api/businesses/{business_id}/clients/{client_id}/documents", headers=headers).json()
    assert len(listed) == 1

    # Пустой файл отклоняется.
    empty_file = {"file": ("empty.jpg", b"", "image/jpeg")}
    rejected = client.post(
        f"/api/businesses/{business_id}/clients/{client_id}/documents", files=empty_file, headers=headers
    )
    assert rejected.status_code == 400

    # Слишком большой файл (> 5 МБ) отклоняется.
    too_big = {"file": ("big.jpg", b"x" * (5 * 1024 * 1024 + 1), "image/jpeg")}
    rejected_big = client.post(
        f"/api/businesses/{business_id}/clients/{client_id}/documents", files=too_big, headers=headers
    )
    assert rejected_big.status_code == 400
    assert len(client.get(f"/api/businesses/{business_id}/clients/{client_id}/documents", headers=headers).json()) == 1

    delete_resp = client.delete(
        f"/api/businesses/{business_id}/clients/{client_id}/documents/{doc['id']}", headers=headers
    )
    assert delete_resp.status_code == 204
    assert client.get(f"/api/businesses/{business_id}/clients/{client_id}/documents", headers=headers).json() == []


def test_client_notes_reject_unknown_client(client):
    owner = register_business(client, email="clients-notes2@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/clients/00000000-0000-0000-0000-000000000000/notes",
        json={"text": "Заметка"},
        headers=headers,
    )
    assert resp.status_code == 404
