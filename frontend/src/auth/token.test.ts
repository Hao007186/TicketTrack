import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installFakeLocks } from "../test/locks";
import { server } from "../test/server";
import { getAccessToken, refreshAccessToken, setAccessToken } from "./token";

const REFRESH = "/api/v1/auth/refresh";

function refreshReturns(...tokens: string[]) {
  const calls = { count: 0 };
  server.use(
    http.post(REFRESH, () => {
      const token = tokens[calls.count++];
      return HttpResponse.json({ access_token: token, token_type: "bearer" });
    }),
  );
  return calls;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  setAccessToken(null);
});

describe("refreshAccessToken", () => {
  it("refresh 成功時存下 token", async () => {
    refreshReturns("new");
    expect(await refreshAccessToken()).toBe("new");
    expect(getAccessToken()).toBe("new");
  });

  it("refresh 401 時回傳 null 並清掉 token", async () => {
    setAccessToken("old");
    server.use(
      http.post(REFRESH, () => HttpResponse.json({ detail: "請重新登入" }, { status: 401 })),
    );
    expect(await refreshAccessToken()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it("同時呼叫只送一次", async () => {
    const calls = refreshReturns("t1", "t2");
    const results = await Promise.all([
      refreshAccessToken(),
      refreshAccessToken(),
      refreshAccessToken(),
    ]);
    expect(calls.count).toBe(1);
    expect(results).toEqual(["t1", "t1", "t1"]);
  });

  describe("跨分頁", () => {
    let locks: ReturnType<typeof installFakeLocks>;
    beforeEach(() => {
      locks = installFakeLocks();
    });
    afterEach(() => {
      locks.uninstall();
    });

    it("其他分頁拿著鎖時要等它放開才送出", async () => {
      const calls = refreshReturns("t1");
      let release!: () => void;
      // 模擬另一個分頁正在 refresh
      const otherTab = locks.request(
        "farewatch-refresh",
        () => new Promise<void>((r) => (release = r)),
      );

      const mine = refreshAccessToken();
      await tick();
      expect(calls.count).toBe(0);

      release();
      await otherTab;
      expect(await mine).toBe("t1");
      expect(calls.count).toBe(1);
      expect(locks.names).toEqual(["farewatch-refresh", "farewatch-refresh"]);
    });
  });
});
