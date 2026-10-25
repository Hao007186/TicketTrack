import { useState, type FormEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router";

import { errorMessage } from "../api/errors";
import { useAuth } from "../auth/context";
import { buttonPrimary, card, errorBox, input, label } from "../components/ui";
import { safeNext } from "../lib/safeNext";

export function LoginPage() {
  const { user, login } = useAuth();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 登入成功後 user 有值，這裡就會導向原本要去的頁面
  if (user) return <Navigate to={safeNext(params.get("next"))} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  const next = params.get("next");
  return (
    <AuthCard title="登入">
      <form onSubmit={onSubmit} className="space-y-4">
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
            autoComplete="current-password"
            className={input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" className={`${buttonPrimary} w-full`} disabled={submitting}>
          登入
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-600">
        還沒有帳號？
        <Link
          to={next ? `/register?next=${encodeURIComponent(next)}` : "/register"}
          className="text-blue-600 hover:underline"
        >
          註冊
        </Link>
      </p>
    </AuthCard>
  );
}

export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-16 w-full max-w-sm px-4">
      <Link to="/" className="mb-6 block text-center text-2xl font-bold text-blue-600">
        FareWatch
      </Link>
      <div className={card}>
        <h1 className="mb-4 text-lg font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  );
}
