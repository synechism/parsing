import json
import re
import shutil
from pathlib import Path
from typing import BinaryIO

from .models import JobRecord

SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_filename(filename: str) -> str:
    clean = SAFE_NAME_RE.sub("_", Path(filename).name).strip("._")
    return clean or "upload.pdf"


class Storage:
    def __init__(self, root: Path):
        self.root = root
        self.input_dir = root / "input"
        self.result_dir = root / "results"
        self.tmp_dir = root / "tmp"
        for directory in (self.input_dir, self.result_dir, self.tmp_dir):
            directory.mkdir(parents=True, exist_ok=True)

    def job_input_dir(self, job_id: str) -> Path:
        directory = self.input_dir / job_id
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def job_result_dir(self, job_id: str) -> Path:
        directory = self.result_dir / job_id
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def save_upload_stream(
        self,
        job_id: str,
        filename: str,
        source: BinaryIO,
        max_bytes: int,
    ) -> Path:
        directory = self.job_input_dir(job_id)
        target = directory / safe_filename(filename)
        bytes_written = 0
        with target.open("wb") as handle:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                bytes_written += len(chunk)
                if bytes_written > max_bytes:
                    target.unlink(missing_ok=True)
                    raise ValueError(f"Upload exceeds {max_bytes} bytes")
                handle.write(chunk)
        return target

    def result_json_path(self, job_id: str) -> Path:
        return self.job_result_dir(job_id) / "result.json"

    def write_result(self, job: JobRecord) -> Path:
        path = self.result_json_path(job.id)
        with path.open("w", encoding="utf-8") as handle:
            json.dump(job.result or {}, handle, ensure_ascii=False, indent=2, default=str)
        return path

    def cleanup_job(self, job_id: str) -> None:
        shutil.rmtree(self.input_dir / job_id, ignore_errors=True)
        shutil.rmtree(self.result_dir / job_id, ignore_errors=True)

