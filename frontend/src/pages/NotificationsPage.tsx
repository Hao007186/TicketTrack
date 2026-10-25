import { useMarkAllRead, useNotificationPages, useUnreadCount } from "../api/queries";
import { NotificationItem } from "../components/NotificationItem";
import { QueryError } from "../components/QueryError";
import { buttonSecondary, card } from "../components/ui";
import { WriteButton } from "../components/WriteButton";

export function NotificationsPage() {
  const pages = useNotificationPages();
  const { data: unread = 0 } = useUnreadCount();
  const markAll = useMarkAllRead();
  const items = pages.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">通知</h1>
        <WriteButton
          className={buttonSecondary}
          disabled={unread === 0 || markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          全部標為已讀
        </WriteButton>
      </div>

      <div className={`${card} mt-6`}>
        {pages.error ? (
          <QueryError error={pages.error} onRetry={() => void pages.refetch()} />
        ) : pages.isPending ? (
          <p className="text-slate-500">載入中…</p>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-slate-500">目前沒有通知</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((n) => (
              <NotificationItem key={n.id} notification={n} showMarkRead />
            ))}
          </ul>
        )}
        {pages.hasNextPage && (
          <div className="mt-4 text-center">
            <button
              type="button"
              className={buttonSecondary}
              disabled={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
            >
              載入更多
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
