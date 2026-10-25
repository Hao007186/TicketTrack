import { Navigate, Outlet, Route, Routes, useLocation } from "react-router";

import { useAuth } from "./auth/context";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { RegisterPage } from "./pages/RegisterPage";

function RequireAuth() {
  const { user } = useAuth();
  const { pathname, search } = useLocation();
  if (!user)
    return <Navigate to={`/login?next=${encodeURIComponent(pathname + search)}`} replace />;
  return <Outlet />;
}

// 暫時的頁面，之後的 task 會換成真的
function Placeholder({ title }: { title: string }) {
  const { logout } = useAuth();
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">{title}</h1>
      <button type="button" onClick={logout}>
        登出
      </button>
    </div>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/watches" element={<Placeholder title="我的追蹤" />} />
        <Route path="/watches/new" element={<Placeholder title="新增追蹤" />} />
        <Route path="/watches/:id" element={<Placeholder title="追蹤詳情" />} />
        <Route path="/watches/:id/edit" element={<Placeholder title="編輯追蹤" />} />
        <Route path="/notifications" element={<Placeholder title="通知" />} />
        <Route path="/settings" element={<Placeholder title="設定" />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
