import asyncio

import pymupdf
from starlette.testclient import TestClient

from koodo_translation import api
from koodo_translation.storage import state_directory


def test_same_origin_access_and_missing_documents(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "state_directory", lambda: state_directory(tmp_path))
    with TestClient(api.app) as client:
        assert client.get("/healthz").status_code == 200
        assert client.get("/api/translation/status").json()["connected"] is False
        missing = client.get("/api/translation/books?key=absent")
        assert missing.status_code == 404
        assert missing.headers["cache-control"] == "no-store"
        assert client.post("/api/translation/books?key=test", content=b"bad").status_code == 403
        assert (
            client.post(
                "/api/translation/books?key=test",
                content=b"bad",
                headers={
                    "x-koodo-translation": "1",
                    "origin": "https://unrelated.example",
                },
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/api/translation/books?key=test",
                content=b"bad",
                headers={
                    "x-koodo-translation": "1",
                    "origin": "https://koodoreader.localhost",
                },
            ).status_code
            == 400
        )
        assert client.get("/api/translation/books/..%2F..%2Fcredentials.json").status_code == 404


def test_import_read_and_control_chapter_without_network(tmp_path, monkeypatch):
    async def idle_worker(self):
        await asyncio.Event().wait()

    async def available_models(self):
        return [{"slug": "test-model", "display_name": "Test model"}]

    monkeypatch.setattr(api, "state_directory", lambda: state_directory(tmp_path))
    monkeypatch.setattr(api.ChapterQueue, "_consume", idle_worker)
    monkeypatch.setattr("koodo_translation.auth.ChatGPTAuth.models", available_models)
    with pymupdf.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 100), "An API fixture with readable source text.")
        data = pdf.tobytes()
    headers = {"x-koodo-translation": "1", "origin": "https://koodoreader.localhost"}
    with TestClient(api.app) as client:
        imported = client.post(
            "/api/translation/books?key=fixture&title=Fixture", content=data, headers=headers
        )
        assert imported.status_code == 201
        book = imported.json()
        chapter_id = book["chapters"][0]["id"]
        path = f"/api/translation/books/{book['id']}/chapters/{chapter_id}"
        assert client.get(f"/api/translation/books/{book['id']}/source.pdf").content == data
        content = client.get(path).json()
        assert content["blocks"][0]["text"] == "An API fixture with readable source text."
        assert content["task"] is None
        submitted = client.post(path + "/translate", json={"model": "test-model"}, headers=headers)
        assert submitted.status_code == 202
        task = submitted.json()
        assert (
            client.post(path + "/translate", json={"model": "test-model"}, headers=headers).json()[
                "id"
            ]
            == task["id"]
        )
        control = f"/api/translation/tasks/{task['id']}"
        assert client.post(control + "/pause", headers=headers).json()["status"] == "paused"
        assert client.post(control + "/resume", headers=headers).json()["status"] == "queued"
        assert client.post(control + "/delete", headers=headers).status_code == 404
        assert client.get(path).json()["task"]["total"] == 1
