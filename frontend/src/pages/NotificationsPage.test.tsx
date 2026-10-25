import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import type { components } from "../api/schema";
import { mockCommon } from "../test/data";
import { demo } from "../test/fixtures";
import { renderApp } from "../test/render";
import { server } from "../test/server";

type Notification = components["schemas"]["NotificationOut"];

function note(i: number, overrides: Partial<Notification> = {}): Notification {
  return {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    type: "system",
    title: `通知 ${i}`,
    body: "內容",
    link: null,
    booking_url: null,
    is_read: false,
    created_at: "2026-10-22T00:00:00Z",
    ...overrides,
  };
}

describe("通知中心", () => {
  it("標為已讀後未讀數跟著更新", async () => {
    mockCommon();
    const items = [note(1), note(2)];
    let patched: string | null = null;
    server.use(
      http.get("/api/v1/notifications", () =>
        HttpResponse.json({ items, unread_count: items.filter((n) => !n.is_read).length }),
      ),
      http.patch("/api/v1/notifications/:id/read", ({ params }) => {
        patched = params.id as string;
        items[0] = { ...items[0], is_read: true };
        return HttpResponse.json(items[0]);
      }),
    );
    renderApp("/notifications");
    expect(await screen.findByRole("link", { name: "通知（2 則未讀）" })).toBeInTheDocument();
    const buttons = await screen.findAllByRole("button", { name: "標為已讀" });
    await userEvent.click(buttons[0]);
    expect(await screen.findByRole("link", { name: "通知（1 則未讀）" })).toBeInTheDocument();
    expect(patched).toBe(note(1).id);
    expect(screen.getAllByRole("button", { name: "標為已讀" })).toHaveLength(1);
  });

  it("載入更多時帶上最後一則的 id", async () => {
    mockCommon();
    const firstPage = Array.from({ length: 20 }, (_, i) => note(i + 1));
    const secondPage = Array.from({ length: 3 }, (_, i) => note(i + 21));
    const befores: (string | null)[] = [];
    server.use(
      http.get("/api/v1/notifications", ({ request }) => {
        const params = new URL(request.url).searchParams;
        if (params.get("limit") === "1") return HttpResponse.json({ items: [], unread_count: 23 });
        const before = params.get("before");
        befores.push(before);
        return HttpResponse.json({
          items: before === null ? firstPage : secondPage,
          unread_count: 23,
        });
      }),
    );
    renderApp("/notifications");
    expect(await screen.findByText("通知 20")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "載入更多" }));
    expect(await screen.findByText("通知 23")).toBeInTheDocument();
    expect(befores).toEqual([null, firstPage[19].id]);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "載入更多" })).not.toBeInTheDocument(),
    );
  });

  it("全部標為已讀", async () => {
    mockCommon();
    let called = false;
    server.use(
      http.get("/api/v1/notifications", () =>
        HttpResponse.json({ items: called ? [] : [note(1)], unread_count: called ? 0 : 1 }),
      ),
      http.post("/api/v1/notifications/read-all", () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderApp("/notifications");
    await userEvent.click(await screen.findByRole("button", { name: "全部標為已讀" }));
    await waitFor(() => expect(called).toBe(true));
    expect(await screen.findByRole("button", { name: "全部標為已讀" })).toBeDisabled();
  });

  it("示範帳號不能標為已讀", async () => {
    mockCommon();
    server.use(
      http.get("/api/v1/notifications", () =>
        HttpResponse.json({ items: [note(1)], unread_count: 1 }),
      ),
    );
    renderApp("/notifications", { user: demo });
    expect(await screen.findByRole("button", { name: "標為已讀" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "全部標為已讀" })).toBeDisabled();
  });

  it("沒有通知時顯示提示", async () => {
    mockCommon();
    renderApp("/notifications");
    expect(await screen.findByText("目前沒有通知")).toBeInTheDocument();
  });
});
