import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import type { components } from "../api/schema";
import { makeWatch, mockCommon, mockDetail as mockDetailApis, mockWatches } from "../test/data";
import { renderApp } from "../test/render";
import { server } from "../test/server";

type Watch = components["schemas"]["WatchOut"];
type Baseline = components["schemas"]["BaselineOut"];

function mockDetail(watch: Watch, baseline: Partial<Baseline> = {}) {
  mockCommon();
  return mockDetailApis(watch, baseline);
}

describe("追蹤詳情", () => {
  it("追蹤已刪除時顯示提示", async () => {
    mockCommon();
    server.use(
      http.get("/api/v1/watches/:id", () =>
        HttpResponse.json({ detail: "找不到追蹤" }, { status: 404 }),
      ),
      http.get("/api/v1/watches/:id/:sub", () =>
        HttpResponse.json({ detail: "找不到追蹤" }, { status: 404 }),
      ),
    );
    renderApp("/watches/00000000-0000-0000-0000-00000000dead");
    expect(await screen.findByText("找不到這個追蹤，可能已被刪除")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "回我的追蹤" })).toBeInTheDocument();
  });

  it("已過期時預設顯示全部期間，也沒有編輯和暫停", async () => {
    const watch = makeWatch({ status: "expired" });
    const ranges = mockDetail(watch);
    renderApp(`/watches/${watch.public_id}`);
    await waitFor(() => expect(ranges).toEqual(["all"]));
    expect(await screen.findByRole("button", { name: "刪除" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "編輯" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暫停" })).not.toBeInTheDocument();
  });

  it("進行中預設 90 天，可以切換", async () => {
    const watch = makeWatch({ status: "active" });
    const ranges = mockDetail(watch);
    renderApp(`/watches/${watch.public_id}`);
    await waitFor(() => expect(ranges).toEqual(["90d"]));
    await userEvent.click(screen.getByRole("button", { name: "30 天" }));
    await waitFor(() => expect(ranges).toEqual(["90d", "30d"]));
  });

  it("歷史資料不夠時顯示累積中", async () => {
    const watch = makeWatch();
    mockDetail(watch, { latest_price: 9100, typical_low: 6400, typical_high: 12500 });
    renderApp(`/watches/${watch.public_id}`);
    expect(await screen.findByText("歷史資料累積中")).toBeInTheDocument();
    expect(screen.getByText("NT$ 6,400 – NT$ 12,500")).toBeInTheDocument();
  });

  it("排隊中時顯示提示", async () => {
    const watch = makeWatch({ status: "queued" });
    mockDetail(watch);
    renderApp(`/watches/${watch.public_id}`);
    expect(await screen.findByText("全站名額已滿，排隊中，暫不查價")).toBeInTheDocument();
  });

  it("有訂票連結時在新分頁開啟", async () => {
    const watch = makeWatch();
    const url = "https://www.google.com/travel/flights?x";
    mockDetail(watch, { latest_price: 9100, latest_booking_url: url });
    renderApp(`/watches/${watch.public_id}`);
    const link = await screen.findByRole("link", { name: "去 Google Flights 訂票" });
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("刪除後回到我的追蹤", async () => {
    const watch = makeWatch();
    mockDetail(watch);
    mockWatches([]);
    let deleted = false;
    server.use(
      http.delete(`/api/v1/watches/${watch.public_id}`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderApp(`/watches/${watch.public_id}`);
    await userEvent.click(await screen.findByRole("button", { name: "刪除" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "刪除" }));
    expect(await screen.findByRole("heading", { name: "我的追蹤" })).toBeInTheDocument();
    expect(deleted).toBe(true);
  });

  it("恢復時名額已滿顯示後端訊息", async () => {
    const watch = makeWatch({ status: "paused" });
    mockDetail(watch);
    server.use(
      http.patch(`/api/v1/watches/${watch.public_id}`, () =>
        HttpResponse.json({ detail: "每人最多 3 個追蹤" }, { status: 409 }),
      ),
    );
    renderApp(`/watches/${watch.public_id}`);
    await userEvent.click(await screen.findByRole("button", { name: "恢復" }));
    expect(await screen.findByText("每人最多 3 個追蹤")).toBeInTheDocument();
  });

  it("顯示這個追蹤的最近通知", async () => {
    const watch = makeWatch();
    mockDetail(watch);
    const seen: (string | null)[] = [];
    server.use(
      http.get("/api/v1/notifications", ({ request }) => {
        const params = new URL(request.url).searchParams;
        if (params.get("watch_id") === null)
          return HttpResponse.json({ items: [], unread_count: 0 });
        seen.push(params.get("watch_id"));
        return HttpResponse.json({
          items: [
            {
              id: "00000000-0000-0000-0000-0000000000f1",
              type: "price_alert",
              title: "TPE→NRT 12/19 來回：跌破目標價",
              body: "目前最低價 NT$9,100",
              link: `/watches/${watch.public_id}`,
              booking_url: null,
              is_read: true,
              created_at: "2026-10-22T00:00:00Z",
            },
          ],
          unread_count: 0,
        });
      }),
    );
    renderApp(`/watches/${watch.public_id}`);
    expect(await screen.findByText("TPE→NRT 12/19 來回：跌破目標價")).toBeInTheDocument();
    expect(seen).toContain(watch.public_id);
  });
});
