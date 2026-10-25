import { Navigate, Outlet, Route, Routes, useLocation } from "react-router";

import { useAuth } from "./auth/context";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { RegisterPage } from "./pages/RegisterPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WatchDetailPage } from "./pages/WatchDetailPage";
import { WatchFormPage } from "./pages/WatchFormPage";
import { WatchListPage } from "./pages/WatchListPage";

function RequireAuth() {
  const { user } = useAuth();
  const { pathname, search } = useLocation();
  if (!user)
    return <Navigate to={`/login?next=${encodeURIComponent(pathname + search)}`} replace />;
  return <Outlet />;
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
          <Route path="/watches/:id" element={<WatchDetailPage />} />
          <Route path="/watches/:id/edit" element={<WatchFormPage mode="edit" />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
