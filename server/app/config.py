from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://survey:survey@localhost:5432/survey"
    auth_mode: str = "token"
    survey_shared_token: str = ""
    team_names_csv: str = ""
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

    @property
    def team_names(self) -> list[str]:
        return [n.strip() for n in self.team_names_csv.split(",") if n.strip()]


settings = Settings()
