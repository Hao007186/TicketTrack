from datetime import timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.prices.models import PriceBaseline
from app.modules.users.models import User
from app.modules.watches.models import Watch
from app.seeds.demo import ensure_demo_user
from tests.conftest import create_user
from tests.prices.conftest import TODAY, auth_headers, demo_headers, insert_watch

URL = "/api/v1/price-reference"
DEPART = (TODAY + timedelta(days=30)).isoformat()
PARAMS: dict[str, Any] = {"origin": "TPE", "destination": "NRT", "depart_date": DEPART}
EMPTY = {"typical_low": None, "typical_high": None, "updated_at": None}


async def _alice(session: AsyncSession) -> User:
    user = await session.scalar(select(User).where(User.email == "alice@example.com"))
    assert user is not None
    return user


async def _add_baseline(
    session: AsyncSession, watch: Watch, low: int | None = 6400, high: int | None = 12500
) -> None:
    session.add(
        PriceBaseline(
            price_query_id=watch.price_query_id,
            typical_low=low,
            typical_high=high,
            record_low=5000,
            history_seeded=True,
            sample_count=1,
        )
    )
    await session.flush()


async def test_hit(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await auth_headers(client, db_session)
    await _add_baseline(db_session, await insert_watch(db_session, await _alice(db_session)))

    resp = await client.get(URL, params=PARAMS, headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"typical_low", "typical_high", "updated_at"}
    assert (body["typical_low"], body["typical_high"]) == (6400, 12500)
    assert body["updated_at"] is not None


async def test_other_users_query(client: AsyncClient, db_session: AsyncSession) -> None:
    await auth_headers(client, db_session)
    bob = await auth_headers(client, db_session, email="bob@example.com")
    await _add_baseline(db_session, await insert_watch(db_session, await _alice(db_session)))

    body = (await client.get(URL, params=PARAMS, headers=bob)).json()
    assert (body["typical_low"], body["typical_high"]) == (6400, 12500)


async def test_miss_no_query(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await auth_headers(client, db_session)
    await _add_baseline(db_session, await insert_watch(db_session, await _alice(db_session)))

    resp = await client.get(URL, params={**PARAMS, "destination": "KIX"}, headers=headers)
    assert resp.status_code == 200
    assert resp.json() == EMPTY


async def test_miss_no_baseline(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await auth_headers(client, db_session)
    await insert_watch(db_session, await _alice(db_session))

    assert (await client.get(URL, params=PARAMS, headers=headers)).json() == EMPTY


async def test_miss_no_typical(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await auth_headers(client, db_session)
    watch = await insert_watch(db_session, await _alice(db_session))
    await _add_baseline(db_session, watch, low=None, high=None)

    assert (await client.get(URL, params=PARAMS, headers=headers)).json() == EMPTY


async def test_airlines_normalized(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await auth_headers(client, db_session)
    watch = await insert_watch(db_session, await _alice(db_session), airlines=("BR", "CI"))
    await _add_baseline(db_session, watch)

    params = [*PARAMS.items(), ("airlines", "ci"), ("airlines", "BR")]
    body = (await client.get(URL, params=params, headers=headers)).json()
    assert body["typical_low"] == 6400
    assert (await client.get(URL, params=PARAMS, headers=headers)).json() == EMPTY


async def test_round_trip(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await auth_headers(client, db_session)
    return_date = TODAY + timedelta(days=35)
    watch = await insert_watch(db_session, await _alice(db_session), return_date=return_date)
    await _add_baseline(db_session, watch)

    assert (await client.get(URL, params=PARAMS, headers=headers)).json() == EMPTY
    params = {**PARAMS, "return_date": return_date.isoformat()}
    assert (await client.get(URL, params=params, headers=headers)).json()["typical_low"] == 6400


async def test_past_dates_ok(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await auth_headers(client, db_session)
    depart = TODAY - timedelta(days=5)
    watch = await insert_watch(db_session, await _alice(db_session), depart_date=depart)
    await _add_baseline(db_session, watch)

    params = {**PARAMS, "depart_date": depart.isoformat()}
    assert (await client.get(URL, params=params, headers=headers)).json()["typical_low"] == 6400


async def test_demo_isolation(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await auth_headers(client, db_session)
    await _add_baseline(db_session, await insert_watch(db_session, await _alice(db_session)))
    demo = await ensure_demo_user(db_session)
    kix = await insert_watch(db_session, demo, destination="KIX", is_demo=True)
    await _add_baseline(db_session, kix, low=3000, high=5000)
    demo_auth = await demo_headers(client, db_session)

    nrt_by_demo = await client.get(URL, params=PARAMS, headers=demo_auth)
    assert nrt_by_demo.status_code == 200
    assert nrt_by_demo.json() == EMPTY
    kix_params = {**PARAMS, "destination": "KIX"}
    assert (await client.get(URL, params=kix_params, headers=headers)).json() == EMPTY
    assert (await client.get(URL, params=kix_params, headers=demo_auth)).json()[
        "typical_low"
    ] == 3000


async def test_requires_login(client: AsyncClient, db_session: AsyncSession) -> None:
    owner = await create_user(db_session, email="owner@example.com")
    await _add_baseline(db_session, await insert_watch(db_session, owner))
    assert (await client.get(URL, params=PARAMS)).status_code == 401


async def test_invalid(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await auth_headers(client, db_session)
    same = await client.get(URL, params={**PARAMS, "destination": "TPE"}, headers=headers)
    assert same.status_code == 422
    early_return = (TODAY + timedelta(days=29)).isoformat()
    backwards = await client.get(
        URL, params={**PARAMS, "return_date": early_return}, headers=headers
    )
    assert backwards.status_code == 422
