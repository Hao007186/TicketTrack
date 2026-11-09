import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import type { components } from "../api/schema";
import { mockCommon } from "../test/data";
import { admin, alice } from "../test/fixtures";
import { renderApp } from "../test/render";
import { server } from "../test/server";

type AdminUser = components["schemas"]["AdminUserOut"];
type AdminWatch = components["schemas"]["AdminWatchOut"];
type AdminUsage = components["schemas"]["AdminUsageOut"];

const usage: AdminUsage = {
  serpapi_remaining: 180,
  daily_budget: 9,
  instant_remaining: 0,
  month_calls: 70,
  checked_today: 7,
  instant_today: 2,
  slots_used: 8,
  slots_max: 8,
  queued: 5,
  email_sent: 30,
  email_failed: 1,
  email_pending: 0,
};

function account(overrides: Partial<AdminUser>): AdminUser {
  return {
    public_id: "00000000-0000-0000-0000-000000000001",
    email: "someone@example.com",
    display_name: null,
    role: "user",
    is_demo: false,
    is_active: true,
    created_at: "2026-11-01T00:00:00Z",
    slot_count: 0,
    watch_count: 0,
    ...overrides,
  };
}

const users: AdminUser[] = [
  account({ public_id: admin.public_id, email: admin.email, role: "admin" }),
  // 暫停、過期的也會刪掉，所以確認視窗用 watch_count
  account({ public_id: alice.public_id, email: alice.email, slot_count: 2, watch_count: 4 }),
  account({
    public_id: "00000000-0000-0000-0000-0000000000b0",
    email: "bob@example.com",
    is_active: false,
  }),
  account({
    public_id: "00000000-0000-0000-0000-0000000000de",
    email: "demo@farewatch.example",
    is_demo: true,
    slot_count: 3,
  }),
];

const watches: AdminWatch[] = [
  {
    public_id: "00000000-0000-0000-0000-00000000aaaa",
    owner_email: alice.email,
    origin: "TPE",
    destination: "NRT",
    depart_date: "2026-12-20",
    return_date: null,
    status: "active",
    created_at: "2026-11-01T00:00:00Z",
  },
];

function mockAdmin(overrides: { usage?: Partial<AdminUsage> } = {}) {
  mockCommon();
  server.use(
    http.get("/api/v1/watches", () => HttpResponse.json([])),
    http.get("/api/v1/admin/usage", () => HttpResponse.json({ ...usage, ...overrides.usage })),
    http.get("/api/v1/admin/users", () => HttpResponse.json(users)),
    http.get("/api/v1/admin/watches", () => HttpResponse.json(watches)),
  );
}

function row(text: string) {
  const table = screen.getByRole("table", { name: "帳號" });
  const cell = within(table).getByText(text);
  const tr = cell.closest("tr");
  if (!tr) throw new Error(`找不到 ${text} 所在的列`);
  return within(tr);
}

describe("後台", () => {
  it("非 admin 看到找不到頁面", async () => {
    mockCommon();
    renderApp("/admin");
    expect(await screen.findByText("找不到這個頁面")).toBeInTheDocument();
  });

  it("導覽列只有 admin 有後台連結", async () => {
    mockAdmin();
    const { unmount } = renderApp("/admin", { user: admin });
    expect(await screen.findByRole("link", { name: "後台" })).toBeInTheDocument();
    unmount();

    mockCommon();
    server.use(http.get("/api/v1/watches", () => HttpResponse.json([])));
    renderApp("/watches");
    expect(await screen.findByRole("link", { name: "我的追蹤" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "後台" })).not.toBeInTheDocument();
  });

  it("顯示用量", async () => {
    mockAdmin();
    renderApp("/admin", { user: admin });
    expect(await screen.findByText("180 次")).toBeInTheDocument();
    expect(screen.getByText("9 次（依目前剩餘額度計算）")).toBeInTheDocument();
    expect(screen.getByText("7 組條件，其中立即查價 2 次")).toBeInTheDocument();
    expect(screen.getByText("70 次")).toBeInTheDocument();
    expect(screen.getByText("8 / 8 組，排隊中 5 個")).toBeInTheDocument();
    expect(screen.getByText("成功 30｜失敗 1｜待寄 0")).toBeInTheDocument();
  });

  it("顯示查詢失敗", async () => {
    mockAdmin({ usage: { serpapi_remaining: null, daily_budget: null, instant_remaining: null } });
    renderApp("/admin", { user: admin });
    expect(await screen.findByText("查詢失敗")).toBeInTheDocument();
    expect(screen.getByText("8 / 8 組，排隊中 5 個")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("停用帳號", async () => {
    mockAdmin();
    let deactivated = "";
    server.use(
      http.post("/api/v1/admin/users/:id/deactivate", ({ params }) => {
        deactivated = String(params.id);
        return HttpResponse.json({ ...users[1], is_active: false, slot_count: 0 });
      }),
    );
    renderApp("/admin", { user: admin });
    await screen.findByRole("table", { name: "帳號" });
    await userEvent.click(row(alice.email).getByRole("button", { name: "停用" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        `停用 ${alice.email} 後，他的 4 個追蹤會被刪除，恢復帳號後也不會回來。`,
      ),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "停用" }));
    await waitFor(() => expect(deactivated).toBe(alice.public_id));
    expect(await screen.findByText("已停用帳號")).toBeInTheDocument();
  });

  it("恢復帳號", async () => {
    mockAdmin();
    let reactivated = "";
    server.use(
      http.post("/api/v1/admin/users/:id/reactivate", ({ params }) => {
        reactivated = String(params.id);
        return HttpResponse.json({ ...users[2], is_active: true });
      }),
    );
    renderApp("/admin", { user: admin });
    await screen.findByRole("table", { name: "帳號" });
    await userEvent.click(row("bob@example.com").getByRole("button", { name: "恢復" }));
    await waitFor(() => expect(reactivated).toBe(users[2].public_id));
    expect(await screen.findByText("已恢復帳號")).toBeInTheDocument();
  });

  it("自己與示範帳號沒有停用按鈕", async () => {
    mockAdmin();
    renderApp("/admin", { user: admin });
    await screen.findByRole("table", { name: "帳號" });
    expect(row(admin.email).queryByRole("button")).not.toBeInTheDocument();
    expect(row("demo@farewatch.example").queryByRole("button")).not.toBeInTheDocument();
    expect(row("demo@farewatch.example").getByText("示範帳號")).toBeInTheDocument();
  });

  it("刪除追蹤", async () => {
    mockAdmin();
    let deleted = "";
    server.use(
      http.delete("/api/v1/admin/watches/:id", ({ params }) => {
        deleted = String(params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderApp("/admin", { user: admin });
    await userEvent.click(await screen.findByRole("button", { name: "刪除" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(`確定要刪除 ${alice.email} 的 TPE→NRT（2026/12/20）嗎？`),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "刪除" }));
    await waitFor(() => expect(deleted).toBe(watches[0].public_id));
    expect(await screen.findByText("已刪除追蹤")).toBeInTheDocument();
  });

  it("操作失敗時顯示後端訊息", async () => {
    mockAdmin();
    server.use(
      http.post("/api/v1/admin/users/:id/deactivate", () =>
        HttpResponse.json({ detail: "帳號已經是停用狀態" }, { status: 409 }),
      ),
    );
    renderApp("/admin", { user: admin });
    await screen.findByRole("table", { name: "帳號" });
    await userEvent.click(row(alice.email).getByRole("button", { name: "停用" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "停用" }));
    expect(await screen.findByText("帳號已經是停用狀態")).toBeInTheDocument();
  });
});
