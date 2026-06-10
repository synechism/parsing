import asyncio
import mimetypes
from pathlib import Path
from time import monotonic
from typing import Any

import httpx

from .models import ParseOptions


class MinerUClient:
    def __init__(
        self,
        base_url: str,
        timeout_seconds: float,
        poll_interval_seconds: float,
        result_timeout_seconds: float,
    ):
        self.base_url = base_url.rstrip("/")
        self.poll_interval_seconds = poll_interval_seconds
        self.result_timeout_seconds = result_timeout_seconds
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(timeout_seconds, read=timeout_seconds),
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def health(self) -> dict[str, Any]:
        response = await self.client.get("/health")
        response.raise_for_status()
        return response.json()

    async def submit_task(self, paths: list[Path], options: ParseOptions) -> dict[str, Any]:
        files = []
        handles = []
        try:
            for path in paths:
                media_type = mimetypes.guess_type(path.name)[0] or "application/pdf"
                handle = path.open("rb")
                handles.append(handle)
                files.append(("files", (path.name, handle, media_type)))

            data = {
                "lang_list": options.lang,
                "backend": options.backend,
                "parse_method": options.parse_method,
                "formula_enable": str(options.formula_enable).lower(),
                "table_enable": str(options.table_enable).lower(),
                "image_analysis": str(options.image_analysis).lower(),
                "return_md": str(options.return_md).lower(),
                "return_middle_json": str(options.return_middle_json).lower(),
                "return_model_output": str(options.return_model_output).lower(),
                "return_content_list": str(options.return_content_list).lower(),
                "return_images": str(options.return_images).lower(),
                "response_format_zip": str(options.response_format_zip).lower(),
                "start_page_id": str(options.start_page_id),
                "end_page_id": str(options.end_page_id),
            }
            response = await self.client.post("/tasks", data=data, files=files)
            response.raise_for_status()
            return response.json()
        finally:
            for handle in handles:
                handle.close()

    async def wait_for_result(self, task_id: str) -> dict[str, Any]:
        deadline = monotonic() + self.result_timeout_seconds
        last_status: dict[str, Any] | None = None
        while monotonic() < deadline:
            status_response = await self.client.get(f"/tasks/{task_id}")
            status_response.raise_for_status()
            last_status = status_response.json()
            status = last_status.get("status")
            if status == "completed":
                result_response = await self.client.get(f"/tasks/{task_id}/result")
                result_response.raise_for_status()
                return result_response.json()
            if status == "failed":
                raise RuntimeError(last_status.get("error") or "MinerU task failed")
            await asyncio.sleep(self.poll_interval_seconds)
        raise TimeoutError(f"Timed out waiting for MinerU task {task_id}: {last_status}")

