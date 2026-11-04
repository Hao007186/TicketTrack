from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.alerts.models import Alert, AlertDelivery, WatchAlertState
from app.modules.alerts.service import alert_on_recent_price, reset_state
from app.modules.notifications.models import Notification, NotificationSetting
from app.modules.prices.models import PriceSnapshot
from app.modules.users.models import User
from app.modules.watches.models import Watch
from tests.alerts.conftest import insert_watch
from tests.conftest import create_user

NOW = datetime(2026, 11, 1, 2, 0, tzinfo=UTC)


async def _setup(session: AsyncSession, target_price: int = 9500) -> tuple[User, Watch]:
    user = await create_user(session)
    return user, await insert_watch(session, user, target_price=target_price)


async def _snapshot(
    session: AsyncSession, watch: Watch, price: int = 9000, age: timedelta = timedelta(hours=1)
) -> PriceSnapshot:
    snapshot = PriceSnapshot(
        price_query_id=watch.price_query_id,
        provider="fake",
        price=price,
        stops=0,
        observed_at=NOW - age,
    )
    session.add(snapshot)
    await session.flush()
    return snapshot


async def _count(session: AsyncSession, model: type[object]) -> int:
    return await session.scalar(select(func.count()).select_from(model)) or 0


async def _state(session: AsyncSession, watch: Watch) -> WatchAlertState | None:
    return await session.get(WatchAlertState, watch.id, populate_existing=True)


async def test_recent_price_below_target_notifies(db_session: AsyncSession) -> None:
    user, watch = await _setup(db_session)
    snapshot = await _snapshot(db_session, watch)

    assert await alert_on_recent_price(db_session, watch, NOW) is True

    alert = await db_session.scalar(select(Alert))
    assert alert is not None
    assert (alert.watch_id, alert.snapshot_id, alert.reason, alert.price) == (
        watch.id,
        snapshot.id,
        "below_target",
        9000,
    )
    # 通知時間是現在，不是查價時間
    assert alert.created_at == NOW
    notification = await db_session.scalar(select(Notification))
    assert notification is not None
    assert (notification.user_id, notification.alert_id) == (user.id, alert.id)
    assert notification.created_at == NOW
    delivery = await db_session.scalar(select(AlertDelivery))
    assert delivery is not None
    assert (delivery.alert_id, delivery.status) == (alert.id, "pending")
    state = await _state(db_session, watch)
    assert state is not None
    assert (state.below_target, state.last_notified_price, state.last_notified_at) == (
        True,
        9000,
        NOW,
    )


async def test_price_equal_to_target_notifies(db_session: AsyncSession) -> None:
    _, watch = await _setup(db_session, target_price=9000)
    await _snapshot(db_session, watch, price=9000)
    assert await alert_on_recent_price(db_session, watch, NOW) is True


async def test_price_above_target_does_nothing(db_session: AsyncSession) -> None:
    _, watch = await _setup(db_session, target_price=8000)
    await _snapshot(db_session, watch, price=9000)

    assert await alert_on_recent_price(db_session, watch, NOW) is False

    assert await _count(db_session, Alert) == 0
    assert await _state(db_session, watch) is None


async def test_no_snapshot_does_nothing(db_session: AsyncSession) -> None:
    _, watch = await _setup(db_session)
    assert await alert_on_recent_price(db_session, watch, NOW) is False
    assert await _count(db_session, Alert) == 0


async def test_snapshot_exactly_24_hours_old_counts(db_session: AsyncSession) -> None:
    _, watch = await _setup(db_session)
    await _snapshot(db_session, watch, age=timedelta(hours=24))
    assert await alert_on_recent_price(db_session, watch, NOW) is True


async def test_snapshot_older_than_24_hours_waits_for_daily_check(
    db_session: AsyncSession,
) -> None:
    _, watch = await _setup(db_session)
    await _snapshot(db_session, watch, age=timedelta(hours=24, seconds=1))
    assert await alert_on_recent_price(db_session, watch, NOW) is False
    assert await _count(db_session, Alert) == 0


async def test_only_latest_snapshot_counts(db_session: AsyncSession) -> None:
    """早上便宜、晚上漲回去時，不能拿早上的價格通知。"""
    _, watch = await _setup(db_session)
    await _snapshot(db_session, watch, price=9000, age=timedelta(hours=5))
    await _snapshot(db_session, watch, price=9800, age=timedelta(hours=1))
    assert await alert_on_recent_price(db_session, watch, NOW) is False


async def test_same_snapshot_only_notifies_once(db_session: AsyncSession) -> None:
    """反覆改目標價不能狂寄：同一筆價格通知過就等下一次查價。"""
    _, watch = await _setup(db_session)
    await _snapshot(db_session, watch)
    assert await alert_on_recent_price(db_session, watch, NOW) is True
    await reset_state(db_session, watch.id)

    assert await alert_on_recent_price(db_session, watch, NOW) is False

    assert await _count(db_session, Alert) == 1
    assert await _count(db_session, Notification) == 1
    assert await _count(db_session, AlertDelivery) == 1
    # 狀態維持重置後的樣子，下一次查價才會重新通知
    assert await _state(db_session, watch) is None


async def test_already_below_target_does_not_renotify(db_session: AsyncSession) -> None:
    """沒有改目標價（狀態沒重置）時，已經跌破過就不是新的變化。"""
    _, watch = await _setup(db_session)
    await _snapshot(db_session, watch)
    db_session.add(WatchAlertState(watch_id=watch.id, below_target=True, last_notified_price=9000))
    await db_session.flush()

    assert await alert_on_recent_price(db_session, watch, NOW) is False

    assert await _count(db_session, Alert) == 0


async def test_keeps_below_typical_state(db_session: AsyncSession) -> None:
    """這裡不判斷典型低價，不能把排程記下的狀態洗掉，否則下次排程會重複通知。"""
    _, watch = await _setup(db_session)
    await _snapshot(db_session, watch)
    db_session.add(WatchAlertState(watch_id=watch.id, below_typical=True))
    await db_session.flush()

    assert await alert_on_recent_price(db_session, watch, NOW) is True

    state = await _state(db_session, watch)
    assert state is not None
    assert (state.below_target, state.below_typical) == (True, True)


async def test_email_disabled_has_no_delivery(db_session: AsyncSession) -> None:
    user, watch = await _setup(db_session)
    await _snapshot(db_session, watch)
    db_session.add(NotificationSetting(user_id=user.id, email_enabled=False))
    await db_session.flush()

    assert await alert_on_recent_price(db_session, watch, NOW) is True

    assert await _count(db_session, Notification) == 1
    assert await _count(db_session, AlertDelivery) == 0


async def test_paused_watch_does_nothing(db_session: AsyncSession) -> None:
    user = await create_user(db_session)
    watch = await insert_watch(db_session, user, target_price=9500, status="paused")
    await _snapshot(db_session, watch)
    assert await alert_on_recent_price(db_session, watch, NOW) is False
    assert await _count(db_session, Alert) == 0
