import { Link, useNavigate, useSearchParams } from "react-router";

import { useAirports, useBaseline, useWatches, type Watch } from "../api/queries";
import { QueryError } from "../components/QueryError";
import { StatusBadge } from "../components/StatusBadge";
import { buttonPrimary, card } from "../components/ui";
import { WriteButton } from "../components/WriteButton";
import { routeLabel } from "../lib/airports";
import { formatPrice } from "../lib/format";

// 和後端的名額計算相同：暫停的不佔名額
export const MAX_WATCHES = 3;
const SLOT_STATUSES = new Set<Watch["status"]>(["active", "queued"]);

function shortDate(isoDate: string): string {
  const [, m, d] = isoDate.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function WatchCard({ watch }: { watch: Watch }) {
  const { data: airports } = useAirports();
  const { data: baseline } = useBaseline(watch.public_id);
  const latest = baseline?.latest_price ?? null;
  const dates = watch.return_date
    ? `${shortDate(watch.depart_date)} – ${shortDate(watch.return_date)}`
    : shortDate(watch.depart_date);

  return (
    <article className={`${card} transition hover:border-blue-300`}>
      <Link to={`/watches/${watch.public_id}`} className="block">
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-semibold">{routeLabel(watch, airports)}</h2>
          <StatusBadge status={watch.status} />
        </div>
        <p className="mt-1 text-sm text-slate-500">
          {dates}・{watch.trip_type === "round_trip" ? "來回" : "單程"}
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-slate-500">目標價</dt>
            <dd className="font-medium">{formatPrice(watch.target_price)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">目前最低價</dt>
            <dd className="font-medium">{latest === null ? "尚無價格" : formatPrice(latest)}</dd>
          </div>
        </dl>
        {latest !== null && latest <= watch.target_price && (
          <p className="mt-3 text-sm font-medium text-green-700">已低於目標價</p>
        )}
      </Link>
    </article>
  );
}

export function WatchListPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const history = params.get("tab") === "history";
  const { data: watches, error, refetch, isPending } = useWatches();

  const used = watches?.filter((w) => SLOT_STATUSES.has(w.status)).length ?? 0;
  const full = used >= MAX_WATCHES;
  const shown = watches?.filter((w) => (w.status === "expired") === history) ?? [];

  const tabClass = (active: boolean) =>
    `border-b-2 px-4 py-2 text-sm font-medium ${
      active ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500"
    }`;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">我的追蹤</h1>
          <p className="mt-1 text-sm text-slate-500">
            已用 {used}／{MAX_WATCHES} 個名額
          </p>
        </div>
        <div className="flex items-center gap-3">
          {full && <span className="text-sm text-slate-500">名額已滿</span>}
          <WriteButton
            className={buttonPrimary}
            disabled={full || isPending}
            onClick={() => navigate("/watches/new")}
          >
            新增追蹤
          </WriteButton>
        </div>
      </div>

      <div role="tablist" className="mt-6 flex border-b border-slate-200">
        <button
          type="button"
          role="tab"
          aria-selected={!history}
          className={tabClass(!history)}
          onClick={() => setParams({})}
        >
          進行中
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={history}
          className={tabClass(history)}
          onClick={() => setParams({ tab: "history" })}
        >
          歷史紀錄
        </button>
      </div>

      <div className="mt-6">
        {error ? (
          <QueryError error={error} onRetry={() => void refetch()} />
        ) : isPending ? (
          <p className="text-slate-500">載入中…</p>
        ) : shown.length === 0 ? (
          <p className="py-12 text-center text-slate-500">
            {history ? "還沒有已過期的追蹤" : "還沒有追蹤，新增一個開始盯價格"}
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {shown.map((w) => (
              <WatchCard key={w.public_id} watch={w} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
