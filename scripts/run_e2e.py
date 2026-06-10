#!/usr/bin/env python3
import argparse
import asyncio
import json
from pathlib import Path
from time import monotonic
from typing import Any

import httpx


def score_result(result: dict[str, Any]) -> dict[str, Any]:
    serialized = json.dumps(result, ensure_ascii=False)
    return {
        "has_markdown": "md_content" in serialized and len(serialized) > 1000,
        "has_table_signal": any(token in serialized.lower() for token in ("<table", "table_body", "table")),
        "has_image_signal": any(token in serialized.lower() for token in ("image", "img_path", "data:image")),
        "result_bytes": len(serialized.encode("utf-8")),
    }


async def submit_and_wait(
    client: httpx.AsyncClient,
    api_url: str,
    pdf_path: Path,
    timeout_seconds: float,
) -> dict[str, Any]:
    with pdf_path.open("rb") as handle:
        response = await client.post(
            f"{api_url}/v1/parse",
            data={
                "backend": "hybrid-auto-engine",
                "parse_method": "auto",
                "lang": "en",
                "return_md": "true",
                "return_middle_json": "true",
                "return_content_list": "true",
                "return_images": "false",
            },
            files={"files": (pdf_path.name, handle, "application/pdf")},
        )
    response.raise_for_status()
    submitted = response.json()
    job_id = submitted["job_id"]

    deadline = monotonic() + timeout_seconds
    while monotonic() < deadline:
        status_response = await client.get(f"{api_url}/v1/jobs/{job_id}")
        status_response.raise_for_status()
        status = status_response.json()
        if status["status"] == "completed":
            result_response = await client.get(f"{api_url}/v1/jobs/{job_id}/result")
            result_response.raise_for_status()
            result = result_response.json()
            return {
                "pdf": str(pdf_path),
                "job_id": job_id,
                "status": "completed",
                **score_result(result),
            }
        if status["status"] == "failed":
            return {
                "pdf": str(pdf_path),
                "job_id": job_id,
                "status": "failed",
                "error": status.get("error"),
            }
        await asyncio.sleep(5)

    return {"pdf": str(pdf_path), "job_id": job_id, "status": "timeout"}


async def run(args: argparse.Namespace) -> None:
    pdfs = sorted(args.pdf_dir.glob("*.pdf"))
    if not pdfs:
        raise SystemExit(f"No PDFs found in {args.pdf_dir}. Run scripts/download_test_pdfs.py first.")

    limits = httpx.Limits(max_connections=args.concurrency, max_keepalive_connections=args.concurrency)
    async with httpx.AsyncClient(timeout=60, limits=limits) as client:
        health = await client.get(f"{args.api_url}/health")
        health.raise_for_status()
        print(json.dumps({"api_health": health.json()}, indent=2))

        semaphore = asyncio.Semaphore(args.concurrency)

        async def guarded(pdf: Path) -> dict[str, Any]:
            async with semaphore:
                print(f"Submitting {pdf}")
                return await submit_and_wait(client, args.api_url, pdf, args.timeout_seconds)

        results = await asyncio.gather(*(guarded(pdf) for pdf in pdfs))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))
    print(f"Wrote {args.out}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-url", default="http://127.0.0.1:8080")
    parser.add_argument("--pdf-dir", type=Path, default=Path("data/test-pdfs"))
    parser.add_argument("--out", type=Path, default=Path("data/e2e-summary.json"))
    parser.add_argument("--timeout-seconds", type=float, default=7200)
    parser.add_argument("--concurrency", type=int, default=1)
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()

