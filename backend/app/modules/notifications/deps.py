"""寄信器 dependency；獨立出來，查價與帳號流程共用，測試也才換得掉。"""

from typing import Annotated

from fastapi import Depends

from app.core.config import Settings, get_settings
from app.modules.notifications.email import EmailSender, get_email_sender


def get_sender(settings: Annotated[Settings, Depends(get_settings)]) -> EmailSender:
    return get_email_sender(settings)


SenderDep = Annotated[EmailSender, Depends(get_sender)]
