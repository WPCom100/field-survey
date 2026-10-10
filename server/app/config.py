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
    worker_concurrency: int = 1

    @property
    def team_names(self) -> list[str]:
        return [n.strip() for n in self.team_names_csv.split(",") if n.strip()]


settings = Settings()
