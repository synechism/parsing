from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

from .config import Settings, get_settings
from .mineru_client import MinerUClient
from .models import JobRecord, JobStatus, JobStatusResponse, ParseOptions, SubmitResponse
from .storage import Storage
from .worker import JobManager


def build_status_response(job: JobRecord, request: Request) -> JobStatusResponse:
    return JobStatusResponse(
        job_id=job.id,
        status=job.status,
        files=job.files,
        created_at=job.created_at,
        updated_at=job.updated_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
        backend=job.options.backend,
        parse_method=job.options.parse_method,
        queued_ahead=job.queued_ahead,
        mineru_task_id=job.mineru_task_id,
        error=job.error,
        result_url=str(request.url_for("get_result", job_id=job.id)),
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    storage = Storage(settings.storage_root)
    mineru = MinerUClient(
        base_url=str(settings.mineru_base_url),
        timeout_seconds=settings.mineru_timeout_seconds,
        poll_interval_seconds=settings.job_poll_interval_seconds,
        result_timeout_seconds=settings.job_result_timeout_seconds,
    )
    if settings.require_mineru_health_on_startup:
        await mineru.health()
    manager = JobManager(mineru=mineru, storage=storage, concurrency=settings.worker_concurrency)
    await manager.start()
    app.state.settings = settings
    app.state.storage = storage
    app.state.mineru = mineru
    app.state.manager = manager
    try:
        yield
    finally:
        await manager.stop()
        await mineru.close()


app = FastAPI(
    title="PDF Parse Agent Platform",
    version="0.1.0",
    lifespan=lifespan,
)


def get_manager(request: Request) -> JobManager:
    return request.app.state.manager


def get_storage(request: Request) -> Storage:
    return request.app.state.storage


def current_settings() -> Settings:
    return get_settings()


@app.get("/health")
async def health(request: Request) -> dict:
    manager: JobManager = request.app.state.manager
    mineru: MinerUClient = request.app.state.mineru
    mineru_health = await mineru.health()
    counts = {status.value: 0 for status in JobStatus}
    for job in manager.iter_jobs():
        counts[job.status.value] += 1
    return {
        "status": "healthy",
        "mineru": mineru_health,
        "jobs": counts,
        "worker_concurrency": manager.concurrency,
    }


@app.post("/v1/parse", status_code=202, response_model=SubmitResponse)
async def submit_parse(
    request: Request,
    files: Annotated[list[UploadFile], File(description="PDF files to parse")],
    backend: Annotated[str | None, Form()] = None,
    parse_method: Annotated[str | None, Form()] = None,
    lang: Annotated[str | None, Form()] = None,
    formula_enable: Annotated[bool, Form()] = True,
    table_enable: Annotated[bool, Form()] = True,
    image_analysis: Annotated[bool, Form()] = True,
    return_md: Annotated[bool, Form()] = True,
    return_middle_json: Annotated[bool, Form()] = True,
    return_model_output: Annotated[bool, Form()] = False,
    return_content_list: Annotated[bool, Form()] = True,
    return_images: Annotated[bool, Form()] = False,
    response_format_zip: Annotated[bool, Form()] = False,
    start_page_id: Annotated[int, Form()] = 0,
    end_page_id: Annotated[int, Form()] = 99999,
    manager: JobManager = Depends(get_manager),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(current_settings),
):
    if not files:
        raise HTTPException(status_code=400, detail="At least one PDF file is required")

    options = ParseOptions(
        backend=backend or settings.default_backend,
        parse_method=parse_method or settings.default_parse_method,
        lang=lang or settings.default_lang,
        formula_enable=formula_enable,
        table_enable=table_enable,
        image_analysis=image_analysis,
        return_md=return_md,
        return_middle_json=return_middle_json,
        return_model_output=return_model_output,
        return_content_list=return_content_list,
        return_images=return_images,
        response_format_zip=response_format_zip,
        start_page_id=start_page_id,
        end_page_id=end_page_id,
    )
    job = JobRecord(files=[upload.filename or "upload.pdf" for upload in files], input_paths=[], options=options)

    try:
        for upload in files:
            path = storage.save_upload_stream(
                job_id=job.id,
                filename=upload.filename or "upload.pdf",
                source=upload.file,
                max_bytes=settings.max_upload_bytes,
            )
            job.input_paths.append(path)
    except ValueError as exc:
        storage.cleanup_job(job.id)
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    finally:
        for upload in files:
            await upload.close()

    await manager.submit(job)
    return SubmitResponse(
        job_id=job.id,
        status=job.status,
        status_url=str(request.url_for("get_job", job_id=job.id)),
        result_url=str(request.url_for("get_result", job_id=job.id)),
        queued_ahead=job.queued_ahead,
    )


@app.get("/v1/jobs/{job_id}", response_model=JobStatusResponse)
async def get_job(job_id: str, request: Request, manager: JobManager = Depends(get_manager)):
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return build_status_response(job, request)


@app.get("/v1/jobs/{job_id}/result", name="get_result")
async def get_result(job_id: str, request: Request, manager: JobManager = Depends(get_manager)):
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status in {JobStatus.queued, JobStatus.submitting, JobStatus.processing}:
        return JSONResponse(
            status_code=202,
            content={**build_status_response(job, request).model_dump(mode="json"), "message": "Result not ready"},
        )
    if job.status == JobStatus.failed:
        return JSONResponse(
            status_code=409,
            content={**build_status_response(job, request).model_dump(mode="json"), "message": "Job failed"},
        )
    return job.result or {}

