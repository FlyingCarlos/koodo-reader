import asyncio
import copy
import json
import zipfile

import pymupdf
import pytest

from koodo_translation.chapters import ChapterQueue
from koodo_translation.documents import DocumentStore
from koodo_translation.formatting import FormatAlignment, source_formats, validate_alignment
from koodo_translation.storage import state_directory


@pytest.fixture
def table_book(tmp_path, monkeypatch):
    store = DocumentStore(state_directory(tmp_path))
    with pymupdf.open() as pdf:
        for _ in range(2):
            page = pdf.new_page(width=500, height=600)
            page.insert_text((40, 100), "A paragraph outside the table.")
            for x in [40, 240, 440]:
                page.draw_line((x, 160), (x, 240))
            for y in [160, 200, 240]:
                page.draw_line((40, y), (440, y))
            for x, y, text in [
                (50, 185, "Metric"),
                (250, 185, "Meaning"),
                (50, 225, "P50"),
                (250, 225, "Median latency"),
            ]:
                page.insert_text((x, y), text)
        pdf.set_toc([[1, "Chapter 1: Tables", 1]])
        data = pdf.tobytes()
    book = store.import_pdf(data, "tables", "Table Fixture")
    queue = ChapterQueue(store)
    chapter_id = book["chapters"][0]["id"]
    task = queue.create(book["id"], chapter_id, "test-model")
    formats = source_formats(store.folder(book["id"]), book, [1, 2])
    texts = {b["id"]: "已有正文😀。" for b in book["blocks"]}
    for page, presentation in formats.items():
        cells_by_block = {}
        for table in presentation["tables"]:
            for cell in table["cells"]:
                for block_id in cell["block_ids"]:
                    cells_by_block.setdefault(block_id, []).append(f"译{page}-{cell['id']}")
        texts.update({block_id: " ".join(parts) for block_id, parts in cells_by_block.items()})
    monkeypatch.setattr(
        "koodo_translation.auth.ChatGPTAuth.access_token", property(lambda _: "fixture")
    )

    async def accepted_translation(source, model, client, jobs, job_id):
        job = jobs.get(job_id)
        if job["status"] != "completed":
            jobs.save(
                job_id,
                "completed",
                {
                    "accepted": {
                        "segments": [
                            {"segment_id": segment.id, "text": texts[segment.id]}
                            for segment in source.segments
                        ]
                    }
                },
            )
        return jobs.get(job_id)

    monkeypatch.setattr("koodo_translation.chapters.translate_job", accepted_translation)
    calls = []
    fail = {"page2": False}

    async def align(source, translated, model, client, jobs, job):
        page = source["tables"][0]["id"].split("-")[0]
        calls.append(page)
        assert queue.get(task["id"])["status"] == "running"
        assert queue.summary(queue.get(task["id"]))["phase"] == "formatting"
        if page == "p0002" and fail.get("wait"):
            fail["started"].set()
            await fail["wait"].wait()
        if page == "p0002" and fail["page2"]:
            raise ValueError("fixture format validation failed")
        result = validate_alignment(
            source,
            translated,
            FormatAlignment.model_validate(
                {
                    "marks": [],
                    "cells": [
                        {
                            "cell_id": cell["id"],
                            "parts": [
                                {
                                    "block_id": block_id,
                                    "quote": f"译{int(page[1:])}-{cell['id']}",
                                    "occurrence": 0,
                                }
                                for block_id in cell["block_ids"]
                            ],
                        }
                        for table in source["tables"]
                        for cell in table["cells"]
                    ],
                }
            ),
        )
        jobs.save(job["id"], "completed", {"format": result})
        return result

    monkeypatch.setattr("koodo_translation.chapters.align_page", align)
    return queue, book, task, calls, fail, texts


async def test_new_chapter_restores_every_table_before_reporting_completion(table_book):
    queue, book, task, calls, _, texts = table_book
    await queue._run_task(task["id"])
    assert queue.get(task["id"])["status"] == "completed"
    assert calls == ["p0001", "p0002"]
    content = queue.chapter(book["id"], task["chapter_id"])
    assert all(p["status"] == "ready" for p in content["page_formats"].values())
    assert {b["id"]: b["translation"]["text"] for b in content["blocks"]} == texts
    progress = queue.table_progress(book["id"])
    assert progress["total"] == progress["completed"] == 2


def remove_presentation(queue, book):
    for path in queue.documents.folder(book["id"]).glob("page-format-*.json"):
        path.unlink()


async def test_old_completed_chapter_backfill_keeps_jobs_and_invalidates_export(table_book):
    queue, book, task, calls, _, texts = table_book
    await queue._run_task(task["id"])
    remove_presentation(queue, book)
    before = copy.deepcopy(queue.get(task["id"])["chunks"])
    translation_jobs = {c["job_id"]: queue.jobs.get(c["job_id"]) for c in before}
    old = queue.publication.publish(book["id"])
    with zipfile.ZipFile(old) as archive:
        assert json.loads(archive.read("manifest.json"))["status"] == "partial"
        assert json.loads(archive.read("manifest.json"))["table_presentation"]["completed"] == 0
    calls.clear()
    queue.repair_tables(book["id"])
    assert queue.summary(queue.get(task["id"]))["phase"] == "formatting"
    await queue._run_task(task["id"])
    assert calls == ["p0001", "p0002"]
    assert queue.get(task["id"])["chunks"] == before
    for job_id, original in translation_jobs.items():
        assert queue.jobs.get(job_id) == original
    content = queue.chapter(book["id"], task["chapter_id"])
    assert {b["id"]: b["translation"]["text"] for b in content["blocks"]} == texts
    assert content["page_formats"]["1"]["status"] == "ready"  # old ZIP cannot hide new cells
    with zipfile.ZipFile(queue.publication.publish(book["id"])) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["status"] == "completed"
        assert manifest["table_presentation"] == {"total": 2, "completed": 2}


async def test_format_failure_is_visible_and_resume_keeps_completed_pages(table_book):
    queue, book, task, calls, fail, _ = table_book
    fail["page2"] = True
    await queue._run_task(task["id"])
    summary = queue.summary(queue.get(task["id"]))
    assert summary["status"] == "failed" and summary["phase"] == "formatting"
    assert summary["completed"] == summary["total"]
    assert queue.table_progress(book["id"])["completed"] == 1
    fail["page2"] = False
    queue.resume(task["id"])
    await queue._run_task(task["id"])
    assert calls == ["p0001", "p0002", "p0002"]
    assert queue.get(task["id"])["status"] == "completed"


async def test_whole_book_does_not_skip_legacy_pending_tables(table_book):
    queue, book, task, _, _, _ = table_book
    await queue._run_task(task["id"])
    remove_presentation(queue, book)
    queue.books.create(book["id"], "test-model")
    queue.books.advance()
    assert queue.get(task["id"])["status"] == "queued"
    assert queue.books.summary(book["id"])["status"] == "running"
    await queue._run_task(task["id"])
    queue.books.advance()
    assert queue.books.summary(book["id"])["status"] == "completed"
    assert queue.books.summary(book["id"])["tables"]["completed"] == 2


async def test_pause_and_restart_during_table_restoration_keep_page_checkpoints(
    table_book, monkeypatch
):
    queue, book, task, calls, fail, _ = table_book
    fail.update({"wait": asyncio.Event(), "started": asyncio.Event()})
    queue.active_id = task["id"]
    queue.active = asyncio.create_task(queue._run_task(task["id"]))
    await asyncio.wait_for(fail["started"].wait(), 2)
    queue.pause(task["id"])
    await asyncio.gather(queue.active, return_exceptions=True)
    assert queue.get(task["id"])["status"] == "paused"
    assert queue.table_progress(book["id"])["completed"] == 1

    async def idle_worker(self):
        await asyncio.Event().wait()

    monkeypatch.setattr(ChapterQueue, "_consume", idle_worker)
    restarted = ChapterQueue(queue.documents)
    await restarted.start()
    assert restarted.get(task["id"])["status"] == "paused"
    fail["wait"].set()
    restarted.resume(task["id"])
    await restarted._run_task(task["id"])
    assert calls == ["p0001", "p0002", "p0002"]
    assert restarted.table_progress(book["id"])["completed"] == 2
    await restarted.stop()
