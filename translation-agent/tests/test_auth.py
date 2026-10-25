import hashlib
import json
import os
import threading
import time
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import urlopen

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from koodo_translation.auth import (
    API,
    ISSUER,
    PLAN_SCOPE,
    AuthenticationError,
    ChatGPTAuth,
    authorization_parameters,
    validate_callback,
    validate_identity,
)
from koodo_translation.storage import state_directory, write_private_json


def test_pkce_and_returning_registration():
    import base64

    params, verifier = authorization_parameters("urn:uuid:host", "http://127.0.0.1:1/auth/callback")
    assert params["client_id"] == "dynamic_agent_client"
    assert PLAN_SCOPE in params["scope"]
    assert (
        params["code_challenge"]
        == base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    returning, _ = authorization_parameters(
        "urn:uuid:host",
        "http://127.0.0.1:2/auth/callback",
        {
            "client_id": "oaiapp_saved",
            "id_token": "saved-id-token",
        },
    )
    assert returning["client_id"] == "oaiapp_saved"
    assert "id_token_hint" not in returning
    assert "saved-id-token" not in json.dumps(returning)
    assert "agent_name_hint" not in returning
    assert params["state"] != returning["state"]


def test_callbacks_reject_state_duplicates_and_changed_client():
    params = {"state": "expected", "client_id": "dynamic_agent_client"}
    valid = {"state": ["expected"], "code": ["one-use-code"], "client_id": ["oaiapp_new"]}
    assert validate_callback(valid, params) == ("one-use-code", "oaiapp_new")
    for changes in (
        {"state": ["wrong"]},
        {"state": ["expected", "expected"]},
        {"client_id": ["dynamic_agent_client"]},
        {"client_id": []},
        {"error": ["access_denied"]},
    ):
        with pytest.raises(AuthenticationError):
            validate_callback({**valid, **changes}, params)
    with pytest.raises(AuthenticationError):
        validate_callback(valid, {**params, "client_id": "oaiapp_other"})


@pytest.fixture
def identity_keys():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
    public["kid"] = "test-key"
    return key, {"keys": [public]}


def test_id_token_signature_audience_nonce_and_expiry(identity_keys):
    key, jwks = identity_keys
    claims = {
        "sub": "test-account",
        "iss": ISSUER,
        "aud": "oaiapp_test",
        "nonce": "one-use-nonce",
        "iat": int(time.time()),
        "exp": int(time.time()) + 600,
    }

    def token(values):
        return jwt.encode(values, key, algorithm="RS256", headers={"kid": "test-key"})

    assert validate_identity(token(claims), "oaiapp_test", "one-use-nonce", jwks)["sub"] == (
        "test-account"
    )
    for changes in ({"aud": "other-client"}, {"nonce": "wrong"}, {"exp": 1}, {"iss": "other"}):
        with pytest.raises(AuthenticationError):
            validate_identity(token({**claims, **changes}), "oaiapp_test", "one-use-nonce", jwks)


def test_refresh_rotates_atomically_without_changing_billing(tmp_path, monkeypatch):
    directory = state_directory(tmp_path)
    auth = ChatGPTAuth(directory)
    write_private_json(
        auth.path,
        {
            "client_id": "oaiapp_test",
            "subject": "test-account",
            "scopes": [PLAN_SCOPE],
            "access_token": "old-access",
            "refresh_token": "old-refresh",
            "expires_at": 0,
        },
    )
    requests = []

    def handle(request):
        requests.append(request)
        form = parse_qs(request.content.decode())
        assert form["client_id"] == ["oaiapp_test"]
        assert form["resource"] == [API]
        assert form["refresh_token"] == ["old-refresh"]
        assert "scope" not in form
        return httpx.Response(
            200,
            json={
                "access_token": "new-access",
                "refresh_token": "new-refresh",
                "expires_in": 3600,
                "token_type": "Bearer",
            },
        )

    real_client = httpx.Client
    monkeypatch.setattr(
        httpx, "Client", lambda **kw: real_client(**kw, transport=httpx.MockTransport(handle))
    )
    assert auth._access_token() == "new-access"
    assert auth._access_token() == "new-access"
    assert len(requests) == 1
    assert auth.read()["refresh_token"] == "new-refresh"
    assert auth.read()["scopes"] == [PLAN_SCOPE]
    assert os.stat(auth.path).st_mode & 0o777 == 0o600
    assert "new-access" not in json.dumps(auth.status())


def test_identity_only_signin_cannot_make_model_calls(tmp_path):
    auth = ChatGPTAuth(state_directory(tmp_path))
    write_private_json(
        auth.path,
        {
            "access_token": "identity-only",
            "scopes": ["openid"],
            "expires_at": time.time() + 100,
        },
    )
    with pytest.raises(AuthenticationError, match="permission"):
        auth._access_token()


def test_login_callback_exchange_and_identity_are_verified(tmp_path, monkeypatch, identity_keys):
    key, jwks = identity_keys
    auth = ChatGPTAuth(state_directory(tmp_path))
    pending = {}
    threads = []
    callback_errors = []

    def announce(url):
        pending.update({k: v[0] for k, v in parse_qs(urlparse(url).query).items()})

        def callback():
            try:
                query = urlencode(
                    {
                        "state": pending["state"],
                        "code": "one-use-code",
                        "client_id": "oaiapp_test",
                    }
                )
                with urlopen(pending["redirect_uri"] + "?" + query, timeout=5) as response:
                    assert response.status == 200
            except Exception as error:
                callback_errors.append(error)

        thread = threading.Thread(target=callback)
        threads.append(thread)
        thread.start()

    def handle(request):
        if request.url.path.endswith("jwks.json"):
            return httpx.Response(200, json=jwks)
        form = parse_qs(request.content.decode())
        assert form["client_id"] == ["oaiapp_test"]
        assert form["redirect_uri"] == [pending["redirect_uri"]]
        assert form["resource"] == [API]
        assert form["code"] == ["one-use-code"]
        claims = {
            "sub": "test-account",
            "iss": ISSUER,
            "aud": "oaiapp_test",
            "nonce": pending["nonce"],
            "iat": int(time.time()),
            "exp": int(time.time()) + 600,
        }
        return httpx.Response(
            200,
            json={
                "id_token": jwt.encode(claims, key, algorithm="RS256", headers={"kid": "test-key"}),
                "access_token": "test-access",
                "refresh_token": "test-refresh",
                "token_type": "Bearer",
                "expires_in": 3600,
                "scope": PLAN_SCOPE,
            },
        )

    real_client = httpx.Client
    monkeypatch.setattr(
        httpx, "Client", lambda **kw: real_client(**kw, transport=httpx.MockTransport(handle))
    )
    result = auth.login(announce, timeout=5)
    for thread in threads:
        thread.join(timeout=5)
    assert not callback_errors
    assert result["connected"] is True
    assert result["plan_usage_enabled"] is True
    assert auth.read()["subject"] == "test-account"
    assert auth.read()["client_id"] == "oaiapp_test"
    assert auth.host_id() == pending["ext_agent_host_id"]
    assert not (tmp_path / "registration.json").exists()


def test_revoked_refresh_stops_without_retry(tmp_path, monkeypatch):
    auth = ChatGPTAuth(state_directory(tmp_path))
    write_private_json(
        auth.path,
        {
            "client_id": "oaiapp_test",
            "access_token": "old",
            "refresh_token": "old-refresh",
            "scopes": [PLAN_SCOPE],
            "expires_at": 0,
        },
    )
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(400, json={"error": "invalid_grant"})

    real_client = httpx.Client
    monkeypatch.setattr(
        httpx, "Client", lambda **kw: real_client(**kw, transport=httpx.MockTransport(handle))
    )
    with pytest.raises(AuthenticationError, match="refresh failed"):
        auth._access_token()
    with pytest.raises(AuthenticationError, match="login"):
        auth._access_token()
    assert len(requests) == 1
    assert auth.status()["connected"] is False
    assert auth.status()["needs_login"] is True
