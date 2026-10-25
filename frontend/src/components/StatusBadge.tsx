import { STATUS_LABELS, type WatchStatus } from "../lib/format";

const COLORS: Record<WatchStatus, string> = {
  active: "bg-green-100 text-green-800",
  queued: "bg-amber-100 text-amber-800",
  paused: "bg-slate-200 text-slate-700",
  expired: "bg-slate-100 text-slate-500",
};

export function StatusBadge({ status }: { status: WatchStatus }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${COLORS[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}
