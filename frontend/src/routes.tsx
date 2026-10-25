import { Navigate, Outlet, Route, Routes, useLocation } from "react-router";

import { useAuth } from "./auth/context";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { RegisterPage } from "./pages/RegisterPage";
import { WatchFormPage } from "./pages/WatchFormPage";
import { WatchListPage } from "./pages/WatchListPage";

function RequireAuth() {
  const { user } = useAuth();
  const { pathname, search } = useLocation();
  if (!user)
    return <Navigate to={`/login?next=${encodeURIComponent(pathname + search)}`} replace />;
  return <Outlet />;
}

// 暫時的頁面，之後的 task 會換成真的
function Placeholder({ title }: { title: string }) {
  return <h1 className="text-xl font-semibold">{title}</h1>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/watches" element={<WatchListPage />} />
          <Route path="/watches/new" element={<WatchFormPage mode="create" />} />
          <Route path="/watches/:id" element={<Placeholder title="追蹤詳情" />} />
          <Route path="/watches/:id/edit" element={<WatchFormPage mode="edit" />} />
          <Route path="/notifications" element={<Placeholder title="通知" />} />
          <Route path="/settings" element={<Placeholder title="設定" />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
