# Table Compare Mastra Agent

This module adds a Mastra-facing table comparison agent on top of the local GPU-backed MinerU API.

## Architecture

Request flow:

1. `POST /v1/table-comparisons` accepts `documentA` and `documentB` as multipart uploads.
2. The async API stores both inputs under `data/table-compare/input/<job_id>/`.
3. A background worker submits both documents to MinerU concurrently.
4. MinerU parses each document on the GPU and returns structured output.
5. The table extractor reads MinerU `content_list` and `middle_json`:
   - table HTML from `table_body`
   - precise page-space table body bounding boxes from `middle_json` table spans
   - page geometry from `middle_json.pdf_info[].page_size`
6. For PDF inputs, the geometry refiner renders the page and detects actual table ruling lines inside the MinerU table bbox.
7. The comparator normalizes table HTML into a cell grid and compares cells by spreadsheet-style refs such as `C3`.
8. The redline renderer draws red boxes on top of document B and writes `redline.pdf`.

The API does not wait for parsing to finish. It returns a job id immediately and exposes polling endpoints, matching the async pattern used by the existing Python parse API.

## MinerU Grounding

The comparison is intentionally grounded in MinerU structured output rather than model vision:

- Cell text comes from MinerU's parsed table HTML.
- Table location comes from MinerU table-body bounding boxes in `middle_json`.
- Page coordinate mapping comes from MinerU page sizes.

In the current observed MinerU output, precise table-body boxes are available in page coordinates, but cell-level boxes are not. The implementation first builds a logical grid from MinerU table HTML, then uses PDF ruling-line detection to recover non-uniform row and column boundaries for bordered PDF tables. If that precision layer cannot run, it falls back to splitting the MinerU table-body bbox according to the parsed row and column grid. If a future MinerU version emits true cell boxes, `src/table-compare/table-extractor.ts` and `src/table-compare/table-geometry.ts` are the right places to prefer those directly.

## Files

- `src/table-compare/server.ts`: Express async API for table comparison jobs.
- `src/table-compare/job-manager.ts`: in-memory queue, upload persistence, worker concurrency, and job state.
- `src/table-compare/mineru-client.ts`: local MinerU `/tasks` client with submit, poll, and result retrieval.
- `src/table-compare/table-extractor.ts`: converts MinerU output into tables, cells, bboxes, and page geometry.
- `src/table-compare/table-geometry.ts`: renders PDF pages with Poppler and detects actual table ruling lines for non-uniform cell bboxes.
- `src/table-compare/table-compare.ts`: deterministic cell-by-cell comparison logic.
- `src/table-compare/redline.ts`: PDF overlay rendering with `pdf-lib`.
- `src/table-compare/workflow.ts`: orchestration used by the API.
- `src/mastra/tools/*.ts`: Mastra tools wrapping parsing, comparison, and redline creation.
- `src/mastra/agents/table-compare-agent.ts`: Mastra agent definition and instructions.
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

## Docker

Start the MinerU stack plus the table comparison API:

```bash
docker compose up --build mineru table-agent
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

The table comparison API has its own worker pool controlled by `TABLE_COMPARE_WORKER_CONCURRENCY`. Each job submits both documents to MinerU concurrently, so one comparison job can occupy two MinerU task slots. Keep:

```text
TABLE_COMPARE_WORKER_CONCURRENCY * 2 <= MINERU_API_MAX_CONCURRENT_REQUESTS
```

unless a router or backpressure layer is added. The Docker default is `TABLE_COMPARE_WORKER_CONCURRENCY=2` with the existing MinerU default of `MINERU_API_MAX_CONCURRENT_REQUESTS=4`.

## Limitations

- The current redline is most precise for PDF inputs because it can draw directly on document B. DOC/DOCX and image inputs are parsed by MinerU, but this first pass creates a PDF output page rather than rendering the original non-PDF document behind the overlay.
- Cell boxes are derived from MinerU table boxes until real cell-level boxes are available.
- The Mastra agent requires a configured model provider key to run through Mastra Studio. The async API path is deterministic and does not require an LLM key.
