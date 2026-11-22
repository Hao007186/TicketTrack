import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { renderApp } from "../test/render";
import { server } from "../test/server";

const ACK = "如果這個 Email 有註冊，我們已寄出重設密碼的信";

describe("忘記密碼頁", () => {
  it("送出後顯示後端訊息", async () => {
    let body: unknown = null;
    renderApp("/forgot-password", { user: null });
    server.use(
      http.post("/api/v1/auth/password-reset/request", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ detail: ACK }, { status: 202 });
      }),
    );
    await userEvent.type(await screen.findByLabelText("Email"), "alice@example.com");
    await userEvent.click(screen.getByRole("button", { name: "寄送重設信" }));
    expect(await screen.findByText(ACK)).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(body).toEqual({ email: "alice@example.com" });
    await userEvent.click(screen.getByRole("link", { name: "回到登入" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/login");
  });
});
