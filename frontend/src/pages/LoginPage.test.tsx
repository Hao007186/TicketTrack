import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { mockCommon, mockWatches } from "../test/data";
import { alice } from "../test/fixtures";
import { renderApp } from "../test/render";
import { server } from "../test/server";

async function fillLogin(password = "correct-horse") {
  await userEvent.type(await screen.findByLabelText("Email"), "alice@example.com");
  await userEvent.type(screen.getByLabelText("密碼"), password);
  await userEvent.click(screen.getByRole("button", { name: "登入" }));
}

describe("登入頁", () => {
  it("登入後回到 next", async () => {
    mockCommon();
    renderApp("/login?next=%2Fnotifications", { user: null });
    server.use(
      http.post("/api/v1/auth/login", () =>
        HttpResponse.json({ access_token: "t", token_type: "bearer" }),
      ),
      http.get("/api/v1/me", () => HttpResponse.json(alice)),
    );
    await fillLogin();
    expect(await screen.findByRole("heading", { name: "通知" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/notifications");
  });

  it("密碼錯誤顯示後端訊息", async () => {
    renderApp("/login", { user: null });
    server.use(
      http.post("/api/v1/auth/login", () =>
        HttpResponse.json({ detail: "Email 或密碼錯誤" }, { status: 401 }),
      ),
    );
    await fillLogin("wrong-password");
    expect(await screen.findByText("Email 或密碼錯誤")).toBeInTheDocument();
  });

  it("已登入時開登入頁會導到我的追蹤", async () => {
    mockCommon();
    mockWatches([]);
    renderApp("/login", { user: alice });
    expect(await screen.findByRole("heading", { name: "我的追蹤" })).toBeInTheDocument();
  });
});

describe("首頁的示範帳號", () => {
  it("示範帳號尚未建立時顯示提示", async () => {
    renderApp("/", { user: null });
    server.use(
      http.post("/api/v1/auth/demo", () =>
        HttpResponse.json({ detail: "示範帳號尚未建立" }, { status: 503 }),
      ),
    );
    await userEvent.click(await screen.findByRole("button", { name: "以示範帳號瀏覽" }));
    expect(await screen.findByText("示範帳號暫時無法使用")).toBeInTheDocument();
  });
});

describe("註冊頁", () => {
  it("Email 已註冊時顯示後端訊息", async () => {
    renderApp("/register", { user: null });
    server.use(
      http.post("/api/v1/auth/register", () =>
        HttpResponse.json({ detail: "此 Email 已註冊" }, { status: 409 }),
      ),
    );
    await userEvent.type(await screen.findByLabelText("Email"), "alice@example.com");
    await userEvent.type(screen.getByLabelText("密碼"), "correct-horse");
    await userEvent.click(screen.getByRole("button", { name: "註冊" }));
    expect(await screen.findByText("此 Email 已註冊")).toBeInTheDocument();
  });

  it("密碼少於 8 個字元時不送出", async () => {
    let called = false;
    renderApp("/register", { user: null });
    server.use(
      http.post("/api/v1/auth/register", () => {
        called = true;
        return HttpResponse.json({ access_token: "t", token_type: "bearer" }, { status: 201 });
      }),
    );
    await userEvent.type(await screen.findByLabelText("Email"), "alice@example.com");
    await userEvent.type(screen.getByLabelText("密碼"), "short");
    await userEvent.click(screen.getByRole("button", { name: "註冊" }));
    expect(await screen.findByText("密碼至少 8 個字元")).toBeInTheDocument();
    expect(called).toBe(false);
  });
});
