"""Persistent chapter queue; the existing Agents SDK workflow translates each batch."""

import asyncio
import json
import uuid

from openai import AsyncOpenAI

from .auth import API, ChatGPTAuth
from .batching import SOURCE_MODE, batches, replan_unstarted, segment_payload
from .books import BookQueue
from .documents import DocumentStore
from .formatting import align_page, fingerprint, page_presentation, source_formats
from .publication import PublicationStore
from .storage import exclusive_lock, write_private_json
from .toc import toc_block_ids
from .workflow import TranslationInput, translate_job

GLOSSARY = {
    "inference": "推理",
    "latency": "延迟",
    "throughput": "吞吐量",
    "batch size": "批大小",
    "inference engine": "推理引擎",
    "inference engineering": "推理工程",
    "foundation model": "基础模型",
    "fine-tuning": "微调",
    "distillation": "蒸馏",
    "weights": "权重",
    "parameters": "参数",
    "token": "token",
    "deployment": "部署",
    "quantization": "量化",
    "attention": "注意力",
    "KV cache": "KV 缓存",
    "prefill": "预填充",
    "decode": "解码",
}


class ChapterQueue:
    def __init__(self, documents: DocumentStore):
        self.documents = documents
        self.jobs = documents.jobs
        self.auth = ChatGPTAuth(documents.directory)
        self.active: asyncio.Task | None = None
        self.active_id: str | None = None
        self.consumer: asyncio.Task | None = None
        self.stopping = False
        self.operation_lock = asyncio.Lock()
        with self.jobs.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS chapter_tasks (
                id TEXT PRIMARY KEY, book_id TEXT NOT NULL, chapter_id TEXT NOT NULL,
                model TEXT NOT NULL, status TEXT NOT NULL, chunks TEXT NOT NULL,
                glossary TEXT NOT NULL, error_code TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(book_id,chapter_id)
            )""")
            if "revision" not in {row[1] for row in db.execute("PRAGMA table_info(chapter_tasks)")}:
                db.execute(
                    "ALTER TABLE chapter_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
                )
        self.publication = PublicationStore(self)
        self.books = BookQueue(self)

    def get(self, task_id: str) -> dict:
        with self.jobs.connect() as db:
            row = db.execute("SELECT * FROM chapter_tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            raise KeyError("找不到章节任务。")
        task = dict(row)
        task["chunks"] = json.loads(task["chunks"])
        task["glossary"] = json.loads(task["glossary"])
        return task

    def for_chapter(self, book_id: str, chapter_id: str) -> dict | None:
        with self.jobs.connect() as db:
            row = db.execute(
                "SELECT id FROM chapter_tasks WHERE book_id=? AND chapter_id=?",
                (book_id, chapter_id),
            ).fetchone()
        return self.get(row["id"]) if row else None

    def save(self, task: dict):
        with self.jobs.connect() as db:
            db.execute(
                "UPDATE chapter_tasks SET status=?,chunks=?,error_code=?,"
                "updated_at=CURRENT_TIMESTAMP,revision=revision+1 WHERE id=?",
                (
                    task["status"],
                    json.dumps(task["chunks"]),
                    task.get("error_code"),
                    task["id"],
                ),
            )

    def create(self, book_id: str, chapter_id: str, model: str) -> dict:
        existing = self.for_chapter(book_id, chapter_id)
        if existing:
            if existing["model"] != model:
                raise ValueError("本章已绑定其他模型，请使用原模型继续，避免覆盖已有译文。")
            return existing
        book = self.documents.get(book_id)
        if not any(chapter["id"] == chapter_id for chapter in book["chapters"]):
            raise KeyError("找不到该章节。")
        groups = batches([b for b in book["blocks"] if b["chapter_id"] == chapter_id])
        if not groups:
            raise ValueError("本章没有可翻译的文字。")
        task_id = str(uuid.uuid4())
        with self.jobs.connect() as db:
            db.execute(
                "INSERT INTO chapter_tasks(id,book_id,chapter_id,model,status,chunks,glossary) "
                "VALUES(?,?,?,?,?,?,?)",
                (
                    task_id,
                    book_id,
                    chapter_id,
                    model,
                    "queued",
                    json.dumps(
                        [
                            {"ids": group, "job_id": None, "source_mode": SOURCE_MODE}
                            for group in groups
                        ]
                    ),
                    json.dumps(GLOSSARY, ensure_ascii=False),
                ),
            )
        return self.get(task_id)

    def summary(self, task: dict | None) -> dict | None:
        if task is None:
            return None
        finished, drafted, total, review_count, completed_batches = 0, 0, 0, 0, 0
        ids = [chunk["job_id"] for chunk in task["chunks"] if chunk["job_id"]]
        progress = {}
        if ids:
            placeholders = ",".join("?" for _ in ids)
            with self.jobs.connect() as db:
                progress = {
                    row["id"]: row
                    for row in db.execute(
                        "SELECT id,status,"
                        "json_array_length(artifacts,'$.draft.segments') AS drafted "
                        f"FROM jobs WHERE id IN ({placeholders})",
                        ids,
                    )
                }
        for chunk in task["chunks"]:
            total += len(chunk["ids"])
            job = progress.get(chunk["job_id"])
            if job:
                if job["drafted"]:
                    drafted += len(chunk["ids"])
                if job["status"] == "completed":
                    finished += len(chunk["ids"])
                    completed_batches += 1
                if job["status"] == "needs_review":
                    review_count += len(chunk["ids"])
        return {
            "id": task["id"],
            "status": task["status"],
            "model": task["model"],
            "total": total,
            "completed": finished,
            "drafted": drafted,
            "needs_review": review_count,
            "error_code": task.get("error_code"),
            "batch_count": len(task["chunks"]),
            "completed_batches": completed_batches,
        }

    def chapter(self, book_id: str, chapter_id: str) -> dict:
        return self.publication.chapter(book_id, chapter_id, self._chapter)

    def _chapter(self, book_id: str, chapter_id: str) -> dict:
        book = self.documents.get(book_id)
        chapter = next((c for c in book["chapters"] if c["id"] == chapter_id), None)
        if not chapter:
            raise KeyError("找不到该章节。")
        task = self.for_chapter(book_id, chapter_id)
        translations = {}
        if task:
            for chunk in task["chunks"]:
                if not chunk["job_id"]:
                    continue
                job = self.jobs.get(chunk["job_id"])
                artifacts = job["artifacts"]
                output = (
                    artifacts.get("accepted") or artifacts.get("revision") or artifacts.get("draft")
                )
                for segment in (output or {}).get("segments", []):
                    translations[segment["segment_id"]] = {
                        "text": segment["text"],
                        "status": "accepted"
                        if artifacts.get("accepted")
                        else ("needs_review" if job["status"] == "needs_review" else "draft"),
                    }
        nodes = [node for node in book["blocks"] if node["chapter_id"] == chapter_id]
        folder = self.documents.folder(book_id)
        formats = source_formats(folder, book, sorted({n["page"] for n in nodes}))
        for page, source in formats.items():
            texts = {
                n["id"]: translations[n["id"]]["text"]
                for n in nodes
                if n["page"] == int(page) and n["id"] in translations
            }
            saved_path = folder / f"page-format-{int(page):04d}.json"
            saved = json.loads(saved_path.read_text()) if saved_path.exists() else None
            formats[page] = page_presentation(source, texts, saved)
        return {
            "chapter": chapter,
            "task": self.summary(task),
            "page_formats": formats,
            "blocks": [
                {**node, "translation": translations.get(node["id"])}
                for node in book["blocks"]
                if node["chapter_id"] == chapter_id
            ],
        }

    async def format_page(self, book_id: str, chapter_id: str, page: int):
        # Share the production worker's execution slot. Formatting never changes
        # translation jobs, accepted text, document IDs, or source PDFs.
        async with self.operation_lock:
            with exclusive_lock(self.documents.directory / "worker.lock"):
                content = self.chapter(book_id, chapter_id)
                source = content["page_formats"].get(str(page))
                if not source:
                    raise ValueError("本页不属于当前章节。")
                if source["status"] == "ready":
                    return source
                source = {
                    k: v
                    for k, v in source.items()
                    if k not in {"status", "translated_marks", "translated_cells", "toc_entries"}
                }
                nodes = [n for n in content["blocks"] if n["page"] == page]
                texts = {n["id"]: n["translation"]["text"] for n in nodes if n["translation"]}
                if any(n["kind"] not in {"image", "code"} and n["id"] not in texts for n in nodes):
                    raise ValueError("请先完成本页翻译，再恢复格式；已有译文会直接复用。")
                model = content["task"]["model"] if content["task"] else None
                if not model:
                    raise ValueError("请先翻译本页。")
                saved_path = self.documents.folder(book_id) / f"page-format-{page:04d}.json"
                saved = json.loads(saved_path.read_text()) if saved_path.exists() else {}
                digest = fingerprint(source, texts)
                resume = saved.get("job_id") if saved.get("fingerprint") == digest else None
                job = self.jobs.start(
                    {"format_version": 1, "source": source, "texts": texts}, model, resume
                )
                write_private_json(saved_path, {"fingerprint": digest, "job_id": job["id"]})
                if source["marks"] or source["tables"]:
                    async with AsyncOpenAI(
                        api_key=self.auth.access_token, base_url=API, max_retries=0
                    ) as client:
                        output = await align_page(source, texts, model, client, self.jobs, job)
                else:
                    output = {"marks": {}, "cells": {}}
                    self.jobs.save(job["id"], "completed", {"format": output, "usage": []})
                saved = {**output, "fingerprint": digest, "job_id": job["id"]}
                write_private_json(saved_path, saved)
                return page_presentation(source, texts, saved)

    def pause(self, task_id: str):
        task = self.get(task_id)
        if task["status"] in {"queued", "running"}:
            task["status"] = "paused"
            self.save(task)
            if self.active_id == task_id and self.active:
                self.active.cancel()
        return self.summary(self.get(task_id))

    def resume(self, task_id: str):
        task = self.get(task_id)
        if task["status"] in {"paused", "failed", "paused_usage_limit"}:
            task["status"], task["error_code"] = "queued", None
            self.save(task)
        return self.summary(self.get(task_id))

    async def start(self):
        with self.jobs.connect() as db:
            db.execute(
                "UPDATE chapter_tasks SET status='queued',revision=revision+1 "
                "WHERE status='running'"
            )
        self.consumer = asyncio.create_task(self._consume())

    async def stop(self):
        self.stopping = True
        if self.active:
            self.active.cancel()
        if self.consumer:
            self.consumer.cancel()
            await asyncio.gather(self.consumer, return_exceptions=True)

    async def _consume(self):
        while not self.stopping:
            self.books.advance()
            with self.jobs.connect() as db:
                row = db.execute(
                    "SELECT id FROM chapter_tasks WHERE status='queued' "
                    "ORDER BY created_at,id LIMIT 1"
                ).fetchone()
            if not row:
                await asyncio.sleep(0.75)
                continue
            self.active_id = row["id"]
            self.active = asyncio.create_task(self._run_task(row["id"]))
            try:
                await self.active
            except asyncio.CancelledError:
                task = self.get(row["id"])
                if self.stopping:
                    if task["status"] == "running":
                        task["status"] = "queued"
                        self.save(task)
                    raise
            finally:
                self.active, self.active_id = None, None

    async def _run_task(self, task_id: str):
        async with self.operation_lock:
            await self._run_translation_task(task_id)

    async def _run_translation_task(self, task_id: str):
        task = self.get(task_id)
        try:
            with exclusive_lock(self.documents.directory / "worker.lock"):
                task["status"] = "running"
                self.save(task)
                book = self.documents.get(task["book_id"])
                chapter = next(c for c in book["chapters"] if c["id"] == task["chapter_id"])
                nodes = {node["id"]: node for node in book["blocks"]}
                contents = toc_block_ids(book["blocks"])
                planned = replan_unstarted(task["chunks"], nodes)
                if planned != task["chunks"]:
                    task["chunks"] = planned
                    self.save(task)
                async with AsyncOpenAI(
                    api_key=self.auth.access_token, base_url=API, max_retries=0
                ) as client:
                    for chunk in task["chunks"]:
                        source = TranslationInput.model_validate(
                            {
                                "book_title": book["title"],
                                "chapter_title": chapter["title"],
                                "glossary": task["glossary"],
                                "segments": [
                                    segment_payload(
                                        nodes[block_id],
                                        chunk.get("source_mode"),
                                        is_toc=block_id in contents,
                                    )
                                    for block_id in chunk["ids"]
                                ],
                            }
                        )
                        job = self.jobs.start(source.model_dump(), task["model"], chunk["job_id"])
                        if not chunk["job_id"]:
                            chunk["job_id"] = job["id"]
                            self.save(task)
                        await translate_job(source, task["model"], client, self.jobs, job["id"])
                jobs = [self.jobs.get(chunk["job_id"]) for chunk in task["chunks"]]
                task["status"] = (
                    "needs_review"
                    if any(job["status"] == "needs_review" for job in jobs)
                    else "completed"
                )
                self.save(task)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            code = getattr(error, "code", None) or type(error).__name__
            task["error_code"] = str(code)
            task["status"] = (
                "paused_usage_limit"
                if code == ("subscription_sharing_usage_limit_exceeded")
                else "failed"
            )
            self.save(task)
