from functools import lru_cache
from typing import Literal, Self

from pydantic import SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Neon 主控台複製出來的連線字串沒有指定 driver，SQLAlchemy 預設會找 psycopg2
_PLAIN_PREFIXES = ("postgresql://", "postgres://")
_PSYCOPG_PREFIX = "postgresql+psycopg://"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    env: Literal["local", "ci", "prod"] = "local"
    log_level: str = "INFO"

    jwt_secret: str
    access_token_minutes: int = 15
    refresh_token_days: int = 7
    # 本機用 http 開發時在 .env 設 false，否則瀏覽器不會送出 cookie
    cookie_secure: bool = True

    # 本機開發預設用 mock，不會花到 SerpApi 額度
    price_provider: Literal["mock", "serpapi"] = "mock"
    serpapi_key: SecretStr | None = None

    # 本機預設只把信印在 log；smtp 給其他寄信服務；ses 用 Lambda 的 IAM 權限呼叫 SES API
    email_sender: Literal["console", "smtp", "ses"] = "console"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    email_from: str | None = None
    # 信中「查看追蹤」連結的開頭（前端網址）
    app_base_url: str = "http://localhost:5173"
    # CloudFront 轉送時帶的 X-Origin-Verify 密碼；沒設就不檢查（本機）
    origin_verify_secret: SecretStr | None = None

    @field_validator("database_url")
    @classmethod
    def _use_psycopg_driver(cls, v: str) -> str:
        for prefix in _PLAIN_PREFIXES:
            if v.startswith(prefix):
                return _PSYCOPG_PREFIX + v.removeprefix(prefix)
        return v

    @model_validator(mode="after")
    def _serpapi_needs_key(self) -> Self:
        if self.price_provider == "serpapi" and self.serpapi_key is None:
            raise ValueError("PRICE_PROVIDER=serpapi 時必須設定 SERPAPI_KEY")
        return self

    @model_validator(mode="after")
    def _prod_needs_real_base_url(self) -> Self:
        # 信裡的連結用這個網址，正式環境還是 localhost 的話連結會壞掉
        if self.env == "prod" and "localhost" in self.app_base_url:
            raise ValueError("ENV=prod 時 APP_BASE_URL 必須是正式網址，不能是 localhost")
        return self

    @model_validator(mode="after")
    def _prod_needs_origin_secret(self) -> Self:
        # 漏設時來源檢查會悄悄關閉，任何人都能直接打公開的 Function URL
        secret = self.origin_verify_secret
        if self.env == "prod" and (secret is None or not secret.get_secret_value()):
            raise ValueError("ENV=prod 時必須設定 ORIGIN_VERIFY_SECRET")
        return self

    @model_validator(mode="after")
    def _ses_needs_from(self) -> Self:
        if self.email_sender == "ses" and not self.email_from:
            raise ValueError("EMAIL_SENDER=ses 時必須設定 EMAIL_FROM")
        return self

    @model_validator(mode="after")
    def _smtp_needs_fields(self) -> Self:
        if self.email_sender != "smtp":
            return self
        required = {
            "SMTP_HOST": self.smtp_host,
            "SMTP_USERNAME": self.smtp_username,
            "SMTP_PASSWORD": self.smtp_password,
            "EMAIL_FROM": self.email_from,
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise ValueError(f"EMAIL_SENDER=smtp 時必須設定 {', '.join(missing)}")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
