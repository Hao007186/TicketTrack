import { useNotificationSettings, useUpdateNotificationSettings } from "../api/queries";
import { useAuth } from "../auth/context";
import { QueryError } from "../components/QueryError";
import { card } from "../components/ui";
import { WriteButton } from "../components/WriteButton";

function EmailToggle() {
  const { data, error, refetch } = useNotificationSettings();
  const update = useUpdateNotificationSettings();
  if (error) return <QueryError error={error} onRetry={() => void refetch()} />;
  const enabled = data?.email_enabled ?? false;
  return (
    <div className="flex items-start justify-between gap-6">
      <div>
        <p id="email-toggle-label" className="font-medium">
          Email 通知
        </p>
        <p className="mt-1 text-sm text-slate-500">價格符合條件時寄 Email 給你；站內通知一律保留</p>
      </div>
      <WriteButton
        role="switch"
        aria-checked={enabled}
        aria-labelledby="email-toggle-label"
        disabled={!data || update.isPending}
        onClick={() => update.mutate(!enabled)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 ${
          enabled ? "bg-blue-600" : "bg-slate-300"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow transition ${
            enabled ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </WriteButton>
    </div>
  );
}

export function SettingsPage() {
  const { user } = useAuth();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">設定</h1>
      <section className={card}>
        <h2 className="mb-4 font-semibold">個人資料</h2>
        <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
          <dt className="text-slate-500">Email</dt>
          <dd>{user?.email}</dd>
          <dt className="text-slate-500">名稱</dt>
          <dd>{user?.display_name || "未設定"}</dd>
        </dl>
      </section>
      <section className={card}>
        <h2 className="mb-4 font-semibold">通知</h2>
        <EmailToggle />
      </section>
    </div>
  );
}
