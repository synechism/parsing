FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN python -m pip install --no-cache-dir --upgrade pip uv

COPY pyproject.toml README.md /app/
COPY src /app/src

RUN uv pip install --system --no-cache .

EXPOSE 8080

CMD ["uvicorn", "pdfparse_agent.main:app", "--host", "0.0.0.0", "--port", "8080"]

