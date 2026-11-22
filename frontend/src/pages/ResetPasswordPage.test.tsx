import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { alice } from "../test/fixtures";
import { renderApp } from "../test/render";
import { server } from "../test/server";

const INVALID = "重設連結無效或已過期";

async function fillReset(password: string, confirm: string) {
  await userEvent.type(await screen.findByLabelText("新密碼"), password);
  await userEvent.type(screen.getByLabelText("再輸入一次新密碼"), confirm);
  await userEvent.click(screen.getByRole("button", { name: "重設密碼" }));
}

function mockConfirm() {
  const calls: unknown[] = [];
  server.use(
    http.post("/api/v1/auth/password-reset/confirm", async ({ request }) => {
      calls.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return calls;
}

describe("重設密碼頁", () => {
  it("成功後導到登入頁並顯示提示", async () => {
    renderApp("/reset-password?token=abc", { user: null });
    const calls = mockConfirm();
    await fillReset("new-password-1", "new-password-1");
    expect(await screen.findByText("密碼已重設，請用新密碼登入")).toBeInTheDocument();
    expect(calls).toEqual([{ token: "abc", new_password: "new-password-1" }]);
    expect(screen.getByTestId("location")).toHaveTextContent("/login?reset=1");
  });

  it("已登入的人重設後被登出", async () => {
    renderApp("/reset-password?token=abc", { user: alice });
    mockConfirm();
    await fillReset("new-password-1", "new-password-1");
    expect(await screen.findByText("密碼已重設，請用新密碼登入")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/login?reset=1");
  });

  it("兩次密碼不同", async () => {
    renderApp("/reset-password?token=abc", { user: null });
    const calls = mockConfirm();
    await fillReset("new-password-1", "new-password-2");
    expect(await screen.findByText("兩次輸入的密碼不一樣")).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("少於 8 字", async () => {
    renderApp("/reset-password?token=abc", { user: null });
    const calls = mockConfirm();
    await fillReset("short", "short");
    expect(await screen.findByText("密碼至少 8 個字")).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("連結失效", async () => {
    renderApp("/reset-password?token=abc", { user: null });
    server.use(
      http.post("/api/v1/auth/password-reset/confirm", () =>
        HttpResponse.json({ detail: INVALID }, { status: 400 }),
      ),
    );
    await fillReset("new-password-1", "new-password-1");
    expect(await screen.findByText(INVALID)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "重新申請" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/forgot-password");
  });

  it("伺服器錯誤時不顯示重新申請", async () => {
    renderApp("/reset-password?token=abc", { user: null });
    server.use(
      http.post("/api/v1/auth/password-reset/confirm", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    await fillReset("new-password-1", "new-password-1");
    expect(await screen.findByText("連線失敗，請稍後再試")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "重新申請" })).not.toBeInTheDocument();
  });

  it("沒有 token", async () => {
    renderApp("/reset-password", { user: null });
    expect(await screen.findByText("連結不完整")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "重新申請" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
    expect(screen.queryByLabelText("新密碼")).not.toBeInTheDocument();
  });
});
