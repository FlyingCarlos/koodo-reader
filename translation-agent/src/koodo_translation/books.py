"""Durable whole-book coordination over the existing single chapter worker."""

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
                continue
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
