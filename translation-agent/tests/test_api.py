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


def test_format_endpoint_preserves_translations_and_reuses_saved_presentation(
    tmp_path, monkeypatch
):
    async def idle_worker(self):
        await asyncio.Event().wait()

    monkeypatch.setattr(api, "state_directory", lambda: state_directory(tmp_path))
    monkeypatch.setattr(api.ChapterQueue, "_consume", idle_worker)
    with pymupdf.open() as pdf:
        pdf.new_page().insert_text((40, 100), "A plain body paragraph for cache verification.")
        data = pdf.tobytes()
    headers = {"x-koodo-translation": "1", "origin": "https://koodoreader.localhost"}
    with TestClient(api.app) as client:
        book = client.post("/api/translation/books?key=cache", content=data, headers=headers).json()
        queue = api.app.state.queue
        document = api.app.state.documents.get(book["id"])
        chapter_id = book["chapters"][0]["id"]
        task = queue.create(book["id"], chapter_id, "test-model")
        segment_id = document["blocks"][0]["id"]
        job = queue.jobs.start({"fixture": True}, "test-model")
        translated = {"segments": [{"segment_id": segment_id, "text": "已有中文译文。"}]}
        queue.jobs.save(job["id"], "completed", {"accepted": translated, "draft": translated})
        task["chunks"][0]["job_id"], task["status"] = job["id"], "completed"
        queue.save(task)
        path = f"/api/translation/books/{book['id']}/chapters/{chapter_id}"
        before = client.get(path).json()
        assert client.get("/api/translation/library").json() == {
            "cache": {"completed": 1, "total": 1, "complete": True}
        }
        assert client.post(path + "/pages/1/format").status_code == 403
        restored = client.post(path + "/pages/1/format", headers=headers)
        assert restored.status_code == 200
        assert restored.json()["status"] == "ready"
        count = len(queue.jobs.list_jobs())
        assert client.post(path + "/pages/1/format", headers=headers).json() == restored.json()
        assert len(queue.jobs.list_jobs()) == count
        after = client.get(path).json()
        assert after["blocks"] == before["blocks"]
        assert after["task"] == before["task"]
        assert api.app.state.documents.get(book["id"]) == document


def test_whole_book_api_is_idempotent_and_exports_original_pdf(tmp_path, monkeypatch):
    import io
    import json
    import zipfile

    async def idle_worker(self):
        await asyncio.Event().wait()

    async def available_models(self):
        return [{"slug": "test-model", "display_name": "Test model"}]

    monkeypatch.setattr(api, "state_directory", lambda: state_directory(tmp_path))
    monkeypatch.setattr(api.ChapterQueue, "_consume", idle_worker)
    monkeypatch.setattr("koodo_translation.auth.ChatGPTAuth.models", available_models)
    with pymupdf.open() as pdf:
        pdf.new_page().insert_text((40, 100), "Whole-book API source text.")
        data = pdf.tobytes()
    headers = {"x-koodo-translation": "1", "origin": "https://koodoreader.localhost"}
    with TestClient(api.app) as client:
        book = client.post("/api/translation/books?key=whole", content=data, headers=headers).json()
        root = f"/api/translation/books/{book['id']}"
        assert client.get(root + "/whole").json()["status"] == "not_started"
        assert client.post(root + "/whole", json={"model": "test-model"}).status_code == 403
        assert client.post(root + "/export").status_code == 403
        assert (
            client.post(root + "/whole", json={"model": "bad"}, headers=headers).status_code == 400
        )
        first = client.post(root + "/whole", json={"model": "test-model"}, headers=headers)
        assert first.status_code == 202
        assert (
            client.post(root + "/whole", json={"model": "test-model"}, headers=headers).json()["id"]
            == first.json()["id"]
        )
        api.app.state.queue.books.advance()
        assert client.post(root + "/whole/pause", headers=headers).json()["status"] == "paused"
        assert client.post(root + "/whole/resume", headers=headers).json()["status"] == "queued"
        assert client.post(root + "/whole/delete", headers=headers).status_code == 404
        response = client.post(root + "/export", headers=headers)
        assert response.status_code == 200
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            assert archive.read("source.pdf") == data
            assert json.loads(archive.read("manifest.json"))["status"] == "partial"
