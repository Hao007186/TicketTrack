import { useState, type FormEvent } from "react";
import { Link } from "react-router";

import { api, unwrap } from "../api/client";
import { errorMessage } from "../api/errors";
import { buttonPrimary, errorBox, input, label, successBox } from "../components/ui";
import { AuthCard } from "./LoginPage";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.POST("/api/v1/auth/password-reset/request", { body: { email } });
      setSentMessage(unwrap(res).detail);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard title="忘記密碼">
      {sentMessage !== null ? (
        <div className="space-y-4">
          <p className={successBox}>{sentMessage}</p>
          <Link to="/login" className="block text-center text-sm text-blue-600 hover:underline">
            回到登入
          </Link>
        </div>
      ) : (
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
          <button type="submit" className={`${buttonPrimary} w-full`} disabled={submitting}>
            寄送重設信
          </button>
          <p className="text-center text-sm">
            <Link to="/login" className="text-blue-600 hover:underline">
              回到登入
            </Link>
          </p>
        </form>
      )}
    </AuthCard>
  );
}
