import { useState, type FormEvent } from "react";

import {
  useChangePassword,
  useNotificationSettings,
  useUpdateNotificationSettings,
} from "../api/queries";
import { errorMessage } from "../api/errors";
import { useAuth } from "../auth/context";
import { QueryError } from "../components/QueryError";
import { buttonPrimary, card, errorBox, input, label, successBox } from "../components/ui";
import { WriteButton } from "../components/WriteButton";
import { validateNewPassword } from "../lib/password";

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

function ChangePasswordForm() {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setDone(false);
    const problem = validateNewPassword(next, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    change.mutate(
      { current_password: current, new_password: next },
      {
        onSuccess: () => {
          setCurrent("");
          setNext("");
          setConfirm("");
          setDone(true);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} className="max-w-sm space-y-4" noValidate>
      {error && <p className={errorBox}>{error}</p>}
      {done && <p className={successBox}>密碼已更新，其他裝置已登出</p>}
      <div>
        <label htmlFor="current-password" className={label}>
          目前密碼
        </label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          className={input}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="new-password" className={label}>
          新密碼
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          className={input}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="confirm-new-password" className={label}>
          確認新密碼
        </label>
        <input
          id="confirm-new-password"
          type="password"
          autoComplete="new-password"
          className={input}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      <WriteButton type="submit" className={buttonPrimary} disabled={change.isPending}>
        更新密碼
      </WriteButton>
    </form>
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
      <section className={card}>
        <h2 className="mb-4 font-semibold">修改密碼</h2>
        <ChangePasswordForm />
      </section>
    </div>
  );
}
