import { Link } from "react-router";

import { useUnreadCount } from "../api/queries";

export function NotificationBell() {
  const { data: unread = 0 } = useUnreadCount();
  const label = unread > 0 ? `通知（${unread} 則未讀）` : "通知";
  return (
    <Link
      to="/notifications"
      aria-label={label}
      title={label}
      className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100"
    >
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
      {unread > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-5 rounded-full bg-red-500 px-1 text-center text-xs leading-5 text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
