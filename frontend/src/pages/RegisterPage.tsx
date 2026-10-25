import { useState, type FormEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router";

import { errorMessage } from "../api/errors";
import { useAuth } from "../auth/context";
import { buttonPrimary, errorBox, input, label } from "../components/ui";
import { safeNext } from "../lib/safeNext";
import { AuthCard } from "./LoginPage";

const MIN_PASSWORD = 8;

export function RegisterPage() {
  const { user, register } = useAuth();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to={safeNext(params.get("next"))} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // 後端的長度錯誤是英文，先在前端用中文擋下
    if (password.length < MIN_PASSWORD) {
      setError(`密碼至少 ${MIN_PASSWORD} 個字元`);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await register(email, password, displayName.trim());
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <AuthCard title="註冊">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && <p className={errorBox}>{error}</p>}
        <div>
          <label htmlFor="email" className={label}>
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            className={input}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="password" className={label}>
            密碼
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="new-password"
            className={input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500">至少 {MIN_PASSWORD} 個字元</p>
        </div>
        <div>
          <label htmlFor="display-name" className={label}>
            名稱（選填）
          </label>
          <input
            id="display-name"
            maxLength={50}
            className={input}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <button type="submit" className={`${buttonPrimary} w-full`} disabled={submitting}>
          註冊
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-600">
        已經有帳號？
        <Link to="/login" className="text-blue-600 hover:underline">
          登入
        </Link>
      </p>
    </AuthCard>
  );
}
