import asyncio
import json
import zipfile

import pymupdf
import pytest

from koodo_translation.chapters import ChapterQueue
from koodo_translation.documents import DocumentStore
from koodo_translation.storage import state_directory


@pytest.fixture
def setup_book(tmp_path):
    store = DocumentStore(state_directory(tmp_path))
    with pymupdf.open() as pdf:
        for index in range(3):
            pdf.new_page().insert_text((40, 100), f"A source paragraph for chapter {index}.")
        pdf.set_toc([[1, f"Chapter {i}: Example", i + 1] for i in range(3)])
        data = pdf.tobytes()
    book = store.import_pdf(data, "book", "Fixture Book")
    return ChapterQueue(store), book, data


def complete(queue, task):
    task = queue.get(task["id"])
    for chunk in task["chunks"]:
        job = queue.jobs.start({"private": "prompt must not be exported"}, task["model"])
        queue.jobs.save(
            job["id"],
            "completed",
            {
                "accepted": {
                    "segments": [
                        {"segment_id": block_id, "text": "已有中文。"} for block_id in chunk["ids"]
                    ]
                }
            },
        )
        chunk["job_id"] = job["id"]
    task["status"] = "completed"
    queue.save(task)
    return task


def test_whole_book_reuses_existing_models_and_translations_and_publishes(setup_book):
    queue, book, original = setup_book
    first = complete(queue, queue.create(book["id"], book["chapters"][0]["id"], "old-model"))
    saved = queue.jobs.get(first["chunks"][0]["job_id"])
    whole = queue.books.create(book["id"], "new-model")
    assert queue.books.create(book["id"], "another-model")["id"] == whole["id"]
    queue.books.advance()
    second = queue.for_chapter(book["id"], book["chapters"][1]["id"])
    assert second["model"] == "new-model"
    assert queue.for_chapter(book["id"], book["chapters"][2]["id"]) is None
    complete(queue, second)
    queue.books.advance()
    complete(queue, queue.for_chapter(book["id"], book["chapters"][2]["id"]))
    queue.books.advance()
    status = queue.books.summary(book["id"])
    assert status["status"] == "completed"
    assert status["completed_chapters"] == status["total_chapters"] == 3
    assert queue.jobs.get(saved["id"]) == saved
    with zipfile.ZipFile(queue.documents.folder(book["id"]) / "bilingual.koodo.zip") as archive:
        assert archive.read("source.pdf") == original
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["status"] == "completed"
        assert manifest["cover"] == {"source": "source.pdf", "page": 1}
        assert not any("sqlite" in name or "credentials" in name for name in archive.namelist())
        content = json.loads(archive.read(f"chapters/{first['chapter_id']}.json"))
        assert content["blocks"][0]["id"] == book["blocks"][0]["id"]
        assert content["blocks"][0]["translation"]["text"] == "已有中文。"
    queue._chapter = lambda *args: pytest.fail("Finished book must use its reading file")
    assert queue.chapter(book["id"], first["chapter_id"])["blocks"] == content["blocks"]


def test_pause_quota_failure_and_restart_do_not_skip_chapters(setup_book, monkeypatch):
    queue, book, _ = setup_book
    queue.books.create(book["id"], "model")
    queue.books.advance()
    first = queue.for_chapter(book["id"], book["chapters"][0]["id"])
    queue.books.control(book["id"], "pause")
    assert queue.get(first["id"])["status"] == "paused"
    queue.books.advance()
    assert queue.for_chapter(book["id"], book["chapters"][1]["id"]) is None

    async def idle_worker(self):
        await asyncio.Event().wait()

    monkeypatch.setattr(ChapterQueue, "_consume", idle_worker)

    async def restart():
        restored = ChapterQueue(queue.documents)
        await restored.start()
        assert restored.books.summary(book["id"])["status"] == "paused"
        restored.books.control(book["id"], "resume")
        assert restored.get(first["id"])["status"] == "queued"
        task = restored.get(first["id"])
        task["status"], task["error_code"] = "paused_usage_limit", "limit"
        restored.save(task)
        restored.books.advance()
        assert restored.books.summary(book["id"])["status"] == "paused_usage_limit"
        assert restored.for_chapter(book["id"], book["chapters"][1]["id"]) is None
        await restored.stop()

    asyncio.run(restart())


def test_snapshot_revision_invalidates_same_length_edits_and_recovers_damage(setup_book):
    queue, book, _ = setup_book
    chapter_id = book["chapters"][0]["id"]
    task = complete(queue, queue.create(book["id"], chapter_id, "model"))
    queue.chapter(book["id"], chapter_id)
    queue.chapter(book["id"], chapter_id)  # first format extraction can change the source signature
    cache = queue.documents.folder(book["id"]) / f"reading-{chapter_id}.json"
    assert cache.exists()
    job = queue.jobs.get(task["chunks"][0]["job_id"])
    job["artifacts"]["accepted"]["segments"][0]["text"] = "新的中文。"
    queue.jobs.save(job["id"], "completed", job["artifacts"])
    assert queue.chapter(book["id"], chapter_id)["blocks"][0]["translation"]["text"] == "新的中文。"
    cache.write_text("broken derived cache")
    assert queue.chapter(book["id"], chapter_id)["blocks"][0]["translation"]["text"] == "新的中文。"
    cache.unlink()
    before = queue.publication.signature(book["id"], chapter_id)

    def racing_read(*args):
        queue.jobs.save(job["id"], "completed", job["artifacts"])
        return {"stale": True}

    queue.publication.chapter(book["id"], chapter_id, racing_read)
    assert before != queue.publication.signature(book["id"], chapter_id)
    assert not cache.exists()  # never attach a new signature to content read before that revision


def test_publication_failure_isolated_from_worker(setup_book, monkeypatch):
    queue, book, _ = setup_book
    for chapter in book["chapters"]:
        complete(queue, queue.create(book["id"], chapter["id"], "model"))
    queue.books.create(book["id"], "model")

    def failed_write(*args):
        raise OSError("disk full")

    monkeypatch.setattr(queue.publication, "publish", failed_write)
    queue.books.advance()
    assert queue.books.summary(book["id"])["status"] == "failed"


def test_library_badges_require_accepted_text_and_distinguish_complete_books(setup_book):
    queue, book, data = setup_book
    queue.documents.import_pdf(data, "second-alias", "Same Book")
    assert queue.books.library() == {}  # Extraction alone is not a translated edition.
    task = queue.create(book["id"], book["chapters"][0]["id"], "model")
    job = queue.jobs.start({"fixture": True}, "model")
    queue.jobs.save(job["id"], "running", {"draft": {"segments": [{"text": "未审校初稿"}]}})
    task["chunks"][0]["job_id"] = job["id"]
    queue.save(task)
    assert queue.books.library() == {}  # A draft must not advertise an approved translation.
    complete(queue, task)
    index = queue.books.library()
    assert (
        index["book"]
        == index["second-alias"]
        == {
            "completed": 1,
            "total": 3,
            "complete": False,
        }
    )
    for chapter in book["chapters"][1:]:
        complete(queue, queue.create(book["id"], chapter["id"], "model"))
    count = len(queue.jobs.list_jobs())
    assert queue.books.library()["book"] == {"completed": 3, "total": 3, "complete": True}
    assert len(queue.jobs.list_jobs()) == count
    assert queue.books.get(book["id"]) is None  # Manual chapter completion also earns the badge.
    task = queue.for_chapter(book["id"], book["chapters"][0]["id"])
    task["status"] = "needs_review"
    queue.save(task)
    assert queue.books.library()["book"]["complete"] is False
