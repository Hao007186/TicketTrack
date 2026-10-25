import { useState } from "react";
import { Link, NavLink } from "react-router";

import { useAuth } from "../auth/context";
import { NotificationBell } from "./NotificationBell";

function navClass({ isActive }: { isActive: boolean }) {
  return `rounded-lg px-3 py-2 text-sm font-medium ${
    isActive ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-100"
  }`;
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const name = user?.display_name || user?.email || "";
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
        onClick={() => setOpen((v) => !v)}
      >
        {name}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-40 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
        >
          <Link
            role="menuitem"
            to="/settings"
            className="block px-4 py-2 text-sm hover:bg-slate-50"
            onClick={() => setOpen(false)}
          >
            設定
          </Link>
          <button
            role="menuitem"
            type="button"
            className="block w-full px-4 py-2 text-left text-sm hover:bg-slate-50"
            onClick={() => {
              setOpen(false);
              void logout();
            }}
          >
            登出
          </button>
        </div>
      )}
    </div>
  );
}

export function NavBar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-[1100px] items-center gap-4 px-4 py-3">
        <Link to="/watches" className="text-lg font-bold text-blue-600">
          FareWatch
        </Link>
        <nav className="hidden md:flex">
          <NavLink to="/watches" end className={navClass}>
            我的追蹤
          </NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <NotificationBell />
          <div className="hidden md:block">
            <UserMenu />
          </div>
          <button
            type="button"
            className="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 md:hidden"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((v) => !v)}
          >
            選單
          </button>
        </div>
      </div>
      {mobileOpen && <MobileMenu onClose={() => setMobileOpen(false)} />}
    </header>
  );
}

function MobileMenu({ onClose }: { onClose: () => void }) {
  const { logout } = useAuth();
  return (
    <nav className="flex flex-col border-t border-slate-200 px-4 py-2 md:hidden">
      <NavLink to="/watches" end className={navClass} onClick={onClose}>
        我的追蹤
      </NavLink>
      <NavLink to="/settings" className={navClass} onClick={onClose}>
        設定
      </NavLink>
      <button
        type="button"
        className="rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-600 hover:bg-slate-100"
        onClick={() => {
          onClose();
          void logout();
        }}
      >
        登出
      </button>
    </nav>
  );
}
