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
});
