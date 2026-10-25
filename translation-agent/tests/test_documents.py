import asyncio

import pymupdf
import pytest

from koodo_translation.chapters import ChapterQueue, batches
from koodo_translation.documents import (
    DocumentStore,
    chapter_ranges,
    image_regions,
    normalize_lines,
)
from koodo_translation.storage import state_directory


@pytest.fixture
def pdf_bytes():
    with pymupdf.open() as pdf:
        for index in range(3):
            page = pdf.new_page(width=500, height=800)
            page.insert_text((40, 26), f"{index + 1} Repeated header", fontsize=7)
            page.insert_text((40, 100), "A source-owned heading", fontsize=22)
            page.insert_text(
                (40, 160),
                "This is readable body text with enough characters "
                "to establish the body font size.",
                fontsize=11,
            )
            if index == 0:
                page.insert_text((40, 700), "This paragraph contin-", fontsize=11)
            if index == 1:
                page.insert_text((40, 75), "ues across the physical page boundary.", fontsize=11)
                page.insert_text((40, 220), "batch_size = 8", fontname="cour", fontsize=10)
        pdf.set_toc(
            [
                [1, "Book", 1],
                [2, "Chapter 0: Inference", 1],
                [3, "A source-owned heading", 1],
                [2, "Chapter 1: Models", 3],
            ]
        )
        return pdf.tobytes()


def test_real_pdf_extraction_outline_headers_code_and_cross_page(pdf_bytes, tmp_path):
    store = DocumentStore(state_directory(tmp_path))
    book = store.import_pdf(pdf_bytes, "reader-key", "Test Book")
    assert book["page_count"] == 3
    assert [(c["start_page"], c["end_page"]) for c in book["chapters"]] == [(1, 2), (3, 3)]
    assert all("Repeated header" not in node["text"] for node in book["blocks"])
    continued = next(n for n in book["blocks"] if "continues across" in n["text"])
    assert continued["page"] == 1 and continued["end_page"] == 2
    assert len(continued["anchors"]) == 2
    code = next(n for n in book["blocks"] if n["kind"] == "code")
    assert code["text"] == "batch_size = 8"
    assert book["outline"][1]["block_id"]
    again = store.import_pdf(pdf_bytes, "second-reader-key", "Test Book")
    assert again["id"] == book["id"]
    assert store.find("reader-key")["id"] == store.find("second-reader-key")["id"]
    assert (store.folder(book["id"]) / "source.pdf").stat().st_mode & 0o777 == 0o600


def test_mosaic_tiles_are_one_figure():
    class Page:
        rect = pymupdf.Rect(0, 0, 500, 800)

        def get_image_info(self):
            return [
                {"bbox": box}
                for box in [
                    (40, 100, 140, 200),
                    (139.8, 100, 240, 200),
                    (40, 199.8, 140, 300),
                    (139.8, 199.8, 240, 300),
                    (40, 400, 240, 500),
                ]
            ]

    regions = image_regions(Page())
    assert len(regions) == 2
    assert regions[0] == [40, 100, 240, 300]


def test_import_validation_and_unbookmarked_page_groups(tmp_path):
    store = DocumentStore(state_directory(tmp_path))
    with pytest.raises(ValueError):
        store.import_pdf(b"not a PDF", "test")
    with pytest.raises(ValueError):
        store.folder("../../credentials.json")
    groups = chapter_ranges([], 21)
    assert [(g["start_page"], g["end_page"]) for g in groups] == [(1, 10), (11, 20), (21, 21)]
    assert normalize_lines(["mar-", "ginal cost"]) == "marginal cost"


def test_chapter_batching_and_idempotent_queue(pdf_bytes, tmp_path):
    store = DocumentStore(state_directory(tmp_path))
    book = store.import_pdf(pdf_bytes, "test")
    queue = ChapterQueue(store)
    chapter = book["chapters"][0]
    task = queue.create(book["id"], chapter["id"], "test-model")
    assert queue.create(book["id"], chapter["id"], "test-model")["id"] == task["id"]
    with pytest.raises(ValueError, match="模型"):
        queue.create(book["id"], chapter["id"], "other-model")
    grouped = batches([n for n in book["blocks"] if n["chapter_id"] == chapter["id"]])
    assert all(len(group) <= 96 for group in grouped)
    code_ids = {node["id"] for node in book["blocks"] if node["kind"] == "code"}
    assert code_ids.isdisjoint(block_id for group in grouped for block_id in group)
    assert queue.pause(task["id"])["status"] == "paused"
    assert queue.resume(task["id"])["status"] == "queued"
    assert queue.chapter(book["id"], chapter["id"])["task"]["total"] == chapter["text_count"]


def test_restart_recovers_running_but_keeps_paused_tasks(pdf_bytes, tmp_path, monkeypatch):
    async def idle_worker(self):
        await asyncio.Event().wait()

    monkeypatch.setattr(ChapterQueue, "_consume", idle_worker)
    store = DocumentStore(state_directory(tmp_path))
    book = store.import_pdf(pdf_bytes, "test")
    queue = ChapterQueue(store)
    task = queue.create(book["id"], book["chapters"][0]["id"], "test-model")
    task["status"] = "running"
    queue.save(task)
    paused = queue.create(book["id"], book["chapters"][1]["id"], "test-model")
    queue.pause(paused["id"])

    async def restart():
        recovered = ChapterQueue(store)
        await recovered.start()
        assert recovered.get(task["id"])["status"] == "queued"
        assert recovered.get(paused["id"])["status"] == "paused"
        await recovered.stop()

    asyncio.run(restart())
