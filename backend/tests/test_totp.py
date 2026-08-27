import pyotp

from tests.conftest import auth_headers, register_business


def test_totp_setup_and_confirm_enables_2fa(client):
    owner = register_business(client, email="totp1@example.com", password="correct horse battery staple")
    setup = client.post("/api/auth/2fa/setup", headers=auth_headers(owner["access_token"])).json()
    assert setup["secret"]

    code = pyotp.TOTP(setup["secret"]).now()
    confirm = client.post("/api/auth/2fa/confirm", json={"code": code}, headers=auth_headers(owner["access_token"]))
    assert confirm.status_code == 200
    assert len(confirm.json()["backup_codes"]) == 10


def test_login_requires_totp_after_enabling(client):
    owner = register_business(client, email="totp2@example.com", password="correct horse battery staple")
    setup = client.post("/api/auth/2fa/setup", headers=auth_headers(owner["access_token"])).json()
    code = pyotp.TOTP(setup["secret"]).now()
    client.post("/api/auth/2fa/confirm", json={"code": code}, headers=auth_headers(owner["access_token"]))

    login = client.post("/api/auth/login", json={"email": "totp2@example.com", "password": "correct horse battery staple"})
    body = login.json()
    assert body["requires_totp"] is True
    assert body["access_token"] is None

    good_code = pyotp.TOTP(setup["secret"]).now()
    final = client.post("/api/auth/login/totp", json={"totp_challenge_token": body["totp_challenge_token"], "code": good_code})
    assert final.status_code == 200
    assert final.json()["access_token"]


def test_login_totp_rejects_wrong_code(client):
    owner = register_business(client, email="totp3@example.com", password="correct horse battery staple")
    setup = client.post("/api/auth/2fa/setup", headers=auth_headers(owner["access_token"])).json()
    code = pyotp.TOTP(setup["secret"]).now()
    client.post("/api/auth/2fa/confirm", json={"code": code}, headers=auth_headers(owner["access_token"]))

    login = client.post("/api/auth/login", json={"email": "totp3@example.com", "password": "correct horse battery staple"})
    challenge = login.json()["totp_challenge_token"]

    resp = client.post("/api/auth/login/totp", json={"totp_challenge_token": challenge, "code": "000000"})
    assert resp.status_code == 401


def test_backup_code_works_once(client):
    owner = register_business(client, email="totp4@example.com", password="correct horse battery staple")
    setup = client.post("/api/auth/2fa/setup", headers=auth_headers(owner["access_token"])).json()
    code = pyotp.TOTP(setup["secret"]).now()
    confirm = client.post("/api/auth/2fa/confirm", json={"code": code}, headers=auth_headers(owner["access_token"])).json()
    backup_code = confirm["backup_codes"][0]

    login = client.post("/api/auth/login", json={"email": "totp4@example.com", "password": "correct horse battery staple"})
    challenge = login.json()["totp_challenge_token"]

    first = client.post("/api/auth/login/totp", json={"totp_challenge_token": challenge, "code": backup_code})
    assert first.status_code == 200

    login2 = client.post("/api/auth/login", json={"email": "totp4@example.com", "password": "correct horse battery staple"})
    challenge2 = login2.json()["totp_challenge_token"]
    second = client.post("/api/auth/login/totp", json={"totp_challenge_token": challenge2, "code": backup_code})
    assert second.status_code == 401
