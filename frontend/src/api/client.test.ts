import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { onAuthLost, setAccessToken } from "../auth/token";
import { server } from "../test/server";
import { api, unwrap } from "./client";
import { ApiError } from "./errors";

const ME = "/api/v1/me";
const REFRESH = "/api/v1/auth/refresh";
const me = {
  public_id: "00000000-0000-0000-0000-000000000001",
  email: "a@x.test",
  display_name: null,
  role: "user",
  is_demo: false,
};

function refreshCounter(token: string | null) {
  const calls = { count: 0 };
  server.use(
    http.post(REFRESH, () => {
      calls.count++;
      return token === null
        ? HttpResponse.json({ detail: "請重新登入" }, { status: 401 })
        : HttpResponse.json({ access_token: token, token_type: "bearer" });
    }),
  );
  return calls;
}

// 只接受指定 token，其他一律 401
function meAccepts(token: string) {
  const calls = { count: 0 };
  server.use(
    http.get(ME, ({ request }) => {
      calls.count++;
      return request.headers.get("Authorization") === `Bearer ${token}`
        ? HttpResponse.json(me)
        : HttpResponse.json({ detail: "請重新登入" }, { status: 401 });
    }),
  );
  return calls;
}

beforeEach(() => {
  setAccessToken(null);
});

describe("authFetch", () => {
  it("帶上 token", async () => {
    setAccessToken("abc");
    meAccepts("abc");
    expect(unwrap(await api.GET("/api/v1/me"))).toEqual(me);
  });

  it("401 後 refresh 並重送", async () => {
    setAccessToken("expired");
    meAccepts("new");
    const refresh = refreshCounter("new");
    expect(unwrap(await api.GET("/api/v1/me"))).toEqual(me);
    expect(refresh.count).toBe(1);
  });

  it("兩個請求同時 401 只 refresh 一次", async () => {
    setAccessToken("expired");
    meAccepts("new");
    const refresh = refreshCounter("new");
    const [a, b] = await Promise.all([api.GET("/api/v1/me"), api.GET("/api/v1/me")]);
    expect(unwrap(a)).toEqual(me);
    expect(unwrap(b)).toEqual(me);
    expect(refresh.count).toBe(1);
  });

  it("refresh 失敗時通知登入已失效", async () => {
    setAccessToken("expired");
    meAccepts("never");
    refreshCounter(null);
    const lost = vi.fn();
    const off = onAuthLost(lost);
    try {
      const result = await api.GET("/api/v1/me");
      expect(() => unwrap(result)).toThrow(ApiError);
      expect(result.response.status).toBe(401);
      expect(lost).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it("重送後仍 401 不再重試", async () => {
    setAccessToken("expired");
    const meCalls = meAccepts("never");
    const refresh = refreshCounter("still-bad");
    await api.GET("/api/v1/me");
    expect(meCalls.count).toBe(2);
    expect(refresh.count).toBe(1);
  });

  it("auth 端點的 401 不觸發 refresh", async () => {
    const refresh = refreshCounter("new");
    server.use(
      http.post("/api/v1/auth/login", () =>
        HttpResponse.json({ detail: "Email 或密碼錯誤" }, { status: 401 }),
      ),
    );
    const result = await api.POST("/api/v1/auth/login", {
      body: { email: "a@x.test", password: "wrong-password" },
    });
    expect(result.response.status).toBe(401);
    expect(refresh.count).toBe(0);
  });

  it("POST 重送時帶著原本的 body", async () => {
    setAccessToken("expired");
    refreshCounter("new");
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/v1/watches", async ({ request }) => {
        bodies.push(await request.json());
        return request.headers.get("Authorization") === "Bearer new"
          ? HttpResponse.json({}, { status: 201 })
          : HttpResponse.json({ detail: "請重新登入" }, { status: 401 });
      }),
    );
    const body = {
      origin: "TPE",
      destination: "NRT",
      depart_date: "2026-12-19",
      cabin: "economy" as const,
      adults: 1,
      airlines: [],
      target_price: 9000,
    };
    const result = await api.POST("/api/v1/watches", { body });
    expect(result.response.status).toBe(201);
    expect(bodies).toEqual([body, body]);
  });
});
