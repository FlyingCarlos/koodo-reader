"""Private local state, separate from the browser library and Git checkout."""

import fcntl
import hashlib
import json
import os
import sqlite3
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path


def state_directory(value: Path | None = None) -> Path:
    directory = value or Path.home() / "Library/Application Support/koodoreader/translation-agent"
    directory = directory.expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    return directory


def write_private_json(path: Path, value: dict) -> None:
    """Atomic replacement also keeps rotating refresh credentials together."""
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".write-")
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


@contextmanager
def exclusive_lock(path: Path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "w") as lock:
        # Fail rather than hang a second login or worker behind a long-running job.
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError(
                "Another process owns this operation; retry when it finishes."
            ) from error
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


class JobStore:
    def __init__(self, directory: Path):
        self.path = directory / "jobs.sqlite3"
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        self.path.chmod(0o600)
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, input_json TEXT NOT NULL,
                model TEXT NOT NULL, status TEXT NOT NULL, artifacts TEXT NOT NULL,
                error_code TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )""")

    def connect(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        return db

    def start(self, source: dict, model: str, resume: str | None = None) -> dict:
        # Pin source, glossary, prompts and model together for safe stage-level resume.
        payload = json.dumps(
            {"source": source, "model": model, "workflow_version": 1},
            ensure_ascii=False,
            sort_keys=True,
        )
        fingerprint = hashlib.sha256(payload.encode()).hexdigest()
        if resume:
            job = self.get(resume)
            if job["fingerprint"] != fingerprint:
                raise ValueError(
                    "Resume requires the original input, glossary, model and workflow."
                )
            return job
        job_id = str(uuid.uuid4())
        with self.connect() as db:
            db.execute(
                "INSERT INTO jobs(id,fingerprint,input_json,model,status,artifacts) "
                "VALUES(?,?,?,?,?,?)",
                (
                    job_id,
                    fingerprint,
                    json.dumps(source, ensure_ascii=False),
                    model,
                    "pending",
                    "{}",
                ),
            )
        return self.get(job_id)

    def get(self, job_id: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise ValueError("Unknown job ID.")
        result = dict(row)
        result["artifacts"] = json.loads(result["artifacts"])
        return result

    def save(self, job_id: str, status: str, artifacts: dict, error_code: str | None = None):
        with self.connect() as db:
            db.execute(
                "UPDATE jobs SET status=?,artifacts=?,error_code=?,"
                "updated_at=CURRENT_TIMESTAMP WHERE id=?",
                (status, json.dumps(artifacts, ensure_ascii=False), error_code, job_id),
            )

    def list_jobs(self) -> list[dict]:
        with self.connect() as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT id,model,status,error_code,updated_at FROM jobs "
                    "ORDER BY updated_at DESC"
                )
            ]
