import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { mockCommon } from "../test/data";
import { alice, demo } from "../test/fixtures";
import { renderApp } from "../test/render";
import { server } from "../test/server";

function mockSettings(initial: boolean) {
  let enabled = initial;
  const patches: unknown[] = [];
  server.use(
    http.get("/api/v1/me/notification-settings", () =>
      HttpResponse.json({ email_enabled: enabled }),
    ),
    http.patch("/api/v1/me/notification-settings", async ({ request }) => {
      const body = (await request.json()) as { email_enabled: boolean };
      patches.push(body);
      enabled = body.email_enabled;
      return HttpResponse.json({ email_enabled: enabled });
    }),
  );
  return patches;
}

describe("設定", () => {
  it("顯示個人資料", async () => {
    mockCommon();
    mockSettings(true);
    renderApp("/settings", { user: alice });
    expect(await screen.findByText("alice@example.com")).toBeInTheDocument();
  });

  it("切換 Email 通知", async () => {
    mockCommon();
    const patches = mockSettings(true);
    renderApp("/settings");
    const toggle = await screen.findByRole("switch", { name: "Email 通知" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    await userEvent.click(toggle);
    await waitFor(() => expect(patches).toEqual([{ email_enabled: false }]));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });

  it("示範帳號不能切換", async () => {
    mockCommon();
    mockSettings(true);
    renderApp("/settings", { user: demo });
    expect(await screen.findByRole("switch", { name: "Email 通知" })).toBeDisabled();
  });

  describe("修改密碼", () => {
    async function fill(current: string, next: string, confirm: string) {
      await userEvent.type(await screen.findByLabelText("目前密碼"), current);
      await userEvent.type(screen.getByLabelText("新密碼"), next);
      await userEvent.type(screen.getByLabelText("確認新密碼"), confirm);
    }

    it("修改密碼成功", async () => {
      mockCommon();
      mockSettings(true);
      const bodies: unknown[] = [];
      server.use(
        http.post("/api/v1/me/password", async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json({ access_token: "new-token", token_type: "bearer" });
        }),
      );
      renderApp("/settings");
      await fill("old-password", "new-password-1", "new-password-1");
      await userEvent.click(screen.getByRole("button", { name: "更新密碼" }));
      expect(await screen.findByText("密碼已更新，其他裝置已登出")).toBeInTheDocument();
      expect(bodies).toEqual([
        { current_password: "old-password", new_password: "new-password-1" },
      ]);
      expect(screen.getByLabelText("目前密碼")).toHaveValue("");
      expect(screen.getByLabelText("新密碼")).toHaveValue("");
      expect(screen.getByLabelText("確認新密碼")).toHaveValue("");
    });

    it("目前密碼錯誤顯示後端訊息", async () => {
      mockCommon();
      mockSettings(true);
      server.use(
        http.post("/api/v1/me/password", () =>
          HttpResponse.json({ detail: "目前的密碼錯誤，再錯 4 次會鎖定 15 分鐘" }, { status: 400 }),
        ),
      );
      renderApp("/settings");
      await fill("wrong-password", "new-password-1", "new-password-1");
      await userEvent.click(screen.getByRole("button", { name: "更新密碼" }));
      expect(
        await screen.findByText("目前的密碼錯誤，再錯 4 次會鎖定 15 分鐘"),
      ).toBeInTheDocument();
    });

    it("確認密碼不同", async () => {
      mockCommon();
      mockSettings(true);
      let called = false;
      server.use(
        http.post("/api/v1/me/password", () => {
          called = true;
          return HttpResponse.json({ access_token: "x", token_type: "bearer" });
        }),
      );
      renderApp("/settings");
      await fill("old-password", "new-password-1", "new-password-2");
      await userEvent.click(screen.getByRole("button", { name: "更新密碼" }));
      expect(await screen.findByText("兩次輸入的密碼不一樣")).toBeInTheDocument();
      expect(called).toBe(false);
    });

    it("示範帳號按鈕停用", async () => {
      mockCommon();
      mockSettings(true);
      renderApp("/settings", { user: demo });
      expect(await screen.findByRole("button", { name: "更新密碼" })).toBeDisabled();
    });
  });
});
