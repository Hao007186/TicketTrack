import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { api, unwrap } from "../api/client";
import { ApiError, errorMessage } from "../api/errors";
import { useAuth } from "../auth/context";
import { buttonPrimary, errorBox, input, label } from "../components/ui";
import { validateNewPassword } from "../lib/password";
import { AuthCard } from "./LoginPage";

const reapplyLink = (
  <Link to="/forgot-password" className="font-medium underline">
    重新申請
  </Link>
);

export function ResetPasswordPage() {
  const { clearSession } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!token) {
    return (
      <AuthCard title="重設密碼">
        <p className={errorBox}>
          <strong>連結不完整</strong>，請 {reapplyLink} 重設信。
        </p>
      </AuthCard>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = validateNewPassword(password, confirm);
    if (problem) {
      setError(problem);
      setInvalid(false);
      return;
    }
    setError(null);
    setInvalid(false);
    setSubmitting(true);
    try {
      unwrap(
        await api.POST("/api/v1/auth/password-reset/confirm", {
          body: { token: token as string, new_password: password },
        }),
      );
      // 重設後後端已撤銷所有登入，這台裝置也要一併清掉
      clearSession();
      navigate("/login?reset=1", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      // 只有後端說 token 無效（400）才建議重新申請；5xx／網路錯誤時 token 仍有效，重新申請反而會被冷卻擋掉
      setInvalid(err instanceof ApiError && err.status === 400);
      setSubmitting(false);
    }
  }

  return (
    <AuthCard title="重設密碼">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && (
          <p className={errorBox}>
            {error}
            {invalid && <> {reapplyLink}</>}
          </p>
        )}
        <div>
          <label htmlFor="new-password" className={label}>
            新密碼
          </label>
          <input
            id="new-password"
            type="password"
            required
            autoComplete="new-password"
            className={input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="confirm-password" className={label}>
            再輸入一次新密碼
          </label>
          <input
            id="confirm-password"
            type="password"
            required
            autoComplete="new-password"
            className={input}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <button type="submit" className={`${buttonPrimary} w-full`} disabled={submitting}>
          重設密碼
        </button>
      </form>
    </AuthCard>
  );
}
