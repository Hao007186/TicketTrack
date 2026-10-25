import { useState } from "react";
import { useNavigate, useParams } from "react-router";

import { ApiError } from "../api/errors";
import {
  useAirports,
  useBaseline,
  useDeleteWatch,
  usePrices,
  useSetPaused,
  useWatch,
  useWatchNotifications,
  type PriceRange,
  type Watch,
} from "../api/queries";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { NotificationItem } from "../components/NotificationItem";
import { PageMessage, WATCH_MISSING } from "../components/PageMessage";
import { PriceChart } from "../components/PriceChart";
import { QueryError } from "../components/QueryError";
import { StatusBadge } from "../components/StatusBadge";
import { buttonDanger, buttonPrimary, buttonSecondary, card } from "../components/ui";
import { WriteButton } from "../components/WriteButton";
import { routeLabel } from "../lib/airports";
import { CABIN_LABELS, formatDate, formatDateTime, formatPrice, type Cabin } from "../lib/format";

const RANGES: { value: PriceRange; text: string }[] = [
  { value: "30d", text: "30 天" },
  { value: "90d", text: "90 天" },
  { value: "all", text: "全部" },
];

const STATUS_HINTS: Partial<Record<Watch["status"], string>> = {
  queued: "全站名額已滿，排隊中，暫不查價",
  paused: "已暫停，不會查價",
};

function StatCard({ title, value, note }: { title: string; value: string; note?: string }) {
  return (
    <div className={card}>
      <p className="text-sm text-slate-500">{title}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {note && <p className="mt-1 text-xs text-slate-500">{note}</p>}
    </div>
  );
}

function Header({ watch }: { watch: Watch }) {
  const navigate = useNavigate();
  const { data: airports } = useAirports();
  const setPaused = useSetPaused(watch.public_id);
  const remove = useDeleteWatch(watch.public_id);
  const [confirming, setConfirming] = useState(false);
  const expired = watch.status === "expired";
  const dates = watch.return_date
    ? `${formatDate(watch.depart_date)} – ${formatDate(watch.return_date)}`
    : formatDate(watch.depart_date);

  async function onDelete() {
    setConfirming(false);
    await remove.mutateAsync();
    navigate("/watches", { replace: true });
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{routeLabel(watch, airports)}</h1>
          <StatusBadge status={watch.status} />
        </div>
        <p className="mt-1 text-sm text-slate-500">
          {dates}・{watch.trip_type === "round_trip" ? "來回" : "單程"}・
          {CABIN_LABELS[watch.cabin as Cabin] ?? watch.cabin}・{watch.adults} 人
        </p>
      </div>
      <div className="flex gap-2">
        {!expired && (
          <>
            <WriteButton
              className={buttonSecondary}
              onClick={() => navigate(`/watches/${watch.public_id}/edit`)}
            >
              編輯
            </WriteButton>
            <WriteButton
              className={buttonSecondary}
              disabled={setPaused.isPending}
              onClick={() => setPaused.mutate(watch.status !== "paused")}
            >
              {watch.status === "paused" ? "恢復" : "暫停"}
            </WriteButton>
          </>
        )}
        <WriteButton
          className={buttonDanger}
          disabled={remove.isPending}
          onClick={() => setConfirming(true)}
        >
          刪除
        </WriteButton>
      </div>
      <ConfirmDialog
        open={confirming}
        title="刪除追蹤"
        message="刪除後就不會再查價，價格紀錄也會一起刪除；已收到的通知會保留。"
        confirmLabel="刪除"
        onConfirm={() => void onDelete().catch(() => undefined)}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

function Detail({ watch }: { watch: Watch }) {
  const id = watch.public_id;
  // 已過期的追蹤價格停在過去，預設看全部才看得到
  const [range, setRange] = useState<PriceRange>(watch.status === "expired" ? "all" : "90d");
  const { data: baseline } = useBaseline(id);
  const prices = usePrices(id, range);
  const { data: notifications } = useWatchNotifications(id);
  const hint = STATUS_HINTS[watch.status];

  const typical =
    baseline?.typical_low != null && baseline.typical_high != null
      ? `${formatPrice(baseline.typical_low)} – ${formatPrice(baseline.typical_high)}`
      : "—";
  // baseline 還沒載入前先顯示「—」，不要誤顯示成「累積中」
  const recordLow = !baseline
    ? "—"
    : !baseline.history_ready
      ? "歷史資料累積中"
      : baseline.record_low != null
        ? formatPrice(baseline.record_low)
        : "—";

  return (
    <div className="space-y-6">
      <Header watch={watch} />
      {hint && <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">{hint}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="目前最低價"
          value={baseline?.latest_price != null ? formatPrice(baseline.latest_price) : "尚無價格"}
          note={
            baseline?.latest_observed_at
              ? `${formatDateTime(baseline.latest_observed_at)} 查價`
              : undefined
          }
        />
        <StatCard title="目標價" value={formatPrice(watch.target_price)} />
        <StatCard title="典型價格區間" value={typical} />
        <StatCard title="歷史最低價" value={recordLow} />
      </div>

      <section className={card}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">價格走勢</h2>
          <div className="flex gap-1" role="group" aria-label="期間">
            {RANGES.map((r) => (
              <button
                key={r.value}
                type="button"
                aria-pressed={range === r.value}
                className={`rounded-md px-3 py-1 text-sm ${
                  range === r.value ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
                onClick={() => setRange(r.value)}
              >
                {r.text}
              </button>
            ))}
          </div>
        </div>
        {prices.error ? (
          <QueryError error={prices.error} onRetry={() => void prices.refetch()} />
        ) : (
          <PriceChart
            points={prices.data ?? []}
            targetPrice={watch.target_price}
            typicalLow={baseline?.typical_low ?? null}
            typicalHigh={baseline?.typical_high ?? null}
          />
        )}
        {baseline?.latest_booking_url && (
          <a
            href={baseline.latest_booking_url}
            target="_blank"
            rel="noopener noreferrer"
            className={`${buttonPrimary} mt-4`}
          >
            去 Google Flights 訂票
          </a>
        )}
      </section>

      <section className={card}>
        <h2 className="font-semibold">最近通知</h2>
        {notifications && notifications.length > 0 ? (
          <ul className="divide-y divide-slate-100">
            {notifications.map((n) => (
              <NotificationItem key={n.id} notification={n} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-500">還沒有通知</p>
        )}
      </section>
    </div>
  );
}

export function WatchDetailPage() {
  const { id = "" } = useParams();
  const { data: watch, error, refetch } = useWatch(id);
  if (error instanceof ApiError && error.status === 404)
    return <PageMessage message={WATCH_MISSING} />;
  if (error) return <QueryError error={error} onRetry={() => void refetch()} />;
  if (!watch) return <p className="text-slate-500">載入中…</p>;
  // key：切換到另一個追蹤時重設期間的預設值
  return <Detail key={watch.public_id} watch={watch} />;
}
