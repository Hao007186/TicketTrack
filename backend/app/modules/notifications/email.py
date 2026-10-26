"""寄信器：notifier 只認 EmailSender 介面，背後是 console、SMTP 還是 SES 由設定決定。"""

import asyncio
import email.message
import logging
import smtplib
import ssl
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from botocore.exceptions import BotoCoreError, ClientError
from pydantic import SecretStr

from app.core.config import Settings

if TYPE_CHECKING:
    from mypy_boto3_sesv2 import SESV2Client

logger = logging.getLogger(__name__)

SMTP_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class EmailMessage:
    to: str
    subject: str
    text: str


class EmailError(Exception):
    pass


class EmailSender(Protocol):
    async def send(self, message: EmailMessage) -> None:
        """失敗時拋 EmailError。"""
        ...


class ConsoleEmailSender:
    """本機開發用：只把信印在 log，不寄出。"""

    async def send(self, message: EmailMessage) -> None:
        logger.info(
            "[console 寄信] To: %s\nSubject: %s\n\n%s", message.to, message.subject, message.text
        )


class SmtpEmailSender:
    """STARTTLS + 帳密登入；Resend、Gmail、SES 都是同一份程式，只差設定。"""

    def __init__(
        self,
        host: str,
        port: int,
        username: str,
        password: SecretStr,
        from_addr: str,
        timeout: float = SMTP_TIMEOUT_SECONDS,
    ) -> None:
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._from = from_addr
        self._timeout = timeout

    async def send(self, message: EmailMessage) -> None:
        # smtplib 是同步的，丟到執行緒跑才不會卡住 event loop
        await asyncio.to_thread(self._send, message)

    def _send(self, message: EmailMessage) -> None:
        mime = email.message.EmailMessage()
        mime["From"] = self._from
        mime["To"] = message.to
        mime["Subject"] = message.subject
        mime.set_content(message.text)
        try:
            with smtplib.SMTP(self._host, self._port, timeout=self._timeout) as smtp:
                smtp.starttls(context=ssl.create_default_context())
                smtp.login(self._username, self._password.get_secret_value())
                smtp.send_message(mime)
        except (smtplib.SMTPException, OSError) as e:
            # from None：原始例外可能帶著密碼，不要掛在 __context__ 上
            raise EmailError(self._mask(f"{type(e).__name__}: {e}")) from None

    def _mask(self, text: str) -> str:
        secret = self._password.get_secret_value()
        return text.replace(secret, "***") if secret else text


class SesEmailSender:
    """呼叫 SES API 寄信；權限來自 Lambda 的 IAM role，不需要任何密碼。"""

    def __init__(self, from_addr: str, client: SESV2Client | None = None) -> None:
        self._from = from_addr
        # 第一次寄信時才建立，本機與測試不會連 AWS
        self._client = client

    async def send(self, message: EmailMessage) -> None:
        # boto3 是同步的，丟到執行緒跑才不會卡住 event loop
        await asyncio.to_thread(self._send, message)

    def _send(self, message: EmailMessage) -> None:
        if self._client is None:
            import boto3

            self._client = boto3.client("sesv2")
        try:
            self._client.send_email(
                FromEmailAddress=self._from,
                Destination={"ToAddresses": [message.to]},
                Content={
                    "Simple": {
                        "Subject": {"Data": message.subject, "Charset": "UTF-8"},
                        "Body": {"Text": {"Data": message.text, "Charset": "UTF-8"}},
                    }
                },
            )
        except ClientError as e:
            error = e.response.get("Error", {})
            raise EmailError(f"{error.get('Code')}: {error.get('Message')}") from None
        except BotoCoreError as e:
            raise EmailError(f"{type(e).__name__}: {e}") from None


def get_email_sender(settings: Settings) -> EmailSender:
    if settings.email_sender == "console":
        return ConsoleEmailSender()
    if settings.email_sender == "ses":
        # 設定驗證已保證 ses 時有 EMAIL_FROM
        assert settings.email_from
        return SesEmailSender(settings.email_from)
    # 設定驗證已保證 smtp 時這些欄位都有值
    assert settings.smtp_host and settings.smtp_username and settings.email_from
    assert settings.smtp_password is not None
    return SmtpEmailSender(
        host=settings.smtp_host,
        port=settings.smtp_port,
        username=settings.smtp_username,
        password=settings.smtp_password,
        from_addr=settings.email_from,
    )
