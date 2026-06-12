# Table Compare Mastra Agent

This module adds a Mastra-facing table comparison agent on top of the local GPU-backed MinerU API.

## Architecture

Request flow:

1. `POST /v1/table-comparisons` accepts `documentA` and `documentB` as multipart uploads.
2. The async API stores both inputs under `data/table-compare/jobs/<job_id>/input/`.
3. `src/table-compare/job-manager.ts` enqueues a BullMQ job in Redis.
4. `src/table-compare/worker.ts` claims the job and calls `src/table-compare/workflow.ts`.
5. `workflow.ts` retrieves `semanticTableCompareAgent` from the Mastra registry and calls `agent.generate(...)`.
6. The semantic agent invokes `parse-document-pair-tables-with-mineru` once with both input paths.
7. The MinerU tool submits both documents to the local MinerU API.
8. MinerU parses each document on the GPU and returns structured output.
9. The table extractor reads MinerU `content_list` and `middle_json`:
   - table HTML from `table_body`
   - precise page-space table body bounding boxes from `middle_json` table spans
   - page geometry from `middle_json.pdf_info[].page_size`
10. For PDF inputs, the geometry refiner renders the page and detects actual table ruling lines inside the MinerU table bbox.
11. `workflow.ts` builds a compact semantic evidence prompt from the parsed cell grid and same-grid candidate differences.
12. The same semantic agent returns a JSON comparison plan with row matches, changed cell refs, explanations, and ignored non-material fields.
13. `semantic-compare.ts` validates the plan, applies deterministic template-noise cleanup, and maps refs such as `C3` back to MinerU-derived bounding boxes.
14. The redline renderer draws red boxes on top of the selected baseline document and writes `redline.pdf`.

The API does not wait for parsing to finish. It returns a job id immediately and exposes polling endpoints, matching the async pattern used by the existing Python parse API.

## MinerU Grounding

The comparison is intentionally grounded in MinerU structured output rather than model vision:

- Cell text comes from MinerU's parsed table HTML.
- Table location comes from MinerU table-body bounding boxes in `middle_json`.
- Page coordinate mapping comes from MinerU page sizes.

In the current observed MinerU output, precise table-body boxes are available in page coordinates, but cell-level boxes are not. The implementation first builds a logical grid from MinerU table HTML, then uses PDF ruling-line detection to recover non-uniform row and column boundaries for bordered PDF tables. If that precision layer cannot run, it falls back to splitting the MinerU table-body bbox according to the parsed row and column grid. If a future MinerU version emits true cell boxes, `src/table-compare/table-extractor.ts` and `src/table-compare/table-geometry.ts` are the right places to prefer those directly.

## Files

- `src/table-compare/server.ts`: Express async API for table comparison jobs.
- `src/table-compare/job-manager.ts`: upload persistence plus BullMQ job creation/status/result access.
- `src/table-compare/queue.ts`: shared BullMQ queue name and Redis connection options.
- `src/table-compare/worker.ts`: BullMQ worker process that runs `compareTwoDocuments(...)`.
- `src/table-compare/mineru-client.ts`: local MinerU `/tasks` client with submit, poll, and result retrieval.
- `src/table-compare/table-extractor.ts`: converts MinerU output into tables, cells, bboxes, and page geometry.
- `src/table-compare/table-geometry.ts`: renders PDF pages with Poppler and detects actual table ruling lines for non-uniform cell bboxes.
- `src/table-compare/table-compare.ts`: legacy exact cell-by-cell comparison helper for focused diagnostics.
- `src/table-compare/semantic-compare.ts`: validates semantic-agent JSON plans, filters template-only semantic noise, and maps returned cell refs to MinerU-derived boxes.
- `src/table-compare/redline.ts`: PDF overlay rendering with `pdf-lib`.
- `src/table-compare/workflow.ts`: API-to-agent bridge; calls `semanticTableCompareAgent.generate(...)`, requires MinerU parse tool calls, runs semantic judgement, and writes the redline.
- `src/mastra/tools/mineru-table-tools.ts`: MinerU parsing tool and shared parsing helper.
- `src/mastra/tools/redline-pdf-tool.ts`: redline PDF tool for direct agent use.
- `src/mastra/agents/semantic-table-compare-agent.ts`: the single API-facing Mastra agent; it invokes MinerU parsing tools and performs semantic row/column matching from structured table evidence.
- `src/mastra/skills/compare-two-tables.md`: operational skill instructions for the compare workflow.
- `scripts/generate_table_fixtures.ts`: deterministic table fixture PDF generation through Gotenberg.
- `docker/mastra-agent.Dockerfile`: container for the Node/Mastra table comparison API.

## API

Submit:

```bash
curl -X POST http://127.0.0.1:8090/v1/table-comparisons \
  -F "documentA=@data/table-fixtures/base.pdf" \
  -F "documentB=@data/table-fixtures/changed.pdf"
```

Poll:

```bash
curl http://127.0.0.1:8090/v1/table-comparisons/<job_id>
curl http://127.0.0.1:8090/v1/table-comparisons/<job_id>/result
```

Download redline:

```bash
curl -o redline.pdf http://127.0.0.1:8090/v1/table-comparisons/<job_id>/redline.pdf
```

## Example Run Bundle

Create five illustrative examples:

```bash
set -a
source ~/.zshrc
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$ANTHROPIC_AUTH_TOKEN}"
export MASTRA_MODEL="${MASTRA_MODEL:-anthropic/deepseek-v4-flash}"
set +a
docker compose --profile fixtures up -d gotenberg mineru redis table-agent table-worker
npm run create:table-examples
```

The generated `data/table-example-runs/` directory contains one folder per run. Each run has:

- `input/base.pdf` and `input/changed.pdf`, or `input/base.png` and `input/changed.png`;
- `output/result.json` with `changed`, `agentReasoningText`, the full comparison result, and agent metadata;
- `output/redline.pdf`.

The examples include vector PDFs, PNG inputs parsed by MinerU, scanned/image-only PDFs, irregular row and column sizing, wide notes columns, and an 8x8 table.

## Docker

Start the MinerU stack plus Redis, the table comparison API, and the worker:

```bash
set -a
source ~/.zshrc
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$ANTHROPIC_AUTH_TOKEN}"
export MASTRA_MODEL="${MASTRA_MODEL:-anthropic/deepseek-v4-flash}"
set +a
docker compose up --build mineru redis table-agent table-worker
```

Generate deterministic fixture PDFs:

```bash
docker compose --profile fixtures up -d gotenberg
GOTENBERG_URL=http://127.0.0.1:3001 npm run generate:table-fixtures
```

Expected fixture truth:

- `base.pdf` vs `identical.pdf`: no differences.
- `base.pdf` vs `changed.pdf`: `C3` changes from `$101,750` to `$104,250`; `D4` changes from `Review` to `Escalated`.

## Concurrency

The table comparison worker pool is now `src/table-compare/worker.ts`, backed by BullMQ and Redis. `TABLE_COMPARE_WORKER_CONCURRENCY` controls how many BullMQ jobs one `table-worker` process can run at once. Each job may parse two documents, so keep this aligned with `MINERU_API_MAX_CONCURRENT_REQUESTS` and available GPU memory.

See `docs/BULLMQ_REDIS_TABLE_COMPARE.md` for the full Redis/BullMQ job lifecycle.

## Limitations

- The current redline is most precise for PDF inputs because it can draw directly on document B. DOC/DOCX and image inputs are parsed by MinerU, but this first pass creates a PDF output page rather than rendering the original non-PDF document behind the overlay.
- Cell boxes are derived from MinerU table boxes until real cell-level boxes are available.
- The async API path now invokes the Mastra agent, so `table-agent` needs a configured model provider key. The Docker startup maps `ANTHROPIC_AUTH_TOKEN` to `ANTHROPIC_API_KEY` when needed.
