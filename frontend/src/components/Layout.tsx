import { Outlet } from "react-router";

import { useAuth } from "../auth/context";
import { NavBar } from "./NavBar";

function DemoBanner() {
  return (
    <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">
      你正在使用示範帳號，資料為唯讀
    </div>
  );
}

export function Layout() {
  const { isDemo } = useAuth();
  return (
    <div className="min-h-screen">
      {isDemo && <DemoBanner />}
      <NavBar />
      <main className="mx-auto max-w-[1100px] px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
