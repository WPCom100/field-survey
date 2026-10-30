FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
# Backups (app/backup.py): pg_dump/pg_restore matching the postgres:16 server (PGDG), and rclone
# from its own release (Debian's 1.60 is from 2022; T123), pinned by version and sha256.
# fonts-dejavu-core: the bold font the export uses to flatten photo markup text (app/jobs/markup.py).
# libpango-1.0-0, libpangoft2-1.0-0, libharfbuzz-subset0: WeasyPrint's libraries (floor PDF, T59).
# tesseract-ocr: OCR for BOM pages with no text layer (app/ocr.py, T42).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg fonts-dejavu-core \
    libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 tesseract-ocr \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
# Not RCLONE_*-named like the flags: rclone reads RCLONE_<FLAG> from the environment.
ARG RCLONE_RELEASE=v1.75.2
ARG RCLONE_ZIP_SHA256=349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702
RUN curl -fsSLo /tmp/rclone.zip https://downloads.rclone.org/$RCLONE_RELEASE/rclone-$RCLONE_RELEASE-linux-amd64.zip \
 && echo "$RCLONE_ZIP_SHA256  /tmp/rclone.zip" | sha256sum -c - \
 && python -c "import zipfile; z = zipfile.ZipFile('/tmp/rclone.zip'); open('/usr/local/bin/rclone', 'wb').write(z.read('rclone-$RCLONE_RELEASE-linux-amd64/rclone'))" \
 && chmod 755 /usr/local/bin/rclone && rm /tmp/rclone.zip && rclone version
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
