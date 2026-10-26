"""Versioned reading snapshots and portable original-book bilingual companions."""

import hashlib
import json
import os
import re
import tempfile
import zipfile
from pathlib import Path

from .storage import write_private_json


class PublicationStore:
    def __init__(self, queue):
        self.queue = queue

    def signature(self, book_id, chapter_id):
        folder = self.queue.documents.folder(book_id)
        if not re.fullmatch(r"chapter-\d{4}", chapter_id):
            raise KeyError("无效的章节标识。")
        with self.queue.jobs.connect() as db:
            row = db.execute(
                "SELECT id,revision,chunks FROM chapter_tasks WHERE book_id=? AND chapter_id=?",
                (book_id, chapter_id),
            ).fetchone()
            jobs = []
            if row:
                ids = [c["job_id"] for c in json.loads(row["chunks"]) if c["job_id"]]
                if ids:
                    placeholders = ",".join("?" for _ in ids)
                    jobs = [
                        tuple(j)
                        for j in db.execute(
                            f"SELECT id,revision FROM jobs WHERE id IN ({placeholders}) "
                            "ORDER BY id",
                            ids,
                        )
                    ]
        files = [
            folder / "document.json",
            folder / "source-format-v1.json",
            folder / "source-structure-v1.json",
        ]
        files += sorted(folder.glob("page-format-*.json"))
        stamps = [(p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in files if p.exists()]
        value = [4, (row["id"], row["revision"]) if row else None, jobs, stamps]
        return hashlib.sha256(json.dumps(value).encode()).hexdigest()

    def chapter(self, book_id, chapter_id, build):
        folder = self.queue.documents.folder(book_id)
        signature = self.signature(book_id, chapter_id)
        # A finished portable file can serve a chapter directly, without loading job artifacts.
        bundle = folder / "bilingual.koodo.zip"
        if bundle.exists():
            try:
                with zipfile.ZipFile(bundle) as archive:
                    manifest = json.loads(archive.read("manifest.json"))
                    if manifest["signatures"].get(chapter_id) == signature:
                        return json.loads(archive.read(f"chapters/{chapter_id}.json"))
            except (OSError, ValueError, KeyError, TypeError, AttributeError, zipfile.BadZipFile):
                pass  # A damaged derived artifact never hides the authoritative task state.
        cache = folder / f"reading-{chapter_id}.json"
        if cache.exists():
            try:
                saved = json.loads(cache.read_text())
                if saved["signature"] == signature:
                    return saved["content"]
            except (OSError, ValueError, KeyError):
                pass
        content = build(book_id, chapter_id)
        after = self.signature(book_id, chapter_id)
        if after == signature:
            write_private_json(cache, {"signature": signature, "content": content})
        return content

    def publish(self, book_id):
        book = self.queue.documents.get(book_id)
        folder = self.queue.documents.folder(book_id)
        for _ in range(3):
            before = {c["id"]: self.signature(book_id, c["id"]) for c in book["chapters"]}
            contents = {c["id"]: self.queue.chapter(book_id, c["id"]) for c in book["chapters"]}
            after = {c: self.signature(book_id, c) for c in contents}
            if before == after:
                break
        else:
            raise ValueError("译文正在更新，请稍后重试导出；已有结果仍然保留。")
        tables = [
            p
            for content in contents.values()
            for p in content["page_formats"].values()
            if p["tables"]
        ]
        complete = all(p["status"] == "ready" for p in tables) and all(
            not c["text_count"]
            or contents[c["id"]]["task"]
            and contents[c["id"]]["task"]["status"] == "completed"
            for c in book["chapters"]
        )
        # Compute after source-format extraction, which can create its cache during first read.
        manifest = {
            "format": "koodo-bilingual",
            "version": 1,
            "book_id": book_id,
            "source_hash": book["source_hash"],
            "title": book["title"],
            "source_language": "en",
            "target_language": "zh-CN",
            "status": "completed" if complete else "partial",
            "table_presentation": {
                "total": len(tables),
                "completed": sum(p["status"] == "ready" for p in tables),
            },
            "original": "source.pdf",
            "cover": {"source": "source.pdf", "page": 1},
            "chapters": book["chapters"],
            "signatures": after,
            "notes": "Notes stay in the reader library; source IDs and offsets are retained.",
        }
        target = folder / "bilingual.koodo.zip"
        fd, temporary = tempfile.mkstemp(dir=folder, prefix=".bundle-")
        os.close(fd)
        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
                archive.write(folder / "source.pdf", "source.pdf")
                archive.write(folder / "document.json", "document.json")
                for chapter_id, content in contents.items():
                    archive.writestr(
                        f"chapters/{chapter_id}.json", json.dumps(content, ensure_ascii=False)
                    )
                for path in [
                    folder / "source-format-v1.json",
                    folder / "source-structure-v1.json",
                    *folder.glob("page-format-*.json"),
                ]:
                    if path.exists():
                        # Export display metadata, never private Agent job IDs or credentials.
                        data = json.loads(path.read_text())
                        data.pop("job_id", None)
                        archive.writestr(path.name, json.dumps(data, ensure_ascii=False))
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
        return target
