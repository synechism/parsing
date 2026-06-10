from datetime import datetime, timezone
from enum import StrEnum
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class JobStatus(StrEnum):
    queued = "queued"
    submitting = "submitting"
    processing = "processing"
    completed = "completed"
    failed = "failed"


TERMINAL_STATUSES = {JobStatus.completed, JobStatus.failed}


class ParseOptions(BaseModel):
    backend: str = "hybrid-auto-engine"
    parse_method: str = "auto"
    lang: str = "en"
    formula_enable: bool = True
    table_enable: bool = True
    image_analysis: bool = True
    return_md: bool = True
    return_middle_json: bool = True
    return_model_output: bool = False
    return_content_list: bool = True
    return_images: bool = False
    response_format_zip: bool = False
    start_page_id: int = 0
    end_page_id: int = 99999


class JobRecord(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    status: JobStatus = JobStatus.queued
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    started_at: datetime | None = None
    completed_at: datetime | None = None
    files: list[str]
    input_paths: list[Path]
    options: ParseOptions
    mineru_task_id: str | None = None
    mineru_status_url: str | None = None
    mineru_result_url: str | None = None
    queued_ahead: int | None = None
    error: str | None = None
    result_path: Path | None = None
    result: dict[str, Any] | None = None

    def touch(self) -> None:
        self.updated_at = utc_now()


class SubmitResponse(BaseModel):
    job_id: str
    status: JobStatus
    status_url: str
    result_url: str
    queued_ahead: int | None = None


class JobStatusResponse(BaseModel):
    job_id: str
    status: JobStatus
    files: list[str]
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    backend: str
    parse_method: str
    queued_ahead: int | None = None
    mineru_task_id: str | None = None
    error: str | None = None
    result_url: str

