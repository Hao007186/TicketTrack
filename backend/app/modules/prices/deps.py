"""API 用的查價來源與寄信器；獨立成 dependency，測試才換得掉。"""

from collections.abc import AsyncIterator
from typing import Annotated

import httpx
from fastapi import Depends

from app.core.config import Settings, get_settings
from app.modules.notifications.email import EmailSender, get_email_sender
from app.modules.prices.instant import INSTANT_TIMEOUT_SECONDS
from app.modules.prices.providers import get_provider
from app.modules.prices.providers.base import PriceProvider

SettingsDep = Annotated[Settings, Depends(get_settings)]


async def get_price_provider(settings: SettingsDep) -> AsyncIterator[PriceProvider]:
    async with httpx.AsyncClient(timeout=INSTANT_TIMEOUT_SECONDS) as client:
        yield get_provider(settings, client)


def get_sender(settings: SettingsDep) -> EmailSender:
    return get_email_sender(settings)


ProviderDep = Annotated[PriceProvider, Depends(get_price_provider)]
SenderDep = Annotated[EmailSender, Depends(get_sender)]
