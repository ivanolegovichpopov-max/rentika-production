"""
Вкладка «Клиенты» — 24-й проход, доработки по итогам обзора: удаление
клиента с историей аренд (баг: раньше падало необработанным IntegrityError
на клиенте с ЗАКРЫТОЙ историей), массовый CSV-импорт и слияние дублей
(merge). Сквозные сценарии через реальные HTTP-эндпоинты, тот же стиль, что
и test_rentals_flow.py.
"""
from datetime import datetime, timedelta, timezone

from app.models.inventory import Client, ClientNote
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


def test_delete_client_with_closed_rental_history_moves_to_trash(client):
    """29-й проход: удаление клиента теперь мягкое (корзина, см.
    app/services/trash.py) — клиент с ЗАКРЫТОЙ (returned) историей аренд
    больше не блокируется наглухо (как было раньше, регрессия 24-го
    прохода — падал на ограничении внешнего ключа), а прячется из обычного
    списка и появляется в корзине, восстановим."""
    owner = register_business(client, email="clients-delete@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Клиент с историей"}, headers=headers
    ).json()["id"]

    _rent_and_return(client, business_id, headers, client_id)

    resp = client.delete(f"/api/businesses/{business_id}/clients/{client_id}", headers=headers)
    assert resp.status_code == 204

    # Пропал из обычного списка...
    active = client.get(f"/api/businesses/{business_id}/clients", headers=headers).json()
    assert not any(c["id"] == client_id for c in active)

    # ...но виден в корзине и восстановим.
    trash = client.get(f"/api/businesses/{business_id}/clients/trash", headers=headers).json()
    assert any(c["id"] == client_id for c in trash)

    restore = client.post(f"/api/businesses/{business_id}/clients/{client_id}/restore", headers=headers)
    assert restore.status_code == 200
    active_again = client.get(f"/api/businesses/{business_id}/clients", headers=headers).json()
    assert any(c["id"] == client_id for c in active_again)


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

    # После слияния цель (уже с историей) можно "удалить" — мягко, в корзину
    # (29-й проход): финансовая история никуда не денется физически (см.
    # app/services/trash.py), просто перестанет быть видна в обычном списке.
    delete_target = client.delete(f"/api/businesses/{business_id}/clients/{target_id}", headers=headers)
    assert delete_target.status_code == 204
    trash = client.get(f"/api/businesses/{business_id}/clients/trash", headers=headers).json()
    assert any(c["id"] == target_id for c in trash)


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


def test_client_note_delete_own_recent_only(client, db_session):
    """37-й проход — журнал больше не полностью неприкосновенен: автор может
    удалить СВОЮ запись в течение CLIENT_NOTE_DELETE_WINDOW_MINUTES после
    добавления (опечатался/добавил не то), но не задним числом; чужую запись
    не может удалить никто, кроме владельца бизнеса (модерация без
    ограничения по времени). Тот же расклад прав, что и у DashboardNote
    (test_notes.py:test_everyone_mode_allows_employee_posting_and_self_delete),
    плюс сама проверка окна по времени."""
    owner = register_business(client, email="clients-notes-delete@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Клиент для теста удаления"}, headers=headers
    ).json()["id"]

    # Сотрудник с правом "edit" на клиентов — только тогда вообще может
    # создавать записи в журнале (create_client_note требует edit_dep).
    position = client.post(
        f"/api/businesses/{business_id}/positions", json={"title": "Менеджер"}, headers=headers
    ).json()
    client.put(
        f"/api/businesses/{business_id}/positions/{position['id']}/permissions",
        json={"permissions": [{"resource": "clients", "level": "edit"}]},
        headers=headers,
    )
    client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "note-author@example.com",
            "name": "Автор Записи",
            "position_id": position["id"],
            "temporary_password": "another long enough password",
        },
        headers=headers,
    )
    client.post(
        f"/api/businesses/{business_id}/employees",
        json={
            "email": "note-other@example.com",
            "name": "Другой Сотрудник",
            "position_id": position["id"],
            "temporary_password": "another long enough password",
        },
        headers=headers,
    )
    author_token = client.post("/api/auth/login", json={"email": "note-author@example.com", "password": "another long enough password"}).json()["access_token"]
    other_token = client.post("/api/auth/login", json={"email": "note-other@example.com", "password": "another long enough password"}).json()["access_token"]
    author_headers = auth_headers(author_token)
    other_headers = auth_headers(other_token)

    created = client.post(
        f"/api/businesses/{business_id}/clients/{client_id}/notes", json={"text": "Свежая запись"}, headers=author_headers
    )
    assert created.status_code == 201
    note_id = created.json()["id"]
    assert created.json()["can_delete"] is True  # только что созданная своя запись — в окне

    # Другой сотрудник ту же запись не видит удаляемой и не может удалить.
    listed_by_other = client.get(f"/api/businesses/{business_id}/clients/{client_id}/notes", headers=other_headers).json()
    assert listed_by_other[0]["can_delete"] is False
    forbidden = client.delete(f"/api/businesses/{business_id}/clients/{client_id}/notes/{note_id}", headers=other_headers)
    assert forbidden.status_code == 403

    # "Перематываем" created_at за пределы окна — тест не может физически
    # ждать CLIENT_NOTE_DELETE_WINDOW_MINUTES (тот же приём, что и в
    # test_trash.py с deleted_at).
    old_ts = datetime.now(timezone.utc) - timedelta(minutes=30)
    db_session.query(ClientNote).filter(ClientNote.id == note_id).update({"created_at": old_ts}, synchronize_session=False)
    db_session.commit()

    expired = client.get(f"/api/businesses/{business_id}/clients/{client_id}/notes", headers=author_headers).json()
    assert expired[0]["can_delete"] is False  # своя, но окно уже прошло
    too_late = client.delete(f"/api/businesses/{business_id}/clients/{client_id}/notes/{note_id}", headers=author_headers)
    assert too_late.status_code == 403

    # Владелец бизнеса удаляет ЛЮБУЮ запись в любой момент — модерация без
    # ограничения по времени/авторству.
    owner_delete = client.delete(f"/api/businesses/{business_id}/clients/{client_id}/notes/{note_id}", headers=headers)
    assert owner_delete.status_code == 204

    empty = client.get(f"/api/businesses/{business_id}/clients/{client_id}/notes", headers=headers).json()
    assert empty == []

    # Второй сценарий: свежая запись, удаляемая самим автором в пределах окна.
    fresh = client.post(
        f"/api/businesses/{business_id}/clients/{client_id}/notes", json={"text": "Ещё одна"}, headers=author_headers
    ).json()
    own_delete = client.delete(
        f"/api/businesses/{business_id}/clients/{client_id}/notes/{fresh['id']}", headers=author_headers
    )
    assert own_delete.status_code == 204


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
            # contact_person/inn — 29-й проход, теперь обязательны для
            # client_type=company (см. _require_company_fields в
            # app/api/routes/clients.py).
            "contact_person": "Иванов Иван",
            "inn": "7701234567",
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


def test_list_clients_survives_legacy_invalid_contact_phone(client, db_session):
    """Регресс-тест на прод-инцидент 29-го прохода: строгий валидатор
    телефона в ClientContact (см. _validate_phone_format в schemas/
    inventory.py) появился ПОСЛЕ того, как некоторые клиенты уже сохранили
    доп. контакты (26-й проход) без него — в БД у части бизнесов реально
    лежали значения вроде "+7 12" (2 цифры). Раньше ClientOut переиспользовал
    ту же схему ClientContact (с валидатором) для ОТДАЧИ данных — FastAPI
    валидирует response_model при сериализации, и старое "плохое" значение
    роняло ResponseValidationError → 500 на ВЕСЬ список клиентов бизнеса
    (не только на одного клиента с плохими данными). Симулируем именно это:
    пишем невалидный (по новым правилам) телефон в БД в обход API-валидации
    напрямую через ORM, как если бы запись была сделана до появления
    валидатора — и проверяем, что список клиентов всё равно отдаётся."""
    owner = register_business(client, email="clients-legacy-phone@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    created = client.post(
        f"/api/businesses/{business_id}/clients",
        json={"name": "ООО Легаси", "client_type": "company", "contact_person": "Иванов", "inn": "7701234567"},
        headers=headers,
    ).json()

    # В обход валидатора схемы — напрямую через ORM, как "старые" данные.
    row = db_session.get(Client, created["id"])
    row.additional_contacts = [{"name": "Старый контакт", "role": None, "phone": "+7 12"}]
    db_session.commit()

    listed = client.get(f"/api/businesses/{business_id}/clients", headers=headers)
    assert listed.status_code == 200
    found = next(c for c in listed.json() if c["id"] == created["id"])
    assert found["additional_contacts"][0]["phone"] == "+7 12"


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


def test_client_document_label_upload_and_patch(client):
    """29-й проход, повторный обзор, п.12: у документа клиента есть короткая
    подпись (label) — можно задать при загрузке и изменить позже, чтобы
    несколько файлов не приходилось различать только по имени с телефона."""
    owner = register_business(client, email="clients-docs-label@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    client_id = client.post(
        f"/api/businesses/{business_id}/clients", json={"name": "Клиент с подписанными документами"}, headers=headers
    ).json()["id"]

    # Загрузка без подписи — label остаётся null (обратная совместимость со старыми файлами).
    no_label_files = {"file": ("scan1.jpg", b"\xff\xd8\xff\xe0fake-jpeg-bytes-1", "image/jpeg")}
    no_label_doc = client.post(
        f"/api/businesses/{business_id}/clients/{client_id}/documents", files=no_label_files, headers=headers
    ).json()
    assert no_label_doc["label"] is None

    # Загрузка с подписью.
    files = {"file": ("IMG_20260901_112233.jpg", b"\xff\xd8\xff\xe0fake-jpeg-bytes-2", "image/jpeg")}
    uploaded = client.post(
        f"/api/businesses/{business_id}/clients/{client_id}/documents",
        files=files,
        data={"label": "Разворот паспорта"},
        headers=headers,
    )
    assert uploaded.status_code == 201
    doc = uploaded.json()
    assert doc["label"] == "Разворот паспорта"

    listed = client.get(f"/api/businesses/{business_id}/clients/{client_id}/documents", headers=headers).json()
    by_id = {d["id"]: d for d in listed}
    assert by_id[doc["id"]]["label"] == "Разворот паспорта"
    assert by_id[no_label_doc["id"]]["label"] is None

    # Изменение подписи задним числом (в т.ч. у файла, загруженного без неё).
    patched = client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}/documents/{no_label_doc['id']}",
        json={"label": "Прописка"},
        headers=headers,
    )
    assert patched.status_code == 200
    assert patched.json()["label"] == "Прописка"

    # Пустая строка/пробелы очищают подпись (трактуется как "без подписи").
    cleared = client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}/documents/{doc['id']}",
        json={"label": "   "},
        headers=headers,
    )
    assert cleared.status_code == 200
    assert cleared.json()["label"] is None

    # Неизвестный документ — 404.
    missing = client.patch(
        f"/api/businesses/{business_id}/clients/{client_id}/documents/00000000-0000-0000-0000-000000000000",
        json={"label": "Что угодно"},
        headers=headers,
    )
    assert missing.status_code == 404


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
