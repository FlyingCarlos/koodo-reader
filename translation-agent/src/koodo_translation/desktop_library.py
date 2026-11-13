"""Sync immutable translation snapshots alongside the iCloud desktop library."""

import hashlib
import json
import os
import re
import shutil
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

from .documents import EXTRACTION_VERSION, MAX_PDF_BYTES
from .storage import write_private_json

SNAPSHOT = re.compile(r"([a-f0-9]{64})-([a-f0-9]{64})\.sqlite3")
CHAPTER = re.compile(r"chapter-\d{4}")
ACTIVE = {"queued", "running"}
MAX_SNAPSHOT = 96 * 1024 * 1024


def read_database(path):
    return sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=2)


def pdfs(library):
    with closing(read_database(library / "config/books.db")) as db:
        return list(db.execute("SELECT key, size, md5, path FROM books WHERE format='PDF'"))


def json_bytes(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def chapter_score(task, jobs):
    accepted = 0
    for chunk in json.loads(task["chunks"]):
        job = jobs.get(chunk["job_id"])
        if job and job["status"] == "completed":
            accepted += len(json.loads(job["artifacts"]).get("accepted", {}).get("segments", []))
    return accepted, task["updated_at"], task["revision"], task["id"]


def insert(db, table, row):
    columns = [column[1] for column in db.execute(f"PRAGMA table_info({table})")]
    db.execute(
        f"INSERT INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
        [row[column] for column in columns],
    )


class DesktopLibrary:
    def __init__(self, queue, cloud=None, library=None):
        self.queue = queue
        self.store = queue.documents
        self.cloud = cloud or (
            Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/koodoreader"
        )
        self.library = library or self.store.directory.parent / "uploads/data"
        self.snapshots = self.cloud / "translation"
        self.hashes = {}
        self.seen = set()

    def hash_pdf(self, path, size):
        stat = path.stat()
        if stat.st_size != size or not 0 < size <= MAX_PDF_BYTES:
            raise ValueError("PDF size differs from library record")
        stamp = stat.st_ino, stat.st_size, stat.st_mtime_ns
        if path not in self.hashes or self.hashes[path][0] != stamp:
            with path.open("rb") as file:
                self.hashes[path] = stamp, hashlib.file_digest(file, "sha256").hexdigest()
        return self.hashes[path][1]

    def sync(self):
        try:
            cloud_pdfs = {}
            for key, size, md5, _ in pdfs(self.cloud):
                if key.isdecimal() and md5:
                    cloud_pdfs.setdefault((size, md5), []).append(
                        self.cloud / "book" / f"{key}.pdf"
                    )
            local_pdfs = pdfs(self.library)
            if not self.snapshots.exists():
                self.snapshots.mkdir(mode=0o700, exist_ok=True)
            snapshots = {}
            for path in self.snapshots.iterdir():
                match = SNAPSHOT.fullmatch(path.name)
                if match:
                    snapshots.setdefault(match[1], []).append(path)
        except (OSError, sqlite3.Error):
            return

        for key, size, md5, original_path in local_pdfs:
            if not key.isdecimal() or (size, md5) not in cloud_pdfs:
                continue
            source = self.library / "book" / f"{key}.pdf"
            if not source.is_file():
                source = Path(original_path or "")
            try:
                source_hash = self.hash_pdf(source, size)
                book_id = hashlib.sha256((source_hash + EXTRACTION_VERSION).encode()).hexdigest()
                for snapshot in sorted(snapshots.get(source_hash, [])):
                    applied = key, snapshot.name
                    if applied not in self.seen and self.receive(snapshot, source, key, book_id):
                        self.seen.add(applied)
                if (self.store.folder(book_id) / "document.json").is_file() and any(
                    candidate.is_file() and self.hash_pdf(candidate, size) == source_hash
                    for candidate in cloud_pdfs[size, md5]
                ):
                    self.publish(key, book_id, source_hash)
            except (OSError, sqlite3.Error, KeyError, TypeError, ValueError):
                continue

    def publish(self, key, book_id, source_hash):
        folder = self.store.folder(book_id)
        with closing(self.queue.jobs.connect()) as db:
            db.execute("BEGIN")
            if not db.execute(
                "SELECT 1 FROM book_aliases WHERE key=? AND book_id=?", (key, book_id)
            ).fetchone():
                return
            chapters = {}
            for row in db.execute(
                "SELECT * FROM chapter_tasks WHERE book_id=? ORDER BY chapter_id", (book_id,)
            ):
                task = dict(row)
                if task["status"] in ACTIVE:
                    continue
                ids = {chunk["job_id"] for chunk in json.loads(task["chunks"]) if chunk["job_id"]}
                jobs = {}
                for job_id in ids:
                    job = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
                    if job:
                        jobs[job_id] = dict(job)
                if len(jobs) == len(ids) and chapter_score(task, jobs)[0]:
                    chapters[task["chapter_id"]] = {"task": task, "jobs": jobs}
        if not chapters:
            return
        document = json.loads((folder / "document.json").read_text())
        if document["source_hash"] != source_hash:
            return
        files = {
            p.name: json.loads(p.read_text())
            for p in sorted(folder.glob("page-format-*.json"))
            if re.fullmatch(r"page-format-\d+\.json", p.name)
        }
        layout = folder / "layout-overrides-v1.json"
        if layout.is_file():
            files[layout.name] = json.loads(layout.read_text())
        payload = json_bytes(
            {"version": 1, "document": document, "chapters": chapters, "files": files}
        )
        if len(payload) > MAX_SNAPSHOT:
            return
        digest = hashlib.sha256(payload).hexdigest()
        target = self.snapshots / f"{source_hash}-{digest}.sqlite3"
        self.seen.add((key, target.name))
        if target.exists():
            return
        fd, name = tempfile.mkstemp(dir=self.snapshots, prefix=".snapshot-")
        os.close(fd)
        temporary = Path(name)
        try:
            with closing(sqlite3.connect(temporary)) as db, db:
                db.execute(
                    "CREATE TABLE translation (source_sha256 TEXT PRIMARY KEY, payload BLOB)"
                )
                db.execute("INSERT INTO translation VALUES (?, ?)", (source_hash, payload))
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)

    def receive(self, snapshot, source, key, book_id):
        source_hash, digest = SNAPSHOT.fullmatch(snapshot.name).groups()
        if snapshot.is_symlink() or snapshot.stat().st_size > MAX_SNAPSHOT + 1024 * 1024:
            return False
        with closing(read_database(snapshot)) as db:
            db.execute("PRAGMA trusted_schema=OFF")
            row = db.execute(
                "SELECT payload FROM translation WHERE source_sha256=?", (source_hash,)
            ).fetchone()
        if not row or hashlib.sha256(row[0]).hexdigest() != digest:
            return False
        payload = json.loads(row[0])
        document = payload["document"]
        if (
            payload["version"] != 1
            or document["source_hash"] != source_hash
            or document["id"] != book_id
            or document["extractor_version"] != EXTRACTION_VERSION
        ):
            return False

        folder = self.store.folder(book_id)
        deferred = False
        with closing(self.queue.jobs.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            folder.mkdir(mode=0o700, exist_ok=True)
            manifest = folder / "document.json"
            if not manifest.exists():
                fd, temporary = tempfile.mkstemp(dir=folder, prefix=".pdf-")
                os.close(fd)
                try:
                    shutil.copyfile(source, temporary)
                    if self.hash_pdf(Path(temporary), source.stat().st_size) != source_hash:
                        raise ValueError("PDF changed during snapshot import")
                    os.replace(temporary, folder / "source.pdf")
                finally:
                    self.hashes.pop(Path(temporary), None)
                    Path(temporary).unlink(missing_ok=True)
                write_private_json(manifest, document)
            db.execute(
                "INSERT INTO book_aliases VALUES (?,?) ON CONFLICT(key) "
                "DO UPDATE SET book_id=excluded.book_id",
                (key, book_id),
            )

            imported = False
            for chapter_id, record in payload["chapters"].items():
                task, jobs = record["task"], record["jobs"]
                if (
                    not CHAPTER.fullmatch(chapter_id)
                    or task["book_id"] != book_id
                    or task["chapter_id"] != chapter_id
                    or task["status"] in ACTIVE
                ):
                    continue
                incoming = chapter_score(task, jobs)
                if not incoming[0]:
                    continue
                existing = db.execute(
                    "SELECT * FROM chapter_tasks WHERE book_id=? AND chapter_id=?",
                    (book_id, chapter_id),
                ).fetchone()
                if existing:
                    if existing["status"] in ACTIVE:
                        deferred = True
                        continue
                    old_jobs = {}
                    for chunk in json.loads(existing["chunks"]):
                        job = db.execute(
                            "SELECT * FROM jobs WHERE id=?", (chunk["job_id"],)
                        ).fetchone()
                        if job:
                            old_jobs[job["id"]] = dict(job)
                    if chapter_score(existing, old_jobs) >= incoming:
                        continue
                    db.execute("DELETE FROM chapter_tasks WHERE id=?", (existing["id"],))
                for job in jobs.values():
                    previous = db.execute("SELECT * FROM jobs WHERE id=?", (job["id"],)).fetchone()
                    if previous and previous["revision"] >= job["revision"]:
                        continue
                    if previous:
                        db.execute("DELETE FROM jobs WHERE id=?", (job["id"],))
                    insert(db, "jobs", job)
                insert(db, "chapter_tasks", task)
                imported = True

            if imported:
                for name, value in payload["files"].items():
                    if name == "layout-overrides-v1.json" or re.fullmatch(
                        r"page-format-\d+\.json", name
                    ):
                        target = folder / name
                        if not target.exists():
                            write_private_json(target, value)
        return not deferred
