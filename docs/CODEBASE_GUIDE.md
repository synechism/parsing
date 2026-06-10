# Codebase Guide

This repo is a Dockerized async document parsing platform for agents. The base API does not implement PDF parsing itself. It wraps MinerU's GPU-backed API with a smaller agent-facing API that provides upload persistence, stable job ids, queueing, polling, and reproducible end-to-end tests.

It also contains a first-pass Mastra table comparison agent. That service exposes an async API, invokes the Mastra agent for each comparison job, parses two documents through MinerU tools, compares the first extracted table cell-by-cell, and emits a redlined PDF showing changed cells.

## Runtime Shape

```text
client / agent
  -> POST /v1/parse on api container
  -> api saves uploaded PDFs to ./data/input/<job_id>/
  -> api enqueues a JobRecord
  -> api worker submits the files to mineru POST /tasks
  -> mineru parses with CUDA/VLM/OCR/table/image models
  -> api polls mineru GET /tasks/<mineru_task_id>
  -> api saves normalized output to ./data/results/<job_id>/result.json
  -> client polls /v1/jobs/<job_id> and /v1/jobs/<job_id>/result
```

There are two services:

- `api`: the code in this repo. It is the public agent-facing API.
- `mineru`: an external MinerU image. It owns CUDA, model loading, and actual parsing.
- `table-agent`: Node/Mastra table comparison API on port `8090`.
- `gotenberg`: optional fixture-only HTML-to-PDF service behind the `fixtures` Compose profile.

## Source Files

### `src/pdfparse_agent/main.py`

FastAPI application entrypoint.

Responsibilities:

- creates the FastAPI app;
- initializes `Settings`, `Storage`, `MinerUClient`, and `JobManager` during lifespan startup;
- checks MinerU health on startup by default;
- exposes `GET /health`;
- exposes `POST /v1/parse`;
- exposes `GET /v1/jobs/{job_id}`;
- exposes `GET /v1/jobs/{job_id}/result`;
- translates internal `JobRecord` objects into API responses.

Main behavior:

- `POST /v1/parse` accepts multipart PDF uploads and form options.
- It saves files locally before queuing the parse job.
- It returns `202 Accepted` immediately with a stable platform `job_id`.
- It does not block on MinerU parsing.

Change this file when:

- adding/removing HTTP endpoints;
- changing form parameters;
- changing response shapes;
- adding auth, API keys, callbacks, or request validation.

### `src/pdfparse_agent/config.py`

Environment-driven settings.

Responsibilities:

- defines all runtime config with `pydantic-settings`;
- reads values from environment variables and `.env`;
- provides computed storage paths under `STORAGE_ROOT`;
- memoizes settings through `get_settings()`.

Important settings:

- `MINERU_BASE_URL`: where the wrapper calls MinerU, default `http://mineru:8000`.
- `STORAGE_ROOT`: root for uploads/results/temp files, default `/data`.
- `WORKER_CONCURRENCY`: number of platform worker tasks, validated default is `4`.
- `DEFAULT_BACKEND`: MinerU backend, default `hybrid-auto-engine`.
- `DEFAULT_PARSE_METHOD`: default parse method, default `auto`.
- `MAX_UPLOAD_BYTES`: per-upload size limit.
- `REQUIRE_MINERU_HEALTH_ON_STARTUP`: fail API startup if MinerU is unhealthy.

Change this file when:

- adding an environment variable;
- changing defaults;
- adding path conventions.

### `src/pdfparse_agent/models.py`

Pydantic/domain models shared across API, storage, and worker code.

Responsibilities:

- defines `JobStatus`;
- defines terminal status constants;
- defines parse options sent to MinerU;
- defines the internal `JobRecord`;
- defines public response models.

Key models:

- `ParseOptions`: form/API options for MinerU parsing, such as backend, language, table parsing, image analysis, and output format flags.
- `JobRecord`: internal state for one parse job, including local file paths, MinerU task id, status timestamps, errors, and final result.
- `SubmitResponse`: response for `POST /v1/parse`.
- `JobStatusResponse`: response for `GET /v1/jobs/{job_id}`.

Change this file when:

- adding job metadata;
- adding parse options;
- changing status semantics;
- changing public response schemas.

### `src/pdfparse_agent/storage.py`

Filesystem persistence helper.

Responsibilities:

- creates storage directories;
- sanitizes uploaded filenames;
- writes uploaded files to `./data/input/<job_id>/`;
- enforces `MAX_UPLOAD_BYTES`;
- writes final normalized JSON to `./data/results/<job_id>/result.json`;
- can clean up a job's input/result directories.

Important functions/classes:

- `safe_filename()`: strips unsafe path/name characters from upload names.
- `Storage.save_upload_stream()`: streams upload content to disk with a size limit.
- `Storage.write_result()`: writes a completed job result as JSON.
- `Storage.cleanup_job()`: removes persisted files for a job.

Change this file when:

- moving from local disk to S3/object storage;
- changing result layout;
- adding retention or cleanup policy;
- changing upload validation.

### `src/pdfparse_agent/mineru_client.py`

Async HTTP client for MinerU.

Responsibilities:

- owns an `httpx.AsyncClient`;
- checks MinerU `/health`;
- submits files to MinerU `/tasks`;
- polls MinerU task status;
- fetches final MinerU result.

Important methods:

- `health()`: validates the MinerU service is reachable and healthy.
- `submit_task(paths, options)`: sends multipart files and parse options to MinerU.
- `wait_for_result(task_id)`: polls until MinerU returns completed, failed, or timeout.

Notable behavior:

- The client sends form fields using MinerU's expected names.
- It uses `lang_list` even though the platform exposes a simpler single `lang` value.
- It returns MinerU's JSON response directly; normalization happens by storing that response as the platform result.

Change this file when:

- MinerU's API changes;
- adding retries/backoff;
- supporting ZIP responses;
- routing to multiple MinerU backends;
- adding request tracing or structured logs.

### `src/pdfparse_agent/worker.py`

In-process async job queue and worker manager.

Responsibilities:

- stores all active/in-memory `JobRecord` objects;
- owns an `asyncio.Queue`;
- starts N worker tasks based on `WORKER_CONCURRENCY`;
- submits jobs to MinerU through `MinerUClient`;
- updates job status/timestamps/errors;
- persists final results through `Storage`.

Important classes:

- `JobManager`: queue, job registry, worker lifecycle, and job execution.

Important methods:

- `start()`: creates worker tasks.
- `stop()`: cancels worker tasks during app shutdown.
- `submit(job)`: registers and enqueues a job.
- `_process(job)`: performs the actual MinerU submit, poll, result persistence, and failure handling.

Current limitations:

- Job state is in memory. Persisted result JSON survives restarts, but the in-memory job registry does not.
- Queue state is in memory. For a production multi-instance API, use Redis/Postgres/SQS or another external queue.

Change this file when:

- adding durable queueing;
- adding retry policies;
- adding priority scheduling;
- adding cancellation;
- routing jobs across multiple MinerU services.

### `src/pdfparse_agent/__init__.py`

Package metadata.

Responsibilities:

- defines `__version__`.

Change this file when:

- bumping package version metadata.

## Mastra Table Comparison Files

### `src/table-compare/server.ts`

Express entrypoint for the async table comparison API.

Responsibilities:

- exposes `GET /health`;
- exposes `POST /v1/table-comparisons`;
- exposes `GET /v1/table-comparisons/:jobId`;
- exposes `GET /v1/table-comparisons/:jobId/result`;
- exposes `GET /v1/table-comparisons/:jobId/redline.pdf`;
- wires `MinerUClient` for health checks and `TableCompareJobManager` for async work.

### `src/table-compare/job-manager.ts`

In-memory queue for table comparison jobs.

Responsibilities:

- stores uploaded `documentA` and `documentB`;
- limits concurrent comparison jobs with `TABLE_COMPARE_WORKER_CONCURRENCY`;
- runs the API-to-agent compare workflow in the background;
- records status, errors, and final result paths.

### `src/table-compare/mineru-client.ts`

Node client for MinerU's local `/tasks` API.

Responsibilities:

- sends one document as multipart form data;
- requests `content_list` and `middle_json`;
- polls task status;
- returns the final MinerU JSON result.

### `src/table-compare/table-extractor.ts`

Converts MinerU output into comparable table structures.

Responsibilities:

- reads `content_list` table HTML and table bboxes;
- reads page sizes from `middle_json.pdf_info`;
- parses table HTML with `cheerio`;
- normalizes cell text;
- assigns spreadsheet-style cell refs;
- creates initial per-cell bboxes inside the MinerU table bbox.

### `src/table-compare/table-geometry.ts`

Refines table/cell geometry for PDF inputs.

Responsibilities:

- renders PDF pages with `pdftoppm`;
- reads rendered PNGs with `pngjs`;
- detects horizontal and vertical ruling-line clusters inside MinerU's table-body bbox;
- replaces uniform cell boxes with non-uniform boxes from the detected grid;
- falls back to the extractor's uniform boxes when the detector cannot find the expected boundaries.

### `src/table-compare/table-compare.ts`

Deterministic table diff engine.

Responsibilities:

- compares parsed cells by ref;
- detects changed, added, removed, and shape-changed cells;
- returns a boolean judgement and human-readable summary.

### `src/table-compare/redline.ts`

PDF visual redline renderer.

Responsibilities:

- opens document B when it is a PDF;
- maps MinerU top-left page coordinates into PDF bottom-left coordinates;
- draws red overlays around changed cells;
- writes `redline.pdf`.

### `src/table-compare/workflow.ts`

API-to-agent bridge used by the table comparison API.

Responsibilities:

- retrieves `tableCompareAgent` from `src/mastra/index.ts`;
- calls `agent.generate(...)` for each queued comparison job;
- restricts active tools to `compareTwoTablesSkillTool`;
- extracts the `compare-two-tables-skill` result from Mastra's tool-result payload;
- marks returned results with `agent.invokedByApi=true`;
- fails the job if the agent does not execute the skill tool.

### `src/table-compare/types.ts`

Shared TypeScript domain types for tables, cells, bboxes, jobs, and comparison results.

### `src/mastra/tools/mineru-table-tools.ts`

Mastra parsing tool and shared parsing helper.

Responsibilities:

- calls MinerU's local `/tasks` API through the Node client;
- extracts structured tables from MinerU output;
- refines PDF cell geometry with detected ruling lines.

### `src/mastra/tools/table-compare-tools.ts`

Mastra table comparison tools.

Responsibilities:

- exposes `compare-mineru-parsed-tables` for direct comparison of two parsed table structures;
- exposes `compare-two-tables-skill`, the API-facing skill tool;
- in the skill tool, parses both documents, compares the first parsed table, writes the redline PDF, and returns `different`, `explanation`, `differences`, `redlinePdfPath`, and agent metadata;
- uses `toModelOutput` to give the model a compact summary while preserving the full raw tool result for the API.

### `src/mastra/tools/redline-pdf-tool.ts`

Mastra tool that writes a redline PDF from a comparison result and document B path.

### `src/mastra/agents/table-compare-agent.ts`

Mastra agent definition.

The instructions force the agent to ground judgement in MinerU structured output instead of relying only on native multimodal inspection.

### `src/mastra/skills/compare-two-tables.md`

Skill instructions for the table comparison workflow.

### `src/mastra/index.ts`

Mastra runtime entrypoint registering `tableCompareAgent`.

## Docker and Deployment Files

### `docker-compose.yml`

Primary local deployment.

Services:

- `mineru`: GPU-backed MinerU API service.
- `api`: this repo's FastAPI wrapper.
- `table-agent`: Node async table comparison API.
- `gotenberg`: optional fixture PDF generator under the `fixtures` profile.

Important defaults:

- `MINERU_IMAGE=${MINERU_IMAGE:-mineru-api:latest}`: uses the already-present MinerU image by default.
- `gpus: all`: exposes GPU devices to MinerU.
- `MINERU_DEVICE_MODE=cuda`: forces MinerU device selection to CUDA.
- `GPU_MEMORY_UTILIZATION=0.9`: vLLM cache reservation.
- `MINERU_API_MAX_CONCURRENT_REQUESTS=4`: validated L40S concurrency.
- `WORKER_CONCURRENCY=4`: platform worker concurrency.
- `./data:/data`: persists platform uploads/results on the host.
- `mineru-output:/data/mineru-output`: stores MinerU's own artifacts in a Docker volume.
- `TABLE_COMPARE_WORKER_CONCURRENCY=2`: table-agent job concurrency. Each job submits two MinerU tasks.
- `GOTENBERG_PORT=3001`: default fixture generator host port.

Change this file when:

- changing production defaults;
- exposing different ports;
- mounting persistent storage differently;
- adding Redis/Postgres/metrics services;
- changing GPU allocation.

### `docker-compose.build.yml`

Optional Compose override for building the MinerU image from this repo's Dockerfile.

Use:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

This is separate because MinerU's GPU image is large. On the current host, Docker storage was nearly full, so the normal path uses the existing `mineru-api:latest` image.

Change this file when:

- changing how the local MinerU image is built;
- switching image tags for custom MinerU builds.

### `docker/api.Dockerfile`

Builds the lightweight wrapper API image.

Steps:

- starts from `python:3.12-slim`;
- installs `pip` and `uv`;
- copies `pyproject.toml`, `README.md`, and `src`;
- installs this package into the system Python environment;
- runs `uvicorn pdfparse_agent.main:app` on port `8080`.

Change this file when:

- adding system dependencies for the wrapper API;
- changing Python version;
- changing package install mode;
- changing the API startup command.

### `docker/mastra-agent.Dockerfile`

Builds the Node table comparison API image.

Steps:

- starts from `node:24-slim`;
- installs dependencies with `npm ci`;
- copies `src`;
- runs `npm run dev:table-agent` on port `8090`.

Change this file when:

- changing the Node version;
- adding system dependencies for document conversion;
- changing the table-agent startup command.

### `docker/mineru.Dockerfile`

Builds a full MinerU GPU image.

Steps:

- starts from `vllm/vllm-openai:v0.21.0`;
- installs OS packages needed by OpenCV/fonts;
- installs `mineru[core]`;
- downloads MinerU models during build;
- starts `mineru-api` with VLM preload enabled.

Current role:

- buildable fallback/custom image definition;
- not used by default unless `docker-compose.build.yml` is included.

Change this file when:

- pinning a different MinerU version;
- changing model download source;
- using a different CUDA/vLLM base image;
- adding GPU runtime flags.

### `.dockerignore`

Docker build context exclusions.

Responsibilities:

- keeps Git metadata, Python caches, virtualenvs, and runtime `data/` out of image build contexts.

Change this file when:

- new generated folders should not enter Docker builds.

### `.env.example`

Example environment variables for Compose/runtime tuning.

Important values:

- `MINERU_API_MAX_CONCURRENT_REQUESTS=4`
- `WORKER_CONCURRENCY=4`
- `MINERU_PROCESSING_WINDOW_SIZE=64`
- `DEFAULT_BACKEND=hybrid-auto-engine`
- `JOB_RESULT_TIMEOUT_SECONDS=7200`

Change this file when:

- adding config options;
- changing recommended defaults.

## Scripts

### `scripts/download_test_pdfs.py`

Downloads a complex PDF test corpus to `data/test-pdfs`.

Current PDFs:

- Attention Is All You Need
- LayoutParser
- DocLayNet
- MinerU technical report

Outputs:

- `data/test-pdfs/*.pdf`
- `data/test-pdfs/manifest.json`

Change this file when:

- adding/removing benchmark PDFs;
- changing corpus source URLs;
- adding checksums.

### `scripts/run_e2e.py`

End-to-end benchmark/test runner.

Responsibilities:

- checks `/health`;
- submits PDFs to `POST /v1/parse`;
- polls each job until completion/failure/timeout;
- fetches final results;
- records simple quality signals:
  - `has_markdown`;
  - `has_table_signal`;
  - `has_image_signal`;
  - `result_bytes`;
- writes a summary JSON file.

Common use:

```bash
python3 scripts/run_e2e.py \
  --api-url http://127.0.0.1:8080 \
  --pdf-dir data/test-pdfs \
  --out data/e2e-summary.json \
  --concurrency 4
```

Change this file when:

- adding stronger assertions;
- measuring elapsed time per file;
- collecting GPU metrics;
- turning the benchmark into a CI test.

### `scripts/generate_table_fixtures.ts`

Generates deterministic HTML and PDF table fixtures through Gotenberg.

Outputs:

- `data/table-fixtures/base.html`
- `data/table-fixtures/base.pdf`
- `data/table-fixtures/identical.pdf`
- `data/table-fixtures/changed.pdf`
- `data/table-fixtures/manifest.json`

The manifest records expected diffs for `base` vs `changed`.

## Project Metadata

### `pyproject.toml`

Python package metadata and dependencies.

Runtime dependencies:

- `fastapi`
- `httpx`
- `pydantic`
- `pydantic-settings`
- `python-multipart`
- `uvicorn[standard]`

Dev dependencies:

- `pytest`
- `ruff`

Change this file when:

- adding Python dependencies;
- changing package metadata;
- adding lint/test tooling.

### `package.json` and `package-lock.json`

Node package metadata for Mastra and the table comparison API.

Important scripts:

- `npm run dev:mastra`: starts Mastra Studio/runtime.
- `npm run build:mastra`: builds Mastra.
- `npm run dev:table-agent`: starts the async table comparison API.
- `npm run typecheck`: runs TypeScript checking.
- `npm run generate:table-fixtures`: creates deterministic Gotenberg PDFs.

### `README.md`

Human runbook and architecture overview.

Contains:

- GPU evidence;
- architecture explanation;
- concurrency model;
- benchmark findings;
- Docker run instructions;
- API surface;
- local development notes.

Change this file when:

- changing operational defaults;
- adding deployment instructions;
- recording new benchmark findings.

## Runtime Data and Generated Files

### `data/test-pdfs/`

Downloaded benchmark corpus. Source of truth is `scripts/download_test_pdfs.py`.

### `data/input/`

Uploaded PDFs grouped by platform job id.

Example:

```text
data/input/<job_id>/<uploaded_file>.pdf
```

This is runtime data, not source code.

### `data/results/`

Normalized platform results grouped by job id.

Example:

```text
data/results/<job_id>/result.json
```

This is runtime data, not source code.

### `data/e2e-*.json`

Benchmark summaries written by `scripts/run_e2e.py`.

These are useful for audit/debugging, but they are generated artifacts.

### `__pycache__/`

Python bytecode generated by `python -m compileall` or imports.

These are generated artifacts and can be deleted safely.

## Where To Make Common Changes

Add a new API field:

1. Add it to `ParseOptions` in `models.py`.
2. Add a form field in `main.py`.
3. Forward it in `mineru_client.py` if MinerU needs it.
4. Update README/API docs.

Change default concurrency:

1. Update `docker-compose.yml`.
2. Update `.env.example`.
3. Update the README benchmark/concurrency section.
4. Re-run `scripts/run_e2e.py`.

Add durable queueing:

1. Replace or extend `JobManager` in `worker.py`.
2. Persist job records outside process memory.
3. Make `GET /v1/jobs/{job_id}` load from durable state.
4. Add startup recovery behavior.

Add multiple MinerU workers:

1. Add more MinerU services or use `mineru-router`.
2. Point `MINERU_BASE_URL` at the router, or add routing inside `MinerUClient`.
3. Track per-worker health and queue depth.

Move storage to object storage:

1. Replace local write/read behavior in `storage.py`.
2. Decide whether MinerU receives local files, pre-signed URLs, or streamed bytes.
3. Keep the public result contract stable.
