import { Link } from "react-router";

import { useMarkRead, type Notification } from "../api/queries";
import { formatDateTime } from "../lib/format";
import { WriteButton } from "./WriteButton";

export function NotificationItem({
  notification: n,
  showMarkRead = false,
}: {
  notification: Notification;
  showMarkRead?: boolean;
}) {
  const markRead = useMarkRead();
  return (
    <li className="flex gap-3 py-4">
      <span
        aria-hidden
        className={`mt-2 h-2 w-2 shrink-0 rounded-full ${n.is_read ? "bg-transparent" : "bg-blue-600"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {n.link ? (
            <Link to={n.link} className="font-medium hover:text-blue-700">
              {n.title}
            </Link>
          ) : (
            <span className="font-medium">{n.title}</span>
          )}
          <time className="text-xs text-slate-500" dateTime={n.created_at}>
            {formatDateTime(n.created_at)}
          </time>
        </div>
        <p className="mt-1 text-sm whitespace-pre-line text-slate-600">{n.body}</p>
        <div className="mt-2 flex gap-4 text-sm">
          {n.booking_url && (
            <a
              href={n.booking_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              去訂票
            </a>
          )}
          {showMarkRead && !n.is_read && (
            <WriteButton
              className="text-slate-500 hover:text-slate-800 disabled:cursor-not-allowed disabled:text-slate-300"
              disabled={markRead.isPending}
              onClick={() => markRead.mutate(n.id)}
            >
              標為已讀
            </WriteButton>
          )}
        </div>
      </div>
    </li>
  );
}
