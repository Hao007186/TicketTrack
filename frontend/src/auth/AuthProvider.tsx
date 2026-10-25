import { useQueryClient } from "@tanstack/react-query";
import { startTransition, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { api, unwrap } from "../api/client";
import { useToast } from "../components/useToast";
import { AuthContext, type Auth, type Me } from "./context";
import { onAuthLost, refreshAccessToken, setAccessToken } from "./token";

async function fetchMe(): Promise<Me> {
  return unwrap(await api.GET("/api/v1/me"));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  // ready 之前還不知道有沒有登入，先不渲染頁面，避免已登入的人先閃一下登入頁
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<Me | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let me: Me | null = null;
      try {
        if ((await refreshAccessToken()) !== null) me = await fetchMe();
      } catch {
        // 後端暫時連不上時當成沒登入，使用者可以自己再登入一次
      }
      if (!cancelled) {
        setUser(me);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      onAuthLost(() => {
        setUser(null);
        queryClient.clear();
        toast.show("登入已過期，請重新登入");
      }),
    [queryClient, toast],
  );

  const signIn = useCallback(async (accessToken: string) => {
    setAccessToken(accessToken);
    setUser(await fetchMe());
  }, []);

  const auth = useMemo<Auth>(
    () => ({
      user,
      isDemo: user?.is_demo ?? false,
      async login(email, password) {
        const res = await api.POST("/api/v1/auth/login", { body: { email, password } });
        await signIn(unwrap(res).access_token);
      },
      async register(email, password, displayName) {
        const res = await api.POST("/api/v1/auth/register", {
          body: { email, password, display_name: displayName || null },
        });
        await signIn(unwrap(res).access_token);
      },
      async loginDemo() {
        await signIn(unwrap(await api.POST("/api/v1/auth/demo")).access_token);
      },
      async logout() {
        try {
          await api.POST("/api/v1/auth/logout");
        } catch {
          // 登出請求失敗也要清掉本機的登入狀態
        }
        setAccessToken(null);
        queryClient.clear();
        // React Router 的導頁走 transition；setUser 也放進同一個 transition 一起生效，
        // 否則 RequireAuth 會先看到沒登入，把人導去登入頁
        startTransition(() => {
          navigate("/", { replace: true });
          setUser(null);
        });
      },
    }),
    [user, signIn, queryClient, navigate],
  );

  if (!ready) {
    return <div className="grid min-h-screen place-items-center text-slate-500">載入中…</div>;
  }
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}
