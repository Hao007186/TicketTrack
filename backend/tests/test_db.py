from collections.abc import Iterator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.pool import NullPool

from app.core.config import get_settings
from app.db.session import get_engine


async def test_select_one(db_session: AsyncSession) -> None:
    assert (await db_session.execute(text("SELECT 1"))).scalar_one() == 1


# Neon pooler（PgBouncer transaction 模式）遇到 prepared statement 會出錯，本機 Postgres 不會重現
async def test_prepared_statements_disabled(db_session: AsyncSession) -> None:
    conn = await db_session.connection()
    raw = await conn.get_raw_connection()
    assert raw.driver_connection.prepare_threshold is None  # type: ignore[union-attr]


async def test_rollback_isolation_part1(db_session: AsyncSession) -> None:
    await db_session.execute(text("CREATE TABLE _iso_probe (id int)"))


async def test_rollback_isolation_part2(db_session: AsyncSession) -> None:
    exists = (await db_session.execute(text("SELECT to_regclass('_iso_probe')"))).scalar_one()
    assert exists is None


@pytest.fixture
def fresh_engine_cache() -> Iterator[None]:
    get_settings.cache_clear()
    get_engine.cache_clear()
    yield
    # 還原成測試環境的設定與 engine
    get_settings.cache_clear()
    get_engine.cache_clear()


@pytest.mark.usefixtures("fresh_engine_cache")
def test_prod_engine_uses_null_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENV", "prod")
    monkeypatch.setenv("APP_BASE_URL", "https://farewatch.example")
    monkeypatch.setenv("ORIGIN_VERIFY_SECRET", "s3cret")
    assert isinstance(get_engine().pool, NullPool)


@pytest.mark.usefixtures("fresh_engine_cache")
def test_local_engine_is_pooled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ENV", raising=False)
    assert not isinstance(get_engine().pool, NullPool)
