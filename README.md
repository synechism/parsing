# PDF Parse Agent Platform

Async FastAPI service for agent workflows, backed by MinerU running in a dedicated GPU container.

## GPU Check

This machine reports:

```text
GPU 0: NVIDIA L40S, 46068 MiB VRAM, CUDA 13.1 driver stack
```

The Docker setup pins MinerU to CUDA with `MINERU_DEVICE_MODE=cuda` and exposes all GPUs to the MinerU container.

## Architecture

The service is intentionally split into two containers instead of importing MinerU directly into the public API process.

- `mineru`: owns CUDA, model loading, MinerU's native `/tasks` async API, and parsed artifacts.
- `api`: owns the agent-facing API, upload persistence, job metadata, queueing, polling, and result normalization.

Request flow:

```text
agent/client
  -> POST /v1/parse
  -> api saves uploads under /data/input/<job_id>
  -> api enqueues a local JobRecord and returns 202 immediately
  -> api worker submits multipart files to mineru POST /tasks
  -> mineru parses on CUDA using its own async task manager
  -> api polls mineru GET /tasks/<task_id>
  -> api stores the final JSON under /data/results/<job_id>/result.json
  -> agent/client polls GET /v1/jobs/<job_id>/result
```

There are three separate state boundaries:

- Upload/result state is owned by this platform under `./data`, so agent-facing job ids stay stable even if MinerU task ids change.
- MinerU runtime state is isolated inside the GPU container, so CUDA initialization, model caches, and VLM warmup do not block or crash the public API process.
- Docker volume `mineru-output` stores MinerU's own generated files, while `./data/results` stores the normalized response returned to agents.

This wrapper looks thin, but it gives us operational control that MinerU alone does not provide as cleanly for agents: stable job records, an agent-specific API contract, result persistence, corpus tests, and an obvious place to add auth, quotas, callbacks, retries, or per-tenant routing later.

## GPU Acceleration

This deployment is using the GPU. Evidence from the validated run:

- `nvidia-smi` reported an NVIDIA L40S with 46068 MiB VRAM.
- The running MinerU container started vLLM with `device_config=cuda`.
- MinerU logs selected `vllm-async-engine`.
- The model loaded from `opendatalab/MinerU2.5-2509-1.2B`.
- vLLM reported FlashAttention as the attention backend.
- During parsing, `nvidia-smi` showed `VLLM::EngineCore` resident on GPU with about 40 GiB allocated.

That proves GPU acceleration is active. It does not prove throughput is maximized.

## Concurrency Model

The validated L40S default is `4` in both public layers:

- `MINERU_API_MAX_CONCURRENT_REQUESTS=4`
- `WORKER_CONCURRENCY=4`

This means up to four whole-document jobs can be in flight through this platform and MinerU at once. The original safe baseline was `1`, which is still the right fallback for unknown GPUs, very long PDFs, or when debugging stability. On this L40S, `1` was too conservative for normal complex PDFs.

The system still has internal parallelism at concurrency `1`:

- MinerU processes pages in windows. The current default is `MINERU_PROCESSING_WINDOW_SIZE=64`.
- On this L40S, MinerU logged `hybrid batch ratio (auto, vram=44GB): 16`.
- vLLM batches model work internally and keeps the VLM model warm on GPU.
- OCR/layout/table/image work can use CPU threads and GPU kernels inside a single document parse.

If many agents submit many PDFs, `WORKER_CONCURRENCY` controls whole-document parallelism at the platform layer. It should usually match `MINERU_API_MAX_CONCURRENT_REQUESTS` unless a separate router or priority scheduler is added.

### Throughput Tuning

For a single L40S, the current validated setting is:

```bash
WORKER_CONCURRENCY=4 \
MINERU_API_MAX_CONCURRENT_REQUESTS=4 \
docker compose up -d --force-recreate
```

Validation run:

```bash
python3 scripts/run_e2e.py --api-url http://127.0.0.1:8080 --concurrency 4
nvidia-smi
curl http://127.0.0.1:8080/health
```

Observed results on this host:

```text
concurrency=2: four-PDF corpus completed, no failed jobs
concurrency=3: four-PDF corpus completed, no failed jobs
concurrency=4: four-PDF corpus completed, no failed jobs, total elapsed 30.98s
peak observed VRAM at concurrency=4: 43684 MiB / 46068 MiB
```

Stop increasing concurrency when one of these happens:

- GPU memory gets close to the 46 GiB limit.
- MinerU starts returning failed tasks.
- End-to-end latency rises faster than throughput.
- Host RAM or CPU OCR/layout stages become the bottleneck.

Useful knobs:

- `WORKER_CONCURRENCY`: number of agent-platform jobs submitted to MinerU in parallel.
- `MINERU_API_MAX_CONCURRENT_REQUESTS`: MinerU's own concurrent task limit.
- `MINERU_PROCESSING_WINDOW_SIZE`: pages per processing window; larger can improve throughput but raises peak memory.
- `GPU_MEMORY_UTILIZATION`: vLLM KV-cache reservation. Current default is `0.9`, which is aggressive and left about 4 GiB free during validation. Lowering it, for example to `0.8`, may leave more headroom for non-vLLM GPU work but can reduce VLM serving capacity.

Recommended approach:

```text
stable baseline:       WORKER_CONCURRENCY=1, MINERU_API_MAX_CONCURRENT_REQUESTS=1
validated L40S value:  WORKER_CONCURRENCY=4, MINERU_API_MAX_CONCURRENT_REQUESTS=4
next experiment:       try 5+ only with a larger stress corpus and active OOM monitoring
multi-GPU scaling:     run one MinerU worker per GPU and route across workers
```

Do not run multiple full MinerU VLM containers on one L40S unless memory use has been measured. Each container can reserve a large vLLM cache, so multiple containers may waste VRAM compared with one container using controlled request concurrency. With `GPU_MEMORY_UTILIZATION=0.9` and concurrency `4`, this host already runs fairly close to the VRAM ceiling.

## Design Decisions

### Use MinerU as a Service, Not a Library Import

MinerU is a large CUDA/VLM runtime with its own model loading, FastAPI app, async task manager, and output conventions. Keeping it behind HTTP has a few practical advantages:

- The public API can start, fail, and restart independently from CUDA model initialization.
- CUDA memory ownership is obvious: the `mineru` container owns it.
- We avoid binding our code to MinerU private Python internals.
- Upgrading MinerU is mostly an image/version change as long as its `/tasks` contract remains compatible.
- The wrapper can remain small and agent-focused.

The cost is one extra local HTTP hop and duplicated task ids. That is acceptable compared with the operational risk of loading a large VLM stack into the same process that handles public requests.

### Async API Contract

`POST /v1/parse` never waits for parsing to finish. It persists the upload, creates a job, enqueues work, and returns `202`.

This matters for agents because complex PDFs are long-running tasks. A synchronous endpoint would force callers to hold connections open through model warmup, OCR, table extraction, image extraction, and post-processing. The polling contract is simpler and more resilient:

- `POST /v1/parse`: submit work.
- `GET /v1/jobs/{job_id}`: observe status.
- `GET /v1/jobs/{job_id}/result`: retrieve the final parse.

The same shape can later support webhooks or server-sent events without changing the underlying worker design.

### Queue Ownership

The platform has its own queue even though MinerU also has `/tasks`.

That is intentional. The outer queue is where agent/product policy belongs:

- reject or throttle oversized files before GPU submission;
- add tenant quotas;
- prioritize interactive jobs over batch jobs;
- persist stable job metadata;
- retry failed MinerU submissions;
- route across multiple MinerU workers in a future multi-GPU setup.

MinerU's queue should remain focused on parse execution. The platform queue should own product-level scheduling.

### Result Persistence

The API writes normalized results to `./data/results/<job_id>/result.json`.

This avoids requiring clients to know MinerU's internal output directory layout. It also makes result retrieval stable even if the MinerU container is restarted after a job completes and before an agent fetches the output.

### Scaling Path

Single GPU scaling should first increase concurrency inside one MinerU container. Multi-container replication on one GPU is usually wasteful because each VLM container may reserve its own large GPU cache.

Preferred progression:

```text
1. One GPU, one MinerU container, concurrency 1 for correctness.
2. One GPU, one MinerU container, concurrency 4 on this L40S after benchmarking.
3. Multiple GPUs, one MinerU container per GPU.
4. Add a router or scheduler that assigns jobs based on queue depth and health.
```

MinerU also ships `mineru-router`; that is the natural next piece when there are multiple GPU-backed MinerU services. This repo's `api` service can either call a router as `MINERU_BASE_URL` or grow its own routing policy if agent-specific scheduling becomes important.

## Run With Docker

Build the lightweight API image and start both services using the existing local `mineru-api:latest` GPU image:

```bash
docker compose up --build
```

If this machine does not have `mineru-api:latest`, build MinerU's GPU image too:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

That build is heavy because `docker/mineru.Dockerfile` installs `mineru[core]` and downloads model weights into the image. On this host, Docker currently has very little free space; `docker system df` showed more than 100 GB reclaimable, but pruning is intentionally left to the operator.

After startup:

- Agent API: `http://127.0.0.1:8080/docs`
- Raw MinerU API: `http://127.0.0.1:8000/docs`

Health check:

```bash
curl http://127.0.0.1:8080/health
```

Submit a PDF:

```bash
curl -X POST http://127.0.0.1:8080/v1/parse \
  -F "files=@data/test-pdfs/attention.pdf" \
  -F "backend=hybrid-auto-engine" \
  -F "parse_method=auto" \
  -F "lang=en"
```

Poll:

```bash
curl http://127.0.0.1:8080/v1/jobs/<job_id>
curl http://127.0.0.1:8080/v1/jobs/<job_id>/result
```

## Complex PDF Corpus

Download a small but useful set of PDFs with tables, images, formulas, and multi-column layouts:

```bash
python3 scripts/download_test_pdfs.py
```

Run the end-to-end parse harness after Docker is up:

```bash
python3 scripts/run_e2e.py --api-url http://127.0.0.1:8080 --concurrency 1
```

The summary is written to `data/e2e-summary.json` and includes simple signals for markdown, tables, images, and result size.

Validated on this L40S host:

```text
attention.pdf    completed, markdown=true, table=true, image=true, result_bytes=766212
doclaynet.pdf    completed, markdown=true, table=true, image=true, result_bytes=909943
layoutparser.pdf completed, markdown=true, table=true, image=true, result_bytes=831018
mineru.pdf       completed, markdown=true, table=true, image=true, result_bytes=708585
```

## API Surface

- `POST /v1/parse`: multipart upload, returns immediately with `job_id`.
- `GET /v1/jobs/{job_id}`: job status and MinerU task id.
- `GET /v1/jobs/{job_id}/result`: returns `202` until ready, `409` on failure, parsed JSON on success.
- `GET /health`: checks this API, queue counts, and MinerU health.

## Mastra Table Comparison Agent

This repo also includes a Mastra agent and async API for comparing tables in two documents using MinerU structured output.

### Table Compare Runtime Shape

The table comparison path is a separate Node service named `table-agent`:

```mermaid
flowchart TD
  A[Client or agent<br/>POST /v1/table-comparisons] --> B[src/table-compare/server.ts<br/>validate multipart fields<br/>return job URLs]
  B --> C[src/table-compare/job-manager.ts<br/>save uploads under /data/table-compare/input/job_id<br/>enqueue background work]
  C --> D[src/table-compare/workflow.ts<br/>load semanticTableCompareAgent from Mastra<br/>call agent.generate]
  D --> E[src/mastra/index.ts<br/>Mastra registry]
  E --> F[src/mastra/agents/semantic-table-compare-agent.ts<br/>single API-facing semantic agent]
  F --> H[src/mastra/tools/mineru-table-tools.ts<br/>agent invokes MinerU parse tool twice]
  H --> I[src/table-compare/mineru-client.ts<br/>POST /tasks and poll MinerU]
  I --> J[mineru container<br/>CUDA/VLM/OCR/table parsing]
  H --> K[src/table-compare/table-extractor.ts<br/>content_list table HTML<br/>middle_json page/table boxes]
  K --> L[src/table-compare/table-geometry.ts<br/>Poppler render<br/>PDF ruling-line cell boxes]
  L --> M[src/table-compare/workflow.ts<br/>build compact evidence prompt<br/>same-grid candidate diffs]
  M --> N[src/mastra/agents/semantic-table-compare-agent.ts<br/>semantic column/row matching<br/>returns JSON plan]
  N --> S[src/table-compare/semantic-compare.ts<br/>validate JSON plan<br/>map refs to bboxes]
  S --> R[src/table-compare/redline.ts<br/>draw explained boxes on baseline document]
  R --> O[/data/table-compare/results/job_id/redline.pdf]
  S --> P[different, explanation, differences,<br/>redlinePdfPath, agent metadata]
  P --> Q[src/table-compare/server.ts<br/>GET /result and /redline.pdf]
```

The async API now calls the semantic Mastra agent for every comparison job. `src/table-compare/workflow.ts` is the API-to-agent bridge: it retrieves `semanticTableCompareAgent` from `src/mastra/index.ts`, calls `agent.generate(...)`, and restricts the active tool set to `parseDocumentPairTablesTool` during the parsing phase. If the agent does not invoke MinerU for both inputs, the job fails instead of silently falling back to a direct non-agent path.

After parsing, `workflow.ts` builds a compact MinerU-grounded evidence prompt from the parsed tables, same-grid candidate differences, and baseline redline choice. The same `semanticTableCompareAgent` then returns a JSON semantic comparison plan. Deterministic code validates that plan, maps returned cell refs to MinerU-derived bounding boxes, and writes the redline PDF.

### Why The Agent Uses Tools

The agent is not asked to visually guess table differences. Its tools force the workflow through MinerU first:

- `parse-document-pair-tables-with-mineru`: calls the local MinerU API for both documents and extracts structured tables without letting the model mix up document A and document B.

This keeps the judgement grounded in MinerU's parsed output rather than native multimodal inspection. The semantic agent decides which rows/columns correspond; code validates the returned JSON and maps the agent's cell refs back to MinerU-derived bounding boxes.

### Coordinate Design

MinerU emits multiple coordinate spaces. The correct source for anchoring the table on the page is `middle_json`, not `content_list`.

- `content_list.table_body` is used for table HTML and cell text.
- `middle_json.pdf_info[].page_size` is used for PDF page size.
- `middle_json` table span `bbox` is used for page-space table location.

The observed MinerU output does not include true per-cell bounding boxes. The implementation now uses a two-stage geometry strategy:

1. Build a logical cell grid from MinerU's table HTML, including row/column indexes and spans.
2. For PDF inputs, render the relevant PDF page with Poppler and detect real horizontal/vertical table ruling lines inside MinerU's table-body bbox.
3. Use those detected line positions as non-uniform row and column boundaries.
4. Fall back to uniform splitting of the MinerU table bbox only when ruling-line detection is unavailable or cannot find the expected grid.

That means regular tables still work, and bordered irregular tables with uneven column widths or row heights can be redlined accurately. The `geometrySource` field on extracted tables/cells is `pdf_ruling_lines` when the precision layer was used and `uniform_grid` when the fallback was used.

### Table Compare API

Run it with Docker:

```bash
set -a
source ~/.zshrc
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$ANTHROPIC_AUTH_TOKEN}"
export MASTRA_MODEL="${MASTRA_MODEL:-anthropic/deepseek-v4-flash}"
set +a
docker compose up --build mineru table-agent
```

Submit two documents:

```bash
curl -X POST http://127.0.0.1:8090/v1/table-comparisons \
  -F "documentA=@data/table-fixtures/base.pdf" \
  -F "documentB=@data/table-fixtures/changed.pdf"
```

The result includes:

- `different`: boolean judgement.
- `summary`, `explanation`, and `differences`: changed cell refs plus before/after text.
- `redlinePdfPath`: PDF with changed table cells marked in red.

### Table Compare Tests

Generate deterministic PDF fixtures through Gotenberg:

```bash
docker compose --profile fixtures up -d gotenberg
npm run generate:table-fixtures
docker compose --profile fixtures stop gotenberg
```

Run the local deterministic tests:

```bash
npm run test:table-unit
```

The fixture generator currently writes:

- `base.pdf`: source table.
- `identical.pdf`: no changes.
- `changed.pdf`: two body-cell changes, `C3` and `D4`.
- `changed-single-cell.pdf`: one body-cell change, `B4`.
- `changed-edge-cells.pdf`: first data cell and last data cell changes, `A2` and `D5`.
- `changed-header-and-body.pdf`: one header change and one body change, `B1` and `C5`.
- `changed-many-cells.pdf`: six changed cells across multiple rows/columns.
- `added-row.pdf`: table shape change plus added cells `A6:D6`.
- `irregular-base.pdf` and `irregular-changed.pdf`: uneven column widths and row heights, expecting `B3` and `D5`.

The fixture truth is recorded in `data/table-fixtures/manifest.json`, and the e2e test reads that manifest directly.

The local deterministic tests assert:

- the extractor prefers `middle_json` page-space bboxes over `content_list` rendered-image bboxes;
- `C3` and `D4` cell boxes are derived correctly inside the MinerU table bbox;
- irregular table comparisons use `pdf_ruling_lines`, not the uniform fallback;
- irregular table cell boxes are materially non-uniform, proving actual PDF grid boundaries were used;
- identical tables return `different=false`;
- changed tables return `different=true`;
- the written `explanation` names exact cells and before/after values;
- redline PDF generation produces a valid PDF.

Run the live Docker/API e2e tests:

```bash
docker compose up -d mineru table-agent
npm run test:table-e2e
docker compose stop table-agent mineru
```

The e2e test submits every manifest case, verifies the exact expected diff refs and before/after values, downloads every redline PDF, and checks each downloaded file is a valid PDF.

For visual inspection, render a redline with Poppler:

```bash
docker run --rm -v "$PWD:/work" minidocks/poppler \
  pdftoppm -png -singlefile -r 144 \
  /work/data/table-compare/test-artifacts/base-vs-changed-many-cells-redline.pdf \
  /work/data/table-compare/test-artifacts/base-vs-changed-many-cells-redline
```

See `docs/TABLE_COMPARE_AGENT.md` for the full file map and fixture workflow.

### Example Run Bundle

Generate five illustrative table-comparison runs, including vector PDFs, PNG table images, scanned/image-only PDFs, irregular row/column geometry, wide notes columns, and an 8x8 table:

```bash
set -a
source ~/.zshrc
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$ANTHROPIC_AUTH_TOKEN}"
export MASTRA_MODEL="${MASTRA_MODEL:-anthropic/deepseek-v4-flash}"
set +a
docker compose --profile fixtures up -d gotenberg mineru table-agent
npm run create:table-examples
```

The script writes `data/table-example-runs/<example>/input/` with `base.pdf`/`changed.pdf` or `base.png`/`changed.png`, and `data/table-example-runs/<example>/output/` with `result.json` and `redline.pdf`. Each `result.json` includes the boolean judgement as `changed`, the agent text as `agentReasoningText`, the full comparison result, and the agent metadata.

### Node Dependencies

Node dependencies are intentionally tracked through `package.json` and `package-lock.json`, not by committing or keeping `node_modules` as source. Recreate dependencies when needed:

```bash
npm ci
```

Docker builds also use `npm ci`, so the `table-agent` image does not require host `node_modules`.

## Local Development

Host Python on this machine currently does not have `pip` installed for `/usr/bin/python3`, so Docker is the primary path. If you want a local dev env:

```bash
python3 -m ensurepip --upgrade
python3 -m pip install uv
uv pip install -e ".[dev]"
uvicorn pdfparse_agent.main:app --reload --port 8080
```

Set `MINERU_BASE_URL=http://127.0.0.1:8000` when running the API outside Docker.
