"""Личные сообщения — GET/POST /businesses/{business_id}/conversations,
GET/POST .../conversations/{id}/messages, PUT .../messaging-mode,
GET .../messaging-directory.

Ключевые сценарии из ТЗ пользователя:
- owner_only (default): обычный сотрудник может открыть диалог только с
  владельцем, группы создавать не может; владелец может писать всем и
  создавать группы.
- everyone: любой активный сотрудник может написать любому другому и
  создавать группы.
- Приватность: даже владелец бизнеса (full_access) не может читать диалог,
  в котором сам не состоит участником — это НЕ то же самое, что остальные
  ресурсы бизнеса (клиенты/аренды/заметки), которые владелец видит целиком.
- DM не дублируются: повторный запрос на тот же dm-диалог возвращает
  существующий (200), а не создаёт новый.
- Изоляция по бизнесу (tenant isolation).
"""
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


def _employee_id(client, business_id, token, name):
    resp = client.get(f"/api/businesses/{business_id}/employees", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    for e in resp.json():
        if e["name"] == name:
            return e["id"]
    raise AssertionError(f"employee '{name}' not found among {resp.json()}")


def test_business_defaults_to_owner_only_messaging_mode(client):
    owner = register_business(client, email="msg1@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    resp = client.get(f"/api/businesses/{business_id}", headers=auth_headers(owner["access_token"]))
    assert resp.status_code == 200
    assert resp.json()["messaging_permission"] == "owner_only"


def test_owner_only_mode_blocks_employee_to_employee_dm_and_group(client):
    owner = register_business(client, email="msg2@example.com", password="correct horse battery staple", business_name="Влад")
    business_id = _get_business_id(client, owner["access_token"])
    alice_token = _invite(client, business_id, owner["access_token"], "alice2@example.com", name="Алиса")
    bob_token = _invite(client, business_id, owner["access_token"], "bob2@example.com", name="Боб")
    bob_id = _employee_id(client, business_id, owner["access_token"], "Боб")
    owner_id = _employee_id(client, business_id, owner["access_token"], "Влад")

    # Алиса не может написать Бобу напрямую.
    resp = client.post(
        f"/api/businesses/{business_id}/conversations",
        json={"type": "dm", "participant_ids": [bob_id]},
        headers=auth_headers(alice_token),
    )
    assert resp.status_code == 403

    # Алиса не может создать группу вообще (даже с владельцем внутри).
    group_resp = client.post(
        f"/api/businesses/{business_id}/conversations",
        json={"type": "group", "participant_ids": [bob_id, owner_id], "name": "Общий чат"},
        headers=auth_headers(alice_token),
    )
    assert group_resp.status_code == 403

    # Но Алиса может написать владельцу.
    dm_resp = client.post(
        f"/api/businesses/{business_id}/conversations",
        json={"type": "dm", "participant_ids": [owner_id]},
        headers=auth_headers(alice_token),
    )
    assert dm_resp.status_code == 200
    assert dm_resp.json()["display_name"] == "Влад"

    # Владелец может создать группу и написать любому.
    owner_group = client.post(
        f"/api/businesses/{business_id}/conversations",
        json={"type": "group", "participant_ids": [bob_id, _employee_id(client, business_id, owner["access_token"], "Алиса")], "name": "Команда"},
        headers=auth_headers(owner["access_token"]),
    )
    assert owner_group.status_code == 200
    assert owner_group.json()["type"] == "group"
    assert owner_group.json()["participant_count"] == 3


def test_everyone_mode_allows_employee_to_employee_dm_and_group(client):
    owner = register_business(client, email="msg3@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    alice_token = _invite(client, business_id, owner["access_token"], "alice3@example.com", name="Алиса")
    bob_token = _invite(client, business_id, owner["access_token"], "bob3@example.com", name="Боб")
    bob_id = _employee_id(client, business_id, owner["access_token"], "Боб")

    mode_resp = client.put(
        f"/api/businesses/{business_id}/messaging-mode",
        json={"mode": "everyone"},
        headers=auth_headers(owner["access_token"]),
    )
    assert mode_resp.status_code == 200
    assert mode_resp.json() == {"mode": "everyone"}

    dm_resp = client.post(
        f"/api/businesses/{business_id}/conversations",
        json={"type": "dm", "participant_ids": [bob_id]},
        headers=auth_headers(alice_token),
    )
    assert dm_resp.status_code == 200
    assert dm_resp.json()["display_name"] == "Боб"

    group_resp = client.post(
        f"/api/businesses/{business_id}/conversations",
        json={"type": "group", "participant_ids": [bob_id], "name": "Курилка"},
        headers=auth_headers(alice_token),
    )
    assert group_resp.status_code == 200


def test_dm_creation_is_deduplicated(client):
    owner = register_business(client, email="msg4@example.com", password="correct horse battery staple", business_name="Владелец")
    business_id = _get_business_id(client, owner["access_token"])
    alice_token = _invite(client, business_id, owner["access_token"], "alice4@example.com", name="Алиса")
    owner_id = _employee_id(client, business_id, owner["access_token"], "Владелец")

    first = client.post(
        f"/api/businesses/{business_id}/conversations",
        json={"type": "dm", "participant_ids": [owner_id]},
        headers=auth_headers(alice_token),
    )
    assert first.status_code == 200
    second = client.post(
        f"/api/businesses/{business_id}/conversations",
        json={"type": "dm", "participant_ids": [owner_id]},
        headers=auth_headers(alice_token),
    )
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]


def test_group_requires_name(client):
    owner = register_business(client, email="msg5@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    bob_token = _invite(client, business_id, owner["access_token"], "bob5@example.com", name="Боб")
    bob_id = _employee_id(client, business_id, owner["access_token"], "Боб")

    resp = client.post(
        f"/api/businesses/{business_id}/conversations",
        json={"type": "group", "participant_ids": [bob_id]},
        headers=auth_headers(owner["access_token"]),
    )
    assert resp.status_code == 422


def test_owner_cannot_read_conversation_they_are_not_participant_of(client):
    """Ключевое архитектурное решение: приватность личной переписки — даже
    full_access-владелец не имеет доступа к чужому диалогу без явного
    участия в нём."""
    owner = register_business(client, email="msg6@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    client.put(
        f"/api/businesses/{business_id}/messaging-mode",
        json={"mode": "everyone"},
        headers=auth_headers(owner["access_token"]),
    )
    alice_token = _invite(client, business_id, owner["access_token"], "alice6@example.com", name="Алиса")
    bob_token = _invite(client, business_id, owner["access_token"], "bob6@example.com", name="Боб")
    bob_id = _employee_id(client, business_id, owner["access_token"], "Боб")

    conv = client.post(
        f"/api/businesses/{business_id}/conversations",
        json={"type": "dm", "participant_ids": [bob_id]},
        headers=auth_headers(alice_token),
    ).json()
    client.post(
        f"/api/businesses/{business_id}/conversations/{conv['id']}/messages",
        json={"text": "Приватное сообщение"},
        headers=auth_headers(alice_token),
    )

    # Владелец не видит этот диалог в своём списке...
    owner_list = client.get(f"/api/businesses/{business_id}/conversations", headers=auth_headers(owner["access_token"]))
    assert conv["id"] not in [c["id"] for c in owner_list.json()]

    # ...и не может прочитать сообщения напрямую по id.
    read_resp = client.get(
        f"/api/businesses/{business_id}/conversations/{conv['id']}/messages",
        headers=auth_headers(owner["access_token"]),
    )
    assert read_resp.status_code == 403

    # ...и не может написать в него.
    write_resp = client.post(
        f"/api/businesses/{business_id}/conversations/{conv['id']}/messages",
        json={"text": "Подслушиваю"},
        headers=auth_headers(owner["access_token"]),
    )
    assert write_resp.status_code == 403


def test_unread_count_and_last_message_preview(client):
    owner = register_business(client, email="msg7@example.com", password="correct horse battery staple", business_name="Владелец")
    business_id = _get_business_id(client, owner["access_token"])
    alice_token = _invite(client, business_id, owner["access_token"], "alice7@example.com", name="Алиса")
    owner_id = _employee_id(client, business_id, owner["access_token"], "Владелец")

    conv = client.post(
        f"/api/businesses/{business_id}/conversations",
        json={"type": "dm", "participant_ids": [owner_id]},
        headers=auth_headers(alice_token),
    ).json()

    client.post(
        f"/api/businesses/{business_id}/conversations/{conv['id']}/messages",
        json={"text": "Привет!"},
        headers=auth_headers(alice_token),
    )
    client.post(
        f"/api/businesses/{business_id}/conversations/{conv['id']}/messages",
        json={"text": "Второе сообщение"},
        headers=auth_headers(alice_token),
    )

    owner_list = client.get(f"/api/businesses/{business_id}/conversations", headers=auth_headers(owner["access_token"]))
    owner_conv = next(c for c in owner_list.json() if c["id"] == conv["id"])
    assert owner_conv["unread_count"] == 2
    assert owner_conv["last_message_preview"] == "Второе сообщение"

    # Прочитал (GET messages) — счётчик обнуляется.
    client.get(f"/api/businesses/{business_id}/conversations/{conv['id']}/messages", headers=auth_headers(owner["access_token"]))
    owner_list2 = client.get(f"/api/businesses/{business_id}/conversations", headers=auth_headers(owner["access_token"]))
    owner_conv2 = next(c for c in owner_list2.json() if c["id"] == conv["id"])
    assert owner_conv2["unread_count"] == 0


def test_only_owner_can_change_messaging_mode(client):
    owner = register_business(client, email="msg8@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    employee_token = _invite(client, business_id, owner["access_token"], "worker8@example.com")

    resp = client.put(
        f"/api/businesses/{business_id}/messaging-mode",
        json={"mode": "everyone"},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 403


def test_messaging_directory_reflects_mode(client):
    owner = register_business(client, email="msg9@example.com", password="correct horse battery staple", business_name="Владелец")
    business_id = _get_business_id(client, owner["access_token"])
    alice_token = _invite(client, business_id, owner["access_token"], "alice9@example.com", name="Алиса")
    _invite(client, business_id, owner["access_token"], "bob9@example.com", name="Боб")

    owner_only_dir = client.get(f"/api/businesses/{business_id}/messaging-directory", headers=auth_headers(alice_token))
    assert owner_only_dir.status_code == 200
    names = [e["name"] for e in owner_only_dir.json()]
    assert names == ["Владелец"]

    client.put(
        f"/api/businesses/{business_id}/messaging-mode",
        json={"mode": "everyone"},
        headers=auth_headers(owner["access_token"]),
    )
    everyone_dir = client.get(f"/api/businesses/{business_id}/messaging-directory", headers=auth_headers(alice_token))
    names2 = sorted(e["name"] for e in everyone_dir.json())
    assert names2 == ["Боб", "Владелец"]


def test_conversations_isolated_per_business(client):
    owner_a = register_business(client, email="msg10a@example.com", password="correct horse battery staple", business_name="Бизнес А")
    owner_b = register_business(client, email="msg10b@example.com", password="correct horse battery staple", business_name="Бизнес Б")
    business_a = _get_business_id(client, owner_a["access_token"])
    business_b = _get_business_id(client, owner_b["access_token"])

    alice_a_token = _invite(client, business_a, owner_a["access_token"], "alicea10@example.com", name="Алиса А")
    owner_a_id = _employee_id(client, business_a, owner_a["access_token"], "Бизнес А")

    conv = client.post(
        f"/api/businesses/{business_a}/conversations",
        json={"type": "dm", "participant_ids": [owner_a_id]},
        headers=auth_headers(alice_a_token),
    )
    assert conv.status_code == 200

    # Владелец бизнеса Б не видит и не может трогать диалог бизнеса А.
    cross_read = client.get(
        f"/api/businesses/{business_a}/conversations/{conv.json()['id']}/messages",
        headers=auth_headers(owner_b["access_token"]),
    )
    assert cross_read.status_code in (403, 404)

    b_list = client.get(f"/api/businesses/{business_b}/conversations", headers=auth_headers(owner_b["access_token"]))
    assert b_list.json() == []
