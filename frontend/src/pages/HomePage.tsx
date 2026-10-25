import { useState } from "react";
import { Link, Navigate } from "react-router";

import { ApiError, errorMessage } from "../api/errors";
import { useAuth } from "../auth/context";
import { buttonPrimary, buttonSecondary, card } from "../components/ui";

const FEATURES = [
  {
    title: "每天查價",
    body: "設定航線、日期和目標價，系統每天幫你查一次 Google Flights 的最低價。",
  },
  {
    title: "跌破目標價就通知",
    body: "價格跌破目標價、低於典型價格或創下歷史新低時，寄 Email 並放進站內通知。",
  },
  { title: "價格歷史圖", body: "看價格走勢、目標價線和典型價格區間，判斷現在買划不划算。" },
];

export function HomePage() {
  const { user, loginDemo } = useAuth();
  const [demoError, setDemoError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (user) return <Navigate to="/watches" replace />;

  async function startDemo() {
    setDemoError(null);
    setLoading(true);
    try {
      await loginDemo();
    } catch (err) {
      setDemoError(
        err instanceof ApiError && err.status === 503 ? "示範帳號暫時無法使用" : errorMessage(err),
      );
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1100px] px-4">
      <header className="flex items-center justify-between py-5">
        <span className="text-xl font-bold text-blue-600">FareWatch</span>
        <nav className="flex gap-2">
          <Link to="/login" className={buttonSecondary}>
            登入
          </Link>
          <Link to="/register" className={buttonPrimary}>
            註冊
          </Link>
        </nav>
      </header>

      <section className="py-16 text-center">
        <h1 className="text-4xl font-bold tracking-tight">盯緊機票價格，降價第一時間知道</h1>
        <p className="mx-auto mt-4 max-w-xl text-slate-600">
          FareWatch 每天幫你查台灣出發的機票價格，符合條件時立刻通知你。
        </p>
        <div className="mt-8 flex flex-col items-center gap-2">
          <button
            type="button"
            className={`${buttonPrimary} px-6 py-3 text-base`}
            onClick={startDemo}
            disabled={loading}
          >
            以示範帳號瀏覽
          </button>
          <p className="text-sm text-slate-500">不用註冊，直接看有價格資料的追蹤和通知</p>
          {demoError && <p className="text-sm text-red-600">{demoError}</p>}
        </div>
      </section>

      <section className="grid gap-4 pb-16 md:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.title} className={card}>
            <h2 className="font-semibold">{f.title}</h2>
            <p className="mt-2 text-sm text-slate-600">{f.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
