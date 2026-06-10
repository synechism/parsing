from functools import lru_cache
from pathlib import Path

from pydantic import AnyHttpUrl, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="", env_file=".env", extra="ignore")

    app_host: str = "0.0.0.0"
    app_port: int = 8080
    mineru_base_url: AnyHttpUrl = "http://mineru:8000"
    storage_root: Path = Path("/data")
    worker_concurrency: int = Field(default=1, ge=1)
    mineru_timeout_seconds: float = Field(default=60.0, gt=0)
    job_poll_interval_seconds: float = Field(default=2.0, gt=0)
    job_result_timeout_seconds: float = Field(default=7200.0, gt=0)
    default_backend: str = "hybrid-auto-engine"
    default_parse_method: str = "auto"
    default_lang: str = "en"
    require_mineru_health_on_startup: bool = True
    max_upload_bytes: int = Field(default=512 * 1024 * 1024, gt=0)

    @property
    def input_dir(self) -> Path:
        return self.storage_root / "input"

    @property
    def result_dir(self) -> Path:
        return self.storage_root / "results"

    @property
    def tmp_dir(self) -> Path:
        return self.storage_root / "tmp"


@lru_cache
def get_settings() -> Settings:
    return Settings()

