from collections.abc import AsyncIterator
from functools import lru_cache

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from app.core.config import get_settings

# Neon pooler 是 PgBouncer transaction 模式，不支援 prepared statement；本機也用同一套設定
CONNECT_ARGS = {"prepare_threshold": None}


@lru_cache
def get_engine() -> AsyncEngine:
    settings = get_settings()
    if settings.env == "prod":
        # Lambda 凍結後保留的連線常已斷線，jobs 每次 asyncio.run 又是新的 event loop；
        # 連線池交給 Neon pooler，這裡用完就關
        return create_async_engine(
            settings.database_url, connect_args=CONNECT_ARGS, poolclass=NullPool
        )
    return create_async_engine(settings.database_url, connect_args=CONNECT_ARGS, pool_pre_ping=True)


@lru_cache
def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with get_sessionmaker()() as session:
        yield session
