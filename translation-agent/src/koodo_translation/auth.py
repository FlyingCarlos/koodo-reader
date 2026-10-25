"""Official Sign in with ChatGPT flow. Never reads Codex's credential store."""

import asyncio
import base64
import hashlib
import hmac
import json
import secrets
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
import jwt

from .storage import exclusive_lock, write_private_json

ISSUER = "https://auth.openai.com"
AUTHORIZE = ISSUER + "/api/accounts/authorize"
TOKEN = ISSUER + "/api/accounts/oauth/token"
JWKS = ISSUER + "/.well-known/jwks.json"
API = "https://api.openai.com/v1"
APP_NAME = "Koodo Reader Translation"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
SCOPES = "openid profile email offline_access resource.invoke " + PLAN_SCOPE
TERMINAL_REFRESH_ERRORS = {
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
}


class AuthenticationError(RuntimeError):
    pass


def authorization_parameters(host_id: str, redirect: str, saved: dict | None = None):
    verifier = secrets.token_urlsafe(64)
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=")
    params = {
        "client_id": saved["client_id"] if saved else "dynamic_agent_client",
        "ext_agent_host_id": host_id,
        "response_type": "code",
        "redirect_uri": redirect,
        "scope": SCOPES,
        "resource": API,
        "state": state,
        "nonce": nonce,
        "code_challenge_method": "S256",
        "code_challenge": challenge.decode(),
    }
    if saved is None:
        params["agent_name_hint"] = APP_NAME
    # This CLI prints its authorization URL. Omit the optional id_token_hint so
    # a returning account's signed identity token never enters terminal logs.
    return params, verifier


def validate_callback(query: dict[str, list[str]], params: dict) -> tuple[str, str]:
    def single(key: str) -> str:
        values = query.get(key, [])
        if len(values) != 1 or not values[0]:
            raise AuthenticationError(f"Missing or ambiguous OAuth callback field: {key}.")
        return values[0]

    if not hmac.compare_digest(single("state"), params["state"]):
        raise AuthenticationError("OAuth state mismatch; this callback was not accepted.")
    if "error" in query:
        raise AuthenticationError("ChatGPT authorization was declined or failed.")
    code = single("code")
    if params["client_id"] == "dynamic_agent_client":
        client_id = single("client_id")
        if client_id == "dynamic_agent_client":
            raise AuthenticationError("Registration did not issue a client ID.")
    else:
        client_id = params["client_id"]
        if "client_id" in query and single("client_id") != client_id:
            raise AuthenticationError("Reauthorization changed the registered client ID.")
    return code, client_id


def validate_identity(token: str, client_id: str, nonce: str, jwks: dict) -> dict:
    try:
        header = jwt.get_unverified_header(token)
        keys = [key for key in jwks["keys"] if key.get("kid") == header.get("kid")]
        if len(keys) != 1 or header.get("alg") != "RS256":
            raise AuthenticationError("Unknown ID-token signing key or algorithm.")
        public_key = jwt.PyJWK.from_dict(keys[0]).key
        identity = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            issuer=ISSUER,
            audience=client_id,
            options={"require": ["exp", "iat", "iss", "aud", "sub", "nonce"]},
        )
        if not isinstance(identity["nonce"], str) or not hmac.compare_digest(
            identity["nonce"], nonce
        ):
            raise AuthenticationError("ID-token nonce mismatch.")
        return identity
    except (jwt.PyJWTError, KeyError, ValueError) as error:
        raise AuthenticationError("ID-token validation failed.") from error


class ChatGPTAuth:
    def __init__(self, directory: Path):
        self.directory = directory
        self.path = directory / "credentials.json"

    def read(self) -> dict | None:
        if self.path.exists():
            return json.loads(self.path.read_text())
        return None

    def host_id(self) -> str:
        path = self.directory / "host.json"
        if not path.exists():
            write_private_json(path, {"id": "urn:uuid:" + str(uuid.uuid4())})
        return json.loads(path.read_text())["id"]

    def status(self) -> dict:
        saved = self.read()
        return {
            "connected": bool(saved and saved.get("access_token") and not saved.get("needs_login")),
            "plan_usage_enabled": bool(saved and PLAN_SCOPE in saved.get("scopes", [])),
            "needs_login": bool(saved and saved.get("needs_login")),
            "expires_at": saved.get("expires_at") if saved else None,
        }

    @staticmethod
    def token_record(data: dict, previous: dict) -> dict:
        if not data.get("access_token") or str(data.get("token_type", "")).lower() != "bearer":
            raise AuthenticationError("Token exchange did not return a bearer access token.")
        # A refresh can omit scope to retain the existing grant.
        scopes = data["scope"].split() if "scope" in data else previous.get("scopes", [])
        return {
            **previous,
            "access_token": data["access_token"],
            "refresh_token": data.get("refresh_token", previous.get("refresh_token")),
            "id_token": data.get("id_token", previous.get("id_token")),
            "scopes": scopes,
            "expires_at": time.time() + int(data["expires_in"]),
            "needs_login": False,
        }

    def login(self, announce, timeout: int = 300) -> dict:
        with exclusive_lock(self.directory / "auth.lock"):
            return self._login(announce, timeout)

    def _login(self, announce, timeout: int) -> dict:
        saved = self.read()
        pending_path = self.directory / "registration.json"
        registration = saved or (
            json.loads(pending_path.read_text()) if pending_path.exists() else None
        )
        outcome = {}
        params = {}

        class Callback(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass  # Callback URLs contain single-use authorization codes.

            def do_GET(self):
                parsed = urlparse(self.path)
                if parsed.path != "/auth/callback":
                    self.send_error(404)
                    return
                query = parse_qs(parsed.query, keep_blank_values=True)
                if query.get("state") == [params["state"]] and "error" in query:
                    outcome["declined"] = True
                try:
                    outcome["code"], outcome["client_id"] = validate_callback(query, params)
                except AuthenticationError:
                    self.send_error(400, "Invalid or declined authorization; retry sign-in.")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(b"Authorization received. Check the terminal for verification.")

        with HTTPServer(("127.0.0.1", 0), Callback) as server:
            server.timeout = 0.5
            redirect = f"http://127.0.0.1:{server.server_port}/auth/callback"
            params, verifier = authorization_parameters(self.host_id(), redirect, registration)
            if saved and PLAN_SCOPE not in saved.get("scopes", []):
                params["prompt"] = "consent"
            announce(AUTHORIZE + "?" + urlencode(params))
            deadline = time.monotonic() + timeout
            while not outcome and time.monotonic() < deadline:
                server.handle_request()
            if outcome.get("declined"):
                raise AuthenticationError("ChatGPT authorization was declined.")
            if "code" not in outcome:
                raise AuthenticationError("Sign-in timed out; run login again.")

        client_id = outcome["client_id"]
        # Keep the issued ID even if code exchange fails; never replace a validated profile.
        write_private_json(pending_path, {"client_id": client_id})
        with httpx.Client(timeout=30) as http:
            response = http.post(
                TOKEN,
                data={
                    "grant_type": "authorization_code",
                    "client_id": client_id,
                    "code": outcome["code"],
                    "code_verifier": verifier,
                    "redirect_uri": redirect,
                    "resource": API,
                },
            )
            if response.status_code != 200:
                raise AuthenticationError(
                    f"OAuth code exchange failed (HTTP {response.status_code})."
                )
            data = response.json()
            key_response = http.get(JWKS)
            key_response.raise_for_status()
        identity = validate_identity(
            data.get("id_token", ""), client_id, params["nonce"], key_response.json()
        )
        if saved and identity["sub"] != saved["subject"]:
            raise AuthenticationError(
                "The returning account does not match the saved registration."
            )
        record = self.token_record(
            data,
            {
                "client_id": client_id,
                "subject": identity["sub"],
                "issuer": ISSUER,
                "ext_agent_host_id": self.host_id(),
            },
        )
        write_private_json(self.path, record)
        pending_path.unlink(missing_ok=True)
        return self.status()

    async def access_token(self) -> str:
        # The operation is short except for one bounded HTTP request. Serialize token rotation
        # across processes and run it outside the SDK event loop.
        return await asyncio.to_thread(self._access_token)

    def _access_token(self) -> str:
        with exclusive_lock(self.directory / "auth.lock"):
            saved = self.read()
            if not saved or saved.get("needs_login"):
                raise AuthenticationError(
                    "Run koodo-translate login before using the subscription."
                )
            if PLAN_SCOPE not in saved.get("scopes", []):
                raise AuthenticationError("Sign-in did not grant ChatGPT plan usage permission.")
            if saved["expires_at"] > time.time() + 60:
                return saved["access_token"]
            if not saved.get("refresh_token"):
                raise AuthenticationError("The session cannot be renewed; sign in again.")
            with httpx.Client(timeout=30) as http:
                response = http.post(
                    TOKEN,
                    data={
                        "grant_type": "refresh_token",
                        "client_id": saved["client_id"],
                        "refresh_token": saved["refresh_token"],
                        "resource": API,
                    },
                )
            if response.status_code != 200:
                try:
                    code = response.json().get("error", "")
                    if isinstance(code, dict):
                        code = code.get("code", "")
                except ValueError:
                    code = ""
                if code in TERMINAL_REFRESH_ERRORS:
                    write_private_json(self.path, {**saved, "needs_login": True})
                raise AuthenticationError(
                    f"Session refresh failed (HTTP {response.status_code}); no API-key fallback."
                )
            renewed = self.token_record(response.json(), saved)
            write_private_json(self.path, renewed)
            if PLAN_SCOPE not in renewed["scopes"]:
                raise AuthenticationError(
                    "The renewed session no longer grants ChatGPT plan usage."
                )
            return renewed["access_token"]

    async def models(self) -> list[dict]:
        token = await self.access_token()
        async with httpx.AsyncClient(timeout=30) as http:
            response = await http.get(API + "/models", headers={"Authorization": f"Bearer {token}"})
            if response.status_code != 200:
                raise AuthenticationError(f"Model discovery failed (HTTP {response.status_code}).")
            return [
                {"slug": model["slug"], "display_name": model.get("display_name", model["slug"])}
                for model in response.json()["models"]
                if model.get("visibility") == "list"
            ]
