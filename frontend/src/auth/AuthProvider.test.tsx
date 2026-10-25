import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { mockCommon } from "../test/data";
import { alice } from "../test/fixtures";
import { renderApp } from "../test/render";
import { server } from "../test/server";

describe("登入狀態", () => {
  it("啟動時用 refresh 恢復登入", async () => {
    renderApp("/watches", { user: alice });
    expect(await screen.findByRole("heading", { name: "我的追蹤" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登入" })).not.toBeInTheDocument();
  });

  it("沒登入時導到登入頁並記住原網址", async () => {
    renderApp("/watches/abc?x=1", { user: null });
    expect(await screen.findByRole("button", { name: "登入" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/login?next=" + encodeURIComponent("/watches/abc?x=1"),
    );
  });

  it("登出後回到首頁", async () => {
    let loggedOut = false;
    server.use(
      http.post("/api/v1/auth/logout", () => {
        loggedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    mockCommon();
    renderApp("/settings", { user: alice });
    await userEvent.click(await screen.findByRole("button", { name: "Alice" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "登出" }));
    expect(await screen.findByRole("button", { name: "以示範帳號瀏覽" })).toBeInTheDocument();
    expect(loggedOut).toBe(true);
  });
});
