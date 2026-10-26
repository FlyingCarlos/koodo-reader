"""Durable whole-book coordination over the existing single chapter worker."""

import json
import uuid

ACTIVE = {"queued", "running"}
STOPPED = {"paused", "failed", "paused_usage_limit", "needs_review"}


class BookQueue:
    def __init__(self, queue):
        self.queue = queue
        with queue.jobs.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS book_tasks (
                book_id TEXT PRIMARY KEY, id TEXT NOT NULL, model TEXT NOT NULL,
                status TEXT NOT NULL, current_chapter TEXT, error_code TEXT
            )""")

    def library(self):
        """One lightweight index for all visible library cards; never load job artifacts."""
        with self.queue.jobs.connect() as db:
            aliases = list(db.execute("SELECT key,book_id FROM book_aliases"))
            tasks = list(db.execute("SELECT book_id,chapter_id,status,chunks FROM chapter_tasks"))
            completed_jobs = {
                row["id"]
                for row in db.execute(
                    "SELECT id FROM jobs WHERE status='completed' "
                    "AND json_array_length(artifacts,'$.accepted.segments') > 0"
                )
            }
        grouped = {}
        eligible = {}
        for task in tasks:
            if task["book_id"] not in eligible:
                try:
                    eligible[task["book_id"]] = {
                        b["id"]
                        for b in self.queue.documents.get(task["book_id"])["blocks"]
                        if b["kind"] not in {"code", "image"}
                    }
                except (KeyError, ValueError):
                    eligible[task["book_id"]] = set()
            completed = sum(
                len(set(chunk["ids"]) & eligible[task["book_id"]])
                for chunk in json.loads(task["chunks"])
                if chunk["job_id"] in completed_jobs
            )
            grouped.setdefault(task["book_id"], {})[task["chapter_id"]] = {
                "completed": completed,
                "status": task["status"],
            }
        books = {}
        for book_id, chapters in grouped.items():
            if not any(c["completed"] for c in chapters.values()):
                continue
            try:
                book = self.queue.documents.get(book_id)
            except (KeyError, ValueError):
                continue
            translatable = [c for c in book["chapters"] if c["text_count"]]
            completed = sum(chapters.get(c["id"], {}).get("completed", 0) for c in translatable)
            total = sum(c["text_count"] for c in translatable)
            if not completed:
                continue
            complete = (
                bool(total)
                and completed == total
                and all(
                    chapters.get(c["id"], {}).get("status") == "completed" for c in translatable
                )
            )
            books[book_id] = {
                "completed": completed,
                "total": total,
                "complete": complete,
            }
        return {row["key"]: books[row["book_id"]] for row in aliases if row["book_id"] in books}

    def get(self, book_id):
        with self.queue.jobs.connect() as db:
            row = db.execute("SELECT * FROM book_tasks WHERE book_id=?", (book_id,)).fetchone()
        return dict(row) if row else None

    def save(self, task):
        with self.queue.jobs.connect() as db:
            db.execute(
                "UPDATE book_tasks SET status=?,current_chapter=?,error_code=? WHERE book_id=?",
                (task["status"], task["current_chapter"], task["error_code"], task["book_id"]),
            )

    def summary(self, book_id):
        book = self.queue.documents.get(book_id)
        task = self.get(book_id)
        chapters = []
        for chapter in book["chapters"]:
            if not chapter["text_count"]:
                continue
            child = self.queue.for_chapter(book_id, chapter["id"])
            summary = self.queue.summary(child)
            chapters.append(
                {
                    **chapter,
                    "status": summary["status"] if summary else "not_started",
                    "completed": summary["completed"] if summary else 0,
                    "total": summary["total"] if summary else chapter["text_count"],
                }
            )
        return {
            "id": task["id"] if task else None,
            "status": task["status"] if task else "not_started",
            "model": task["model"] if task else None,
            "current_chapter": task["current_chapter"] if task else None,
            "error_code": task["error_code"] if task else None,
            "chapters": chapters,
            "tables": self.queue.table_progress(book_id),
            "completed_chapters": sum(c["status"] == "completed" for c in chapters),
            "total_chapters": len(chapters),
            "completed": sum(c["completed"] for c in chapters),
            "total": sum(c["total"] for c in chapters),
        }

    def create(self, book_id, model):
        book = self.queue.documents.get(book_id)
        if not any(c["text_count"] for c in book["chapters"]):
            raise ValueError("本书没有可翻译的文字；图片和代码保留原样。")
        with self.queue.jobs.connect() as db:
            db.execute(
                "INSERT OR IGNORE INTO book_tasks(book_id,id,model,status) VALUES(?,?,?,?)",
                (book_id, str(uuid.uuid4()), model, "queued"),
            )
        return self.summary(book_id)

    def control(self, book_id, action):
        task = self.get(book_id)
        if not task:
            raise KeyError("尚未创建整本翻译任务。")
        current = self.queue.for_chapter(book_id, task["current_chapter"] or "")
        if action == "pause" and task["status"] in ACTIVE:
            task["status"] = "paused"
            self.save(task)
            if current:
                self.queue.pause(current["id"])
        elif action == "resume" and task["status"] in STOPPED:
            # Review failures remain explicit; no new model calls can overwrite them.
            if current and current["status"] == "needs_review":
                raise ValueError("当前章节仍有待复核译文，请先处理后继续。")
            if current:
                self.queue.resume(current["id"])
            task["status"], task["error_code"] = "queued", None
            self.save(task)
        elif action not in {"pause", "resume"}:
            raise KeyError("未知的整本任务操作。")
        return self.summary(book_id)

    def advance(self):
        with self.queue.jobs.connect() as db:
            active = [
                dict(row)
                for row in db.execute(
                    "SELECT * FROM book_tasks WHERE status IN ('queued','running') ORDER BY rowid"
                )
            ]
        for task in active:
            try:
                self._advance(task)
            except Exception as error:
                # A publication/I/O failure must not terminate the production consumer.
                task["status"], task["error_code"] = "failed", type(error).__name__
                self.save(task)

    def _advance(self, task):
        book = self.queue.documents.get(task["book_id"])
        for chapter in book["chapters"]:
            if not chapter["text_count"]:
                continue
            child = self.queue.for_chapter(book["id"], chapter["id"])
            if child and child["status"] == "completed":
                tables = self.queue.repair_tables(book["id"], chapter["id"])
                if tables["completed"] == tables["total"]:
                    continue
                child = self.queue.get(child["id"])
            if child and child["status"] in STOPPED:
                if task["current_chapter"] == chapter["id"] or child["status"] == "needs_review":
                    task["status"], task["error_code"] = child["status"], child["error_code"]
                    self.save(task)
                    return
                # First explicit book start includes resuming pre-existing unfinished chapters.
                self.queue.resume(child["id"])
            if not child:
                self.queue.create(book["id"], chapter["id"], task["model"])
            task["current_chapter"], task["status"] = chapter["id"], "running"
            self.save(task)
            return
        self.queue.publication.publish(book["id"])
        task["current_chapter"], task["status"], task["error_code"] = None, "completed", None
        self.save(task)
