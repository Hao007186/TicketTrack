import { useState, type ReactNode } from "react";

import {
  useAdminDeleteWatch,
  useAdminUsage,
  useAdminUsers,
  useAdminWatches,
  useDeactivateUser,
  useReactivateUser,
  type AdminUsage,
  type AdminUser,
  type AdminWatch,
} from "../api/queries";
import { useAuth } from "../auth/context";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { QueryError } from "../components/QueryError";
import { StatusBadge } from "../components/StatusBadge";
import { buttonDanger, buttonSecondary, card } from "../components/ui";
import { useToast } from "../components/useToast";
import { formatDate, formatMonthDay, type WatchStatus } from "../lib/format";
import { NotFoundPage } from "./NotFoundPage";

const th = "px-3 py-2 text-left text-xs font-medium text-slate-500";
const td = "px-3 py-2 text-sm";

export function AdminPage() {
  const { user } = useAuth();
  // 非 admin 直接當作沒有這個頁面，也不發任何後台請求
  if (user?.role !== "admin") return <NotFoundPage />;
  return <AdminContent selfId={user.public_id} />;
}

type Pending =
  { kind: "deactivate"; user: AdminUser } | { kind: "delete"; watch: AdminWatch } | null;

function AdminContent({ selfId }: { selfId: string }) {
  const toast = useToast();
  const deactivate = useDeactivateUser();
  const reactivate = useReactivateUser();
  const removeWatch = useAdminDeleteWatch();
  const [pending, setPending] = useState<Pending>(null);

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      toast.show(success);
    } catch {
      // 錯誤訊息由 AppProviders 的 MutationCache 統一顯示
    }
  }

  function confirm() {
    const target = pending;
    setPending(null);
    if (target?.kind === "deactivate")
      void run(() => deactivate.mutateAsync(target.user.public_id), "已停用帳號");
    if (target?.kind === "delete")
      void run(() => removeWatch.mutateAsync(target.watch.public_id), "已刪除追蹤");
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-bold">後台</h1>
      <UsageSection />
      <UsersSection
        selfId={selfId}
        onDeactivate={(u) => setPending({ kind: "deactivate", user: u })}
        onReactivate={(u) => void run(() => reactivate.mutateAsync(u.public_id), "已恢復帳號")}
      />
      <WatchesSection onDelete={(w) => setPending({ kind: "delete", watch: w })} />
      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === "deactivate" ? "停用帳號" : "刪除追蹤"}
        message={confirmMessage(pending)}
        confirmLabel={pending?.kind === "deactivate" ? "停用" : "刪除"}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function confirmMessage(pending: Pending): string {
  if (pending?.kind === "deactivate")
    return `停用 ${pending.user.email} 後，他的 ${pending.user.watch_count} 個追蹤會被刪除，恢復帳號後也不會回來。`;
  if (pending?.kind === "delete") {
    const w = pending.watch;
    return `確定要刪除 ${w.owner_email} 的 ${w.origin}→${w.destination}（${formatDate(w.depart_date)}）嗎？`;
  }
  return "";
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={card}>
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function usageRows(u: AdminUsage): [string, string][] {
  return [
    ["SerpApi 本月剩餘", u.serpapi_remaining === null ? "查詢失敗" : `${u.serpapi_remaining} 次`],
    ["今天預算", u.daily_budget === null ? "—" : `${u.daily_budget} 次（依目前剩餘額度計算）`],
    ["今天已查價", `${u.checked_today} 組條件，其中立即查價 ${u.instant_today} 次`],
    ["立即查價剩餘", u.instant_remaining === null ? "—" : `${u.instant_remaining} 次`],
    ["本月已呼叫", `${u.month_calls} 次`],
    ["查價名額", `${u.slots_used} / ${u.slots_max} 組，排隊中 ${u.queued} 個`],
    ["本月寄信", `成功 ${u.email_sent}｜失敗 ${u.email_failed}｜待寄 ${u.email_pending}`],
  ];
}

function UsageSection() {
  const usage = useAdminUsage();
  return (
    <Section title="用量">
      {usage.error ? (
        <QueryError error={usage.error} onRetry={() => void usage.refetch()} />
      ) : !usage.data ? (
        <p className="text-slate-500">載入中…</p>
      ) : (
        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
          {usageRows(usage.data).map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-slate-500">{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

function accountLabel(u: AdminUser): string {
  if (u.is_demo) return "示範帳號";
  if (u.role === "admin") return "管理員";
  return u.is_active ? "正常" : "已停用";
}

function UsersSection({
  selfId,
  onDeactivate,
  onReactivate,
}: {
  selfId: string;
  onDeactivate: (u: AdminUser) => void;
  onReactivate: (u: AdminUser) => void;
}) {
  const users = useAdminUsers();
  return (
    <Section title="帳號">
      {users.error ? (
        <QueryError error={users.error} onRetry={() => void users.refetch()} />
      ) : !users.data ? (
        <p className="text-slate-500">載入中…</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label="帳號" className="w-full">
            <thead>
              <tr className="border-b border-slate-200">
                <th className={th}>Email</th>
                <th className={th}>註冊日</th>
                <th className={th}>佔名額</th>
                <th className={th}>狀態</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.data.map((u) => {
                const protectedAccount = u.public_id === selfId || u.is_demo || u.role === "admin";
                return (
                  <tr key={u.public_id}>
                    <td className={td}>{u.email}</td>
                    <td className={td}>{formatMonthDay(u.created_at)}</td>
                    <td className={td}>{u.slot_count}</td>
                    <td className={td}>{accountLabel(u)}</td>
                    <td className={`${td} text-right`}>
                      {protectedAccount ? null : u.is_active ? (
                        <button
                          type="button"
                          className={buttonDanger}
                          onClick={() => onDeactivate(u)}
                        >
                          停用
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={buttonSecondary}
                          onClick={() => onReactivate(u)}
                        >
                          恢復
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function WatchesSection({ onDelete }: { onDelete: (w: AdminWatch) => void }) {
  const watches = useAdminWatches();
  return (
    <Section title="追蹤（佔名額或排隊中）">
      {watches.error ? (
        <QueryError error={watches.error} onRetry={() => void watches.refetch()} />
      ) : !watches.data ? (
        <p className="text-slate-500">載入中…</p>
      ) : watches.data.length === 0 ? (
        <p className="py-4 text-center text-slate-500">目前沒有佔名額的追蹤</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label="追蹤" className="w-full">
            <thead>
              <tr className="border-b border-slate-200">
                <th className={th}>帳號</th>
                <th className={th}>航線</th>
                <th className={th}>出發日</th>
                <th className={th}>狀態</th>
                <th className={th}>建立時間</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {watches.data.map((w) => (
                <tr key={w.public_id}>
                  <td className={td}>{w.owner_email}</td>
                  <td className={td}>
                    {w.origin}→{w.destination}
                  </td>
                  <td className={td}>{formatDate(w.depart_date)}</td>
                  <td className={td}>
                    <StatusBadge status={w.status as WatchStatus} />
                  </td>
                  <td className={td}>{formatMonthDay(w.created_at)}</td>
                  <td className={`${td} text-right`}>
                    <button type="button" className={buttonDanger} onClick={() => onDelete(w)}>
                      刪除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
