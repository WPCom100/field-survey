from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # The commit this image was built from (Dockerfile build arg, D154); "dev" outside a deploy.
    git_sha: str = "dev"
    database_url: str = "postgresql+psycopg://survey:survey@localhost:5432/survey"
    # "token" (shared token + X-Survey-User, D69), "entra" (Entra ID access token, T03) or
    # "both" (either, while the iPads move to the sign-in build; D264).
    auth_mode: str = "token"
    survey_shared_token: str = ""
    team_names_csv: str = ""
    # Entra ID sign-in (T03, D264). Issuer and JWKS URL default to the tenant's v2.0 endpoints;
    # ENTRA_AUDIENCE is comma-separated (the API's client id, and/or api://field-survey).
    entra_tenant_id: str = ""
    entra_audience: str = ""
    entra_issuer: str = ""
    entra_jwks_url: str = ""
    entra_leeway_seconds: int = 120
    s3_endpoint: str = "http://localhost:9000"
    s3_bucket: str = "survey"
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_region: str = "auto"
    # Largest blob accepted by POST /blobs/{sha} (T12); display sheets are the biggest.
    blob_max_bytes: int = 512 * 1024 * 1024
    worker_concurrency: int = 1
    # Backups (T06, docs/ops.md §3): nightly pg_dump to S3_BUCKET/backups/pg/, weekly rclone
    # copy of the whole bucket to BACKUP_COPY_BUCKET (skipped while that is empty).
    backup_enabled: bool = False
    backup_hour_utc: int = 8
    backup_retention_days: int = 90
    backup_copy_bucket: str = ""
    backup_copy_weekday: int = 7
    backup_copy_endpoint: str = ""
    backup_copy_access_key: str = ""
    backup_copy_secret_key: str = ""
    # The copy runs inside the serial worker loop: it is killed after this long, and a failed
    # copy is not retried until the next day (T123).
    backup_copy_timeout_minutes: int = 60
    # Daily master export backup (D149, T82): from BACKUP_HOUR_UTC, gated by BACKUP_ENABLED; one
    # xlsx export per project by the `export` system user, skipped when nothing changed; files
    # older than this are deleted (each project's newest is kept).
    export_backup_retention_days: int = 183
    # Claude API for extraction (D189, T43): the key lives only in the server `.env`; the model
    # is Opus 5.5 unless stepped up. Empty key = the riser job runs without endpoints (D11).
    anthropic_api_key: str = ""
    claude_model: str = "claude-opus-5-5"

    @property
    def team_names(self) -> list[str]:
        return [n.strip() for n in self.team_names_csv.split(",") if n.strip()]

    @property
    def entra_audiences(self) -> list[str]:
        return [a.strip() for a in self.entra_audience.split(",") if a.strip()]

    @property
    def entra_issuer_url(self) -> str:
        if self.entra_issuer:
            return self.entra_issuer
        tenant = self.entra_tenant_id.strip()
        return f"https://login.microsoftonline.com/{tenant}/v2.0" if tenant else ""

    @property
    def entra_keys_url(self) -> str:
        if self.entra_jwks_url:
            return self.entra_jwks_url
        tenant = self.entra_tenant_id.strip()
        return f"https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys" if tenant else ""


settings = Settings()
