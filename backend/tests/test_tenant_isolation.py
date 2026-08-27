"""
Проверка на уровне прикладной логики: сотрудник/владелец бизнеса A не может
увидеть или изменить данные бизнеса B, даже если знает его business_id и
equipment_id (например, подобрав UUID или получив его из старой ссылки).
Row Level Security в Postgres — это ВТОРОЙ, независимый рубеж той же
защиты (не проверяется здесь, см. README про тестирование на реальном Postgres).
"""
from tests.conftest import auth_headers, register_business


def _get_business_id(client, token):
    return client.get("/api/businesses", headers=auth_headers(token)).json()[0]["id"]


def test_business_a_cannot_list_equipment_of_business_b(client):
    owner_a = register_business(client, email="a@example.com", password="correct horse battery staple")
    owner_b = register_business(client, email="b@example.com", password="correct horse battery staple")

    business_b_id = _get_business_id(client, owner_b["access_token"])
    client.post(
        f"/api/businesses/{business_b_id}/equipment",
        json={"name": "Секретная бетономешалка", "category": "Стройтехника", "daily_rate": 1000},
        headers=auth_headers(owner_b["access_token"]),
    )

    # owner_a пытается достучаться до бизнеса B, используя СВОЙ (валидный) токен
    resp = client.get(f"/api/businesses/{business_b_id}/equipment", headers=auth_headers(owner_a["access_token"]))
    assert resp.status_code == 403


def test_business_a_cannot_modify_equipment_of_business_b_by_guessing_id(client):
    owner_a = register_business(client, email="c@example.com", password="correct horse battery staple")
    owner_b = register_business(client, email="d@example.com", password="correct horse battery staple")

    business_a_id = _get_business_id(client, owner_a["access_token"])
    business_b_id = _get_business_id(client, owner_b["access_token"])

    eq = client.post(
        f"/api/businesses/{business_b_id}/equipment",
        json={"name": "Чужой перфоратор", "category": "Инструмент", "daily_rate": 500},
        headers=auth_headers(owner_b["access_token"]),
    ).json()

    # owner_a подставляет СВОЙ business_id (единственный, куда у него есть
    # доступ) с чужим equipment_id — маршрут должен не найти запись, а не
    # вернуть/изменить чужую.
    resp = client.patch(
        f"/api/businesses/{business_a_id}/equipment/{eq['id']}",
        json={"name": "Взломано", "category": "Инструмент", "daily_rate": 1},
        headers=auth_headers(owner_a["access_token"]),
    )
    assert resp.status_code == 404


def test_employee_of_one_business_has_no_access_to_another(client):
    owner_a = register_business(client, email="e@example.com", password="correct horse battery staple")
    owner_b = register_business(client, email="f@example.com", password="correct horse battery staple")

    business_a_id = _get_business_id(client, owner_a["access_token"])
    business_b_id = _get_business_id(client, owner_b["access_token"])

    position = client.post(
        f"/api/businesses/{business_a_id}/positions", json={"title": "Менеджер A"}, headers=auth_headers(owner_a["access_token"])
    ).json()
    client.put(
        f"/api/businesses/{business_a_id}/positions/{position['id']}/permissions",
        json={"permissions": [{"resource": "equipment", "level": "edit"}]},
        headers=auth_headers(owner_a["access_token"]),
    )
    client.post(
        f"/api/businesses/{business_a_id}/employees",
        json={
            "email": "cross@example.com",
            "name": "Сотрудник A",
            "position_id": position["id"],
            "temporary_password": "another long enough password",
        },
        headers=auth_headers(owner_a["access_token"]),
    )
    employee_token = client.post(
        "/api/auth/login", json={"email": "cross@example.com", "password": "another long enough password"}
    ).json()["access_token"]

    resp = client.get(f"/api/businesses/{business_b_id}/equipment", headers=auth_headers(employee_token))
    assert resp.status_code == 403
