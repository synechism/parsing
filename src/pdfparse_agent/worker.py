import asyncio
from collections.abc import Iterable
from datetime import datetime

from .mineru_client import MinerUClient
from .models import JobRecord, JobStatus
from .storage import Storage


class JobManager:
    def __init__(self, mineru: MinerUClient, storage: Storage, concurrency: int = 1):
        self.mineru = mineru
        self.storage = storage
        self.concurrency = concurrency
        self.jobs: dict[str, JobRecord] = {}
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.workers: list[asyncio.Task[None]] = []
        self._started = False

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        self.workers = [
            asyncio.create_task(self._worker_loop(index), name=f"parse-worker-{index}")
            for index in range(self.concurrency)
        ]

    async def stop(self) -> None:
        for worker in self.workers:
            worker.cancel()
        if self.workers:
            await asyncio.gather(*self.workers, return_exceptions=True)
        self.workers = []
        self._started = False

    async def submit(self, job: JobRecord) -> JobRecord:
        self.jobs[job.id] = job
        await self.queue.put(job.id)
        self._refresh_queued_positions()
        return job

    def get(self, job_id: str) -> JobRecord | None:
        return self.jobs.get(job_id)

    def iter_jobs(self) -> Iterable[JobRecord]:
        return self.jobs.values()

    def _refresh_queued_positions(self) -> None:
        queued_ids = list(self.queue._queue)  # asyncio.Queue intentionally has no snapshot API.
        for job in self.jobs.values():
            if job.status != JobStatus.queued:
                job.queued_ahead = 0
                continue
            try:
                job.queued_ahead = queued_ids.index(job.id)
            except ValueError:
                job.queued_ahead = None

    async def _worker_loop(self, index: int) -> None:
        del index
        while True:
            job_id = await self.queue.get()
            self._refresh_queued_positions()
            try:
                job = self.jobs.get(job_id)
                if job is not None:
                    await self._process(job)
            finally:
                self.queue.task_done()

    async def _process(self, job: JobRecord) -> None:
        job.status = JobStatus.submitting
        job.started_at = datetime.now().astimezone()
        job.touch()
        try:
            submission = await self.mineru.submit_task(job.input_paths, job.options)
            job.mineru_task_id = submission["task_id"]
            job.mineru_status_url = submission.get("status_url")
            job.mineru_result_url = submission.get("result_url")
            job.status = JobStatus.processing
            job.touch()

            job.result = await self.mineru.wait_for_result(job.mineru_task_id)
            job.status = JobStatus.completed
            job.completed_at = datetime.now().astimezone()
            job.result_path = self.storage.write_result(job)
            job.touch()
        except Exception as exc:
            job.status = JobStatus.failed
            job.error = str(exc)
            job.completed_at = datetime.now().astimezone()
            job.touch()

