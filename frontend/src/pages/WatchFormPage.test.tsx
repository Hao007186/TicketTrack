import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addDays, todayInTaipei } from "../lib/format";
import { makeWatch, mockCommon, mockDetail, mockWatches } from "../test/data";
import { demo } from "../test/fixtures";
import { renderApp } from "../test/render";
import { server } from "../test/server";

const DEPART = addDays(todayInTaipei(), 30);
const RETURN = addDays(todayInTaipei(), 35);

async function fillValid() {
  // 等機場清單載入
  await screen.findByRole("option", { name: "東京成田 NRT" });
  await userEvent.selectOptions(screen.getByLabelText("目的地"), "NRT");
  fireEvent.change(screen.getByLabelText("出發日"), { target: { value: DEPART } });
  fireEvent.change(screen.getByLabelText("回程日"), { target: { value: RETURN } });
  await userEvent.type(screen.getByLabelText("目標價（TWD）"), "9500");
}

function mockGetWatch(watch: ReturnType<typeof makeWatch>) {
  server.use(http.get(`/api/v1/watches/${watch.public_id}`, () => HttpResponse.json(watch)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("新增追蹤", () => {
  it("來回才顯示回程日", async () => {
    mockCommon();
    renderApp("/watches/new");
    expect(await screen.findByLabelText("回程日")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("單程"));
    expect(screen.queryByLabelText("回程日")).not.toBeInTheDocument();
  });

  it("前端驗證失敗時不送出", async () => {
    mockCommon();
    let called = false;
    server.use(
      http.post("/api/v1/watches", () => {
        called = true;
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    renderApp("/watches/new");
    await userEvent.click(await screen.findByRole("button", { name: "建立追蹤" }));
    expect(await screen.findByText("請選擇目的地")).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it("後端錯誤顯示在表單上，不另外跳提示", async () => {
    mockCommon();
    server.use(
      http.post("/api/v1/watches", () =>
        HttpResponse.json({ detail: "每人最多 3 個追蹤" }, { status: 409 }),
      ),
    );
    renderApp("/watches/new");
    await fillValid();
    await userEvent.click(screen.getByRole("button", { name: "建立追蹤" }));
    expect(await screen.findAllByText("每人最多 3 個追蹤")).toHaveLength(1);
  });

  it("排隊中時提示並導到詳情頁", async () => {
    mockCommon();
    const created = makeWatch({ status: "queued" });
    mockDetail(created);
    let body: unknown;
    server.use(
      http.post("/api/v1/watches", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    renderApp("/watches/new");
    await fillValid();
    await userEvent.click(screen.getByRole("button", { name: "建立追蹤" }));
    expect(await screen.findByText(/目前全站名額已滿/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(`/watches/${created.public_id}`),
    );
    expect(body).toMatchObject({
      origin: "TPE",
      destination: "NRT",
      depart_date: DEPART,
      return_date: RETURN,
      target_price: 9500,
    });
  });

  it("示範帳號不能送出", async () => {
    mockCommon();
    renderApp("/watches/new", { user: demo });
    expect(await screen.findByRole("button", { name: "建立追蹤" })).toBeDisabled();
  });
});

describe("編輯追蹤", () => {
  it("改成單程時送出 return_date: null，沒改的欄位不送", async () => {
    mockCommon();
    const watch = makeWatch({ depart_date: DEPART, return_date: RETURN });
    // 儲存後會導到詳情頁
    mockDetail(watch);
    mockWatches([watch]);
    let body: unknown;
    server.use(
      http.patch(`/api/v1/watches/${watch.public_id}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...watch, return_date: null, trip_type: "one_way" });
      }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp(`/watches/${watch.public_id}/edit`);
    await userEvent.click(await screen.findByLabelText("單程"));
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(body).toEqual({ return_date: null }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("通知狀態會重置"));
  });

  it("取消確認時不送出", async () => {
    mockCommon();
    const watch = makeWatch({ depart_date: DEPART, return_date: RETURN });
    mockGetWatch(watch);
    let called = false;
    server.use(
      http.patch(`/api/v1/watches/${watch.public_id}`, () => {
        called = true;
        return HttpResponse.json(watch);
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderApp(`/watches/${watch.public_id}/edit`);
    const price = await screen.findByLabelText("目標價（TWD）");
    await userEvent.clear(price);
    await userEvent.type(price, "8000");
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    expect(called).toBe(false);
  });

  it("已過期的追蹤不能編輯", async () => {
    mockCommon();
    const watch = makeWatch({ status: "expired" });
    mockGetWatch(watch);
    renderApp(`/watches/${watch.public_id}/edit`);
    expect(await screen.findByText("已過期的追蹤不能修改")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "儲存" })).not.toBeInTheDocument();
  });

  it("追蹤不存在時顯示已刪除", async () => {
    mockCommon();
    server.use(
      http.get("/api/v1/watches/:id", () =>
        HttpResponse.json({ detail: "找不到追蹤" }, { status: 404 }),
      ),
    );
    renderApp("/watches/00000000-0000-0000-0000-00000000dead/edit");
    expect(await screen.findByText("找不到這個追蹤，可能已被刪除")).toBeInTheDocument();
  });
});
