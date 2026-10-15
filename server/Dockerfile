FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
# Backups (app/backup.py): pg_dump/pg_restore matching the postgres:16 server (PGDG), and rclone.
# fonts-dejavu-core: the bold font the export uses to flatten photo markup text (app/jobs/markup.py).
# libpango-1.0-0, libpangoft2-1.0-0, libharfbuzz-subset0: WeasyPrint's libraries (floor PDF, T59).
# tesseract-ocr: OCR for BOM pages with no text layer (app/ocr.py, T42).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg rclone fonts-dejavu-core \
    libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 tesseract-ocr \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./
ENV PATH="/srv/.venv/bin:$PATH"
# Last, so a new commit only rebuilds this layer. /health reports it (D154, server/deploy/deploy.sh).
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
