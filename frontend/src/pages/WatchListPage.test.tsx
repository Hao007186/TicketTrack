import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { demo } from "../test/fixtures";
import { makeWatch, mockCommon, mockWatches } from "../test/data";
import { renderApp } from "../test/render";
import { server } from "../test/server";

const four = () => [
  makeWatch({ status: "active" }),
  makeWatch({ status: "queued", destination: "KIX" }),
  makeWatch({ status: "paused", destination: "ICN" }),
  makeWatch({
    status: "expired",
    depart_date: "2026-10-01",
    return_date: null,
    trip_type: "one_way",
  }),
];

describe("我的追蹤", () => {
  it("進行中和歷史紀錄分頁放對追蹤", async () => {
    mockCommon();
    mockWatches(four());
    renderApp("/watches");
    expect(await screen.findAllByRole("article")).toHaveLength(3);
    await userEvent.click(screen.getByRole("tab", { name: "歷史紀錄" }));
    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getByText("已過期")).toBeInTheDocument();
  });

  it("名額只算查價中和排隊中", async () => {
    mockCommon();
    mockWatches(four());
    renderApp("/watches");
    expect(await screen.findByText("已用 2／3 個名額")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增追蹤" })).toBeEnabled();
  });

  it("名額已滿時不能新增", async () => {
    mockCommon();
    mockWatches([makeWatch(), makeWatch(), makeWatch({ status: "queued" })]);
    renderApp("/watches");
    expect(await screen.findByText("名額已滿")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增追蹤" })).toBeDisabled();
  });

  it("示範帳號看得到唯讀提示", async () => {
    mockCommon();
    mockWatches([]);
    renderApp("/watches", { user: demo });
    expect(await screen.findByText("你正在使用示範帳號，資料為唯讀")).toBeInTheDocument();
  });

  it("顯示目前最低價並標示已低於目標價", async () => {
    const watch = makeWatch({ target_price: 9500 });
    mockCommon();
    mockWatches([watch], { [watch.public_id]: { latest_price: 9000 } });
    renderApp("/watches");
    const card = await screen.findByRole("article");
    expect(await within(card).findByText("NT$ 9,000")).toBeInTheDocument();
    expect(within(card).getByText("已低於目標價")).toBeInTheDocument();
    expect(within(card).getByText("台北桃園 TPE → 東京成田 NRT")).toBeInTheDocument();
  });

  it("讀取失敗可以重試", async () => {
    mockCommon();
    mockWatches([makeWatch()]);
    let first = true;
    server.use(
      http.get("/api/v1/watches", () => {
        if (first) {
          first = false;
          return HttpResponse.json({ detail: "boom" }, { status: 500 });
        }
        return HttpResponse.json([makeWatch()]);
      }),
    );
    renderApp("/watches");
    expect(await screen.findByText("連線失敗，請稍後再試")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重試" }));
    expect(await screen.findByRole("article")).toBeInTheDocument();
  });

  it("鈴鐺顯示未讀數", async () => {
    mockCommon({ unread: 3 });
    mockWatches([]);
    renderApp("/watches");
    expect(await screen.findByRole("link", { name: "通知（3 則未讀）" })).toBeInTheDocument();
  });
});
