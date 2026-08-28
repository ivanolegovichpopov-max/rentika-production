"""Доска «Заметки/новости» дашборда — GET/POST/DELETE
/businesses/{business_id}/notes и PUT .../notes/mode.

Два сценария из ТЗ пользователя, оба через один переключатель notes_mode:
- owner_only (default): пишет только владелец, остальные читают.
- everyone: пишет любой активный сотрудник.
Удаление: свою запись — всегда автор; любую — всегда владелец (модерация).
Плюс: режим виден в GET /businesses (BusinessOut.notes_mode) и изолирован
по тенанту, как и остальные ресурсы бизнеса."""
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


def test_business_defaults_to_owner_only_mode(client):
    owner = register_business(client, email="notes1@example.com", password="correct horse battery staple")
    headers = auth_headers(owner["access_token"])
    business_id = _get_business_id(client, owner["access_token"])

    resp = client.get(f"/api/businesses/{business_id}", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["notes_mode"] == "owner_only"


def test_owner_only_mode_blocks_employee_posting(client):
    owner = register_business(client, email="notes2@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    employee_token = _invite(client, business_id, owner["access_token"], "worker2@example.com")

    resp = client.post(
        f"/api/businesses/{business_id}/notes",
        json={"text": "Пробую написать заметку"},
        headers=auth_headers(employee_token),
    )
    assert resp.status_code == 403

    # Но читать доску (пустую) сотрудник может.
    read_resp = client.get(f"/api/businesses/{business_id}/notes", headers=auth_headers(employee_token))
    assert read_resp.status_code == 200
    assert read_resp.json() == []

    # А владелец может опубликовать новость.
    owner_post = client.post(
        f"/api/businesses/{business_id}/notes",
        json={"text": "С понедельника новый прайс"},
        headers=auth_headers(owner["access_token"]),
    )
    assert owner_post.status_code == 201
    body = owner_post.json()
    assert body["text"] == "С понедельника новый прайс"
    assert body["can_delete"] is True

    # Сотрудник видит новость владельца, но не может её удалить.
    list_resp = client.get(f"/api/businesses/{business_id}/notes", headers=auth_headers(employee_token))
    assert list_resp.status_code == 200
    assert len(list_resp.json()) == 1
    assert list_resp.json()[0]["can_delete"] is False

    del_resp = client.delete(
        f"/api/businesses/{business_id}/notes/{body['id']}", headers=auth_headers(employee_token)
    )
    assert del_resp.status_code == 403


def test_everyone_mode_allows_employee_posting_and_self_delete(client):
    owner = register_business(client, email="notes3@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    employee_token = _invite(client, business_id, owner["access_token"], "worker3@example.com", name="Аня")

    mode_resp = client.put(
        f"/api/businesses/{business_id}/notes/mode",
        json={"mode": "everyone"},
        headers=auth_headers(owner["access_token"]),
    )
    assert mode_resp.status_code == 200
    assert mode_resp.json() == {"mode": "everyone"}

    post_resp = client.post(
        f"/api/businesses/{business_id}/notes",
        json={"text": "Заберите заказ у клиента в 15:00"},
        headers=auth_headers(employee_token),
    )
    assert post_resp.status_code == 201
    note = post_resp.json()
    assert note["author_name"] == "Аня"
    assert note["can_delete"] is True  # автор всегда может удалить своё

    # Другой обычный сотрудник (не автор) не может удалить чужую заметку.
    employee2_token = _invite(client, business_id, owner["access_token"], "worker3b@example.com", name="Боря")
    forbidden_del = client.delete(
        f"/api/businesses/{business_id}/notes/{note['id']}", headers=auth_headers(employee2_token)
    )
    assert forbidden_del.status_code == 403

    # Сам автор может удалить.
    own_del = client.delete(f"/api/businesses/{business_id}/notes/{note['id']}", headers=auth_headers(employee_token))
    assert own_del.status_code == 204

    empty = client.get(f"/api/businesses/{business_id}/notes", headers=auth_headers(owner["access_token"]))
    assert empty.json() == []


def test_owner_can_delete_any_note_in_everyone_mode(client):
    owner = register_business(client, email="notes4@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    employee_token = _invite(client, business_id, owner["access_token"], "worker4@example.com")
    client.put(
        f"/api/businesses/{business_id}/notes/mode", json={"mode": "everyone"}, headers=auth_headers(owner["access_token"])
    )
    note = client.post(
        f"/api/businesses/{business_id}/notes", json={"text": "Заметка сотрудника"}, headers=auth_headers(employee_token)
    ).json()

    resp = client.delete(f"/api/businesses/{business_id}/notes/{note['id']}", headers=auth_headers(owner["access_token"]))
    assert resp.status_code == 204


def test_only_owner_can_change_notes_mode(client):
    owner = register_business(client, email="notes5@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    employee_token = _invite(client, business_id, owner["access_token"], "worker5@example.com")

    resp = client.put(
        f"/api/businesses/{business_id}/notes/mode", json={"mode": "everyone"}, headers=auth_headers(employee_token)
    )
    assert resp.status_code == 403


def test_notes_isolated_per_business(client):
    owner_a = register_business(client, email="notes6a@example.com", password="correct horse battery staple")
    owner_b = register_business(client, email="notes6b@example.com", password="correct horse battery staple")
    business_a = _get_business_id(client, owner_a["access_token"])
    business_b = _get_business_id(client, owner_b["access_token"])

    client.post(
        f"/api/businesses/{business_a}/notes",
        json={"text": "Только для бизнеса A"},
        headers=auth_headers(owner_a["access_token"]),
    )

    resp_b = client.get(f"/api/businesses/{business_b}/notes", headers=auth_headers(owner_b["access_token"]))
    assert resp_b.json() == []


def test_platform_admin_can_post_note_in_own_business(client, monkeypatch):
    """Регрессия: get_business_context раньше ВСЕГДА подставлял ctx.employee=None
    для платформенного админа, даже в его собственном бизнесе, где Employee-запись
    реально существует (создаётся при /auth/register). Из-за этого POST .../notes
    падал с 400 «нет профиля сотрудника» для владельца платформы в его же бизнесе —
    то же самое било и по GET/PUT .../dashboard-prefs (см. app/api/routes/dashboard.py)."""
    from app.api.routes import auth as auth_module

    monkeypatch.setattr(auth_module.settings, "platform_admin_email", "admin@example.com")
    admin = register_business(client, email="admin@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, admin["access_token"])

    # Сам платформенный админ — владелец своего бизнеса, у него есть Employee.
    resp = client.post(
        f"/api/businesses/{business_id}/notes",
        json={"text": "Заметка от платформенного админа в своём бизнесе"},
        headers=auth_headers(admin["access_token"]),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["can_delete"] is True

    prefs_resp = client.put(
        f"/api/businesses/{business_id}/dashboard-prefs",
        json={"hidden": ["panel-notes"], "stat_order": [], "panel_rows": []},
        headers=auth_headers(admin["access_token"]),
    )
    assert prefs_resp.status_code == 200, prefs_resp.text


def test_note_text_length_is_capped(client):
    owner = register_business(client, email="notes7@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])

    resp = client.post(
        f"/api/businesses/{business_id}/notes",
        json={"text": "x" * 2001},
        headers=auth_headers(owner["access_token"]),
    )
    assert resp.status_code == 422


def test_note_done_toggle(client):
    """PATCH .../notes/{id} — простая отметка "выполнено" (см. миграцию 0007
    и NoteUpdate). Новые записи создаются done=false; переключать может
    автор записи или владелец бизнеса (та же проверка, что и на удаление),
    остальные сотрудники — нет."""
    owner = register_business(client, email="notes8@example.com", password="correct horse battery staple")
    business_id = _get_business_id(client, owner["access_token"])
    employee_token = _invite(client, business_id, owner["access_token"], "worker8@example.com")

    # Переключаем режим доски на "everyone", чтобы сотрудник тоже мог писать
    # и получить свою собственную запись для проверки прав автора.
    mode_resp = client.put(
        f"/api/businesses/{business_id}/notes/mode",
        json={"mode": "everyone"},
        headers=auth_headers(owner["access_token"]),
    )
    assert mode_resp.status_code == 200, mode_resp.text

    owner_note = client.post(
        f"/api/businesses/{business_id}/notes",
        json={"text": "Задача владельца"},
        headers=auth_headers(owner["access_token"]),
    ).json()
    assert owner_note["done"] is False

    employee_note = client.post(
        f"/api/businesses/{business_id}/notes",
        json={"text": "Задача сотрудника"},
        headers=auth_headers(employee_token),
    ).json()

    # Сотрудник не может отметить чужую (владельца) запись выполненной.
    forbidden = client.patch(
        f"/api/businesses/{business_id}/notes/{owner_note['id']}",
        json={"done": True},
        headers=auth_headers(employee_token),
    )
    assert forbidden.status_code == 403

    # Но может отметить свою собственную.
    own_ok = client.patch(
        f"/api/businesses/{business_id}/notes/{employee_note['id']}",
        json={"done": True},
        headers=auth_headers(employee_token),
    )
    assert own_ok.status_code == 200, own_ok.text
    assert own_ok.json()["done"] is True

    # Владелец (модерация) может отметить/снять отметку у чьей угодно записи.
    owner_toggle = client.patch(
        f"/api/businesses/{business_id}/notes/{employee_note['id']}",
        json={"done": False},
        headers=auth_headers(owner["access_token"]),
    )
    assert owner_toggle.status_code == 200
    assert owner_toggle.json()["done"] is False

    # Отметка видна и в общем списке.
    listing = client.get(f"/api/businesses/{business_id}/notes", headers=auth_headers(owner["access_token"]))
    by_id = {n["id"]: n for n in listing.json()}
    assert by_id[employee_note["id"]]["done"] is False
