import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addDays, todayInTaipei } from "../lib/format";
import { emptyBaseline, makeWatch, mockCommon, mockDetail, mockWatches } from "../test/data";
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
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("最多消耗今天 3 次中的 1 次"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("通知狀態也會重置"));
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

describe("參考價", () => {
  const HAS_DATA = /典型價格|還沒有價格資料/;

  function mockReference(body: object, seen?: URL[]) {
    server.use(
      http.get("/api/v1/price-reference", ({ request }) => {
        seen?.push(new URL(request.url));
        return HttpResponse.json(body);
      }),
    );
  }

  it("有資料時顯示區間與更新日期", async () => {
    mockCommon();
    mockReference({ typical_low: 8200, typical_high: 11500, updated_at: "2026-10-20T01:00:00Z" });
    renderApp("/watches/new");
    await fillValid();
    expect(
      await screen.findByText("同條件的典型價格：NT$ 8,200～NT$ 11,500（10/20 更新）"),
    ).toBeInTheDocument();
  });

  it("查詢參數帶上表單條件", async () => {
    mockCommon();
    const seen: URL[] = [];
    mockReference({ typical_low: null, typical_high: null, updated_at: null }, seen);
    renderApp("/watches/new");
    await fillValid();
    await userEvent.click(screen.getByLabelText("中華航空"));
    await waitFor(() =>
      expect(seen.some((u) => u.searchParams.getAll("airlines").includes("CI"))).toBe(true),
    );
    const last = seen.at(-1)!;
    expect(last.searchParams.get("destination")).toBe("NRT");
    expect(last.searchParams.get("depart_date")).toBe(DEPART);
    expect(last.searchParams.get("return_date")).toBe(RETURN);
  });

  it("新增時沒資料顯示建立後的提示", async () => {
    mockCommon();
    renderApp("/watches/new");
    await fillValid();
    expect(
      await screen.findByText(
        "這個行程還沒有價格資料，建立後第一次查價就會顯示，之後可以再調整目標價",
      ),
    ).toBeInTheDocument();
  });

  it("編輯時沒資料顯示儲存後的提示", async () => {
    mockCommon();
    const watch = makeWatch();
    mockGetWatch(watch);
    renderApp(`/watches/${watch.public_id}/edit`);
    expect(
      await screen.findByText(
        "這個行程還沒有價格資料，儲存後第一次查價就會顯示，之後可以再調整目標價",
      ),
    ).toBeInTheDocument();
  });

  it("條件不完整時不發請求", async () => {
    mockCommon();
    let calls = 0;
    server.use(
      http.get("/api/v1/price-reference", () => {
        calls += 1;
        return HttpResponse.json({ typical_low: 1, typical_high: 2, updated_at: null });
      }),
    );
    renderApp("/watches/new");
    await screen.findByRole("option", { name: "東京成田 NRT" });
    await userEvent.selectOptions(screen.getByLabelText("目的地"), "NRT");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(0);
    expect(screen.queryByText(HAS_DATA)).not.toBeInTheDocument();
  });

  it("請求失敗時不顯示", async () => {
    mockCommon();
    let calls = 0;
    server.use(
      http.get("/api/v1/price-reference", () => {
        calls += 1;
        return HttpResponse.json({ detail: "壞掉了" }, { status: 500 });
      }),
    );
    renderApp("/watches/new");
    await fillValid();
    await waitFor(() => expect(calls).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(HAS_DATA)).not.toBeInTheDocument();
    expect(screen.queryByText(/壞掉了/)).not.toBeInTheDocument();
  });
});

describe("立即查價", () => {
  function recordChecks() {
    const checks: string[] = [];
    server.use(
      http.post("/api/v1/watches/:id/check", ({ params }) => {
        checks.push(params.id as string);
        return HttpResponse.json({ result: "checked" });
      }),
    );
    return checks;
  }

  async function createWatch(created: ReturnType<typeof makeWatch>) {
    mockDetail(created);
    server.use(http.post("/api/v1/watches", () => HttpResponse.json(created, { status: 201 })));
    renderApp("/watches/new");
    await fillValid();
    await userEvent.click(screen.getByRole("button", { name: "建立追蹤" }));
  }

  function editable(status: "active" | "paused" = "active") {
    const watch = makeWatch({ status, depart_date: DEPART, return_date: RETURN });
    mockDetail(watch);
    server.use(http.patch(`/api/v1/watches/${watch.public_id}`, () => HttpResponse.json(watch)));
    return watch;
  }

  it("新增後發一次查價請求", async () => {
    mockCommon();
    const checks = recordChecks();
    const created = makeWatch();
    await createWatch(created);
    await waitFor(() => expect(checks).toEqual([created.public_id]));
    expect(screen.getByTestId("location")).toHaveTextContent(`/watches/${created.public_id}`);
  });

  it("排隊中不發查價請求", async () => {
    mockCommon();
    const checks = recordChecks();
    await createWatch(makeWatch({ status: "queued" }));
    expect(await screen.findByText("全站名額已滿，排隊中，暫不查價")).toBeInTheDocument();
    expect(checks).toEqual([]);
  });

  it("改條件後發一次查價請求", async () => {
    mockCommon();
    const checks = recordChecks();
    const watch = editable();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp(`/watches/${watch.public_id}/edit`);
    await userEvent.click(await screen.findByLabelText("單程"));
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(checks).toEqual([watch.public_id]));
  });

  it("只改目標價不查價，維持原本的確認文字", async () => {
    mockCommon();
    const checks = recordChecks();
    const watch = editable();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp(`/watches/${watch.public_id}/edit`);
    const price = await screen.findByLabelText("目標價（TWD）");
    await userEvent.clear(price);
    await userEvent.type(price, "8000");
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    await screen.findByRole("button", { name: "編輯" });
    expect(confirm).toHaveBeenCalledWith("通知狀態會重置，之後的降價會重新判斷。確定要儲存嗎？");
    expect(checks).toEqual([]);
  });

  it("暫停中改條件不警告額度，也不查價", async () => {
    mockCommon();
    const checks = recordChecks();
    const watch = editable("paused");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp(`/watches/${watch.public_id}/edit`);
    await userEvent.click(await screen.findByLabelText("單程"));
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    await screen.findByRole("button", { name: "編輯" });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("通知狀態會重置，之後的降價會重新判斷。確定要儲存嗎？");
    expect(checks).toEqual([]);
  });

  it("取消額度警告時不送出、不查價", async () => {
    mockCommon();
    const checks = recordChecks();
    const watch = editable();
    let patched = false;
    server.use(
      http.patch(`/api/v1/watches/${watch.public_id}`, () => {
        patched = true;
        return HttpResponse.json(watch);
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderApp(`/watches/${watch.public_id}/edit`);
    await userEvent.click(await screen.findByLabelText("單程"));
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    expect(patched).toBe(false);
    expect(checks).toEqual([]);
  });

  it("查價中顯示提示，完成後重新載入價格", async () => {
    mockCommon();
    const created = makeWatch();
    let baselineCalls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockDetail(created);
    server.use(
      http.get(`/api/v1/watches/${created.public_id}/baseline`, () => {
        baselineCalls += 1;
        return HttpResponse.json({
          ...emptyBaseline,
          latest_price: baselineCalls > 1 ? 9100 : null,
        });
      }),
      http.post("/api/v1/watches/:id/check", async () => {
        await gate;
        return HttpResponse.json({ result: "checked" });
      }),
      http.post("/api/v1/watches", () => HttpResponse.json(created, { status: 201 })),
    );
    renderApp("/watches/new");
    await fillValid();
    await userEvent.click(screen.getByRole("button", { name: "建立追蹤" }));
    expect(await screen.findByText("查價中…")).toBeInTheDocument();
    release();
    expect(await screen.findByText("NT$ 9,100")).toBeInTheDocument();
    expect(screen.queryByText("查價中…")).not.toBeInTheDocument();
  });

  it.each([
    ["no_result", "這組條件目前查不到航班，明天 08:00 會再查"],
    ["not_eligible", "出發前 2 天內不再查價"],
    ["user_limit", "今天的立即查價次數已用完，明天 08:00 會自動查價"],
    ["site_limit", "目前無法立即查價，之後的排程會自動查價"],
    ["quota_exhausted", "目前無法立即查價，之後的排程會自動查價"],
    ["failed", "查價暫時失敗，明天 08:00 會再試"],
  ])("結果 %s 顯示提示", async (result, text) => {
    mockCommon();
    server.use(http.post("/api/v1/watches/:id/check", () => HttpResponse.json({ result })));
    await createWatch(makeWatch());
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it.each(["checked", "already_checked"])("結果 %s 不顯示提示", async (result) => {
    mockCommon();
    let done = false;
    server.use(
      http.post("/api/v1/watches/:id/check", () => {
        done = true;
        return HttpResponse.json({ result });
      }),
    );
    await createWatch(makeWatch());
    await waitFor(() => expect(done).toBe(true));
    await waitFor(() => expect(screen.queryByText("查價中…")).not.toBeInTheDocument());
    expect(screen.queryByText(/08:00|無法立即查價/)).not.toBeInTheDocument();
  });

  it("查價請求斷線：追蹤正常顯示，只有失敗提示，沒有全域錯誤", async () => {
    mockCommon();
    server.use(http.post("/api/v1/watches/:id/check", () => HttpResponse.error()));
    await createWatch(makeWatch());
    expect(await screen.findByText("查價暫時失敗，明天 08:00 會再試")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "編輯" })).toBeInTheDocument();
    expect(screen.queryByText(/網路|連線/)).not.toBeInTheDocument();
  });

  it("直接打開詳情頁不發查價請求", async () => {
    mockCommon();
    const checks = recordChecks();
    const watch = makeWatch();
    mockDetail(watch);
    renderApp(`/watches/${watch.public_id}`);
    await screen.findByRole("button", { name: "編輯" });
    expect(checks).toEqual([]);
    expect(screen.queryByText("查價中…")).not.toBeInTheDocument();
  });
});

describe("表單查價", () => {
  const BUTTON = "查目前價格（消耗 1 次）";
  const URL = "/api/v1/price-reference/check";
  const PRICES = {
    result: "checked",
    lowest_price: 9200,
    typical_low: 8200,
    typical_high: 11500,
  };
  const NO_PRICES = { lowest_price: null, typical_low: null, typical_high: null };

  function mockCheck(response: object) {
    const bodies: unknown[] = [];
    server.use(
      http.post(URL, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(response);
      }),
    );
    return bodies;
  }

  async function press() {
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
  }

  it("條件不完整時停用", async () => {
    mockCommon();
    renderApp("/watches/new");
    expect(await screen.findByRole("button", { name: BUTTON })).toBeDisabled();
  });

  it("示範帳號停用", async () => {
    mockCommon();
    renderApp("/watches/new", { user: demo });
    await fillValid();
    expect(screen.getByRole("button", { name: BUTTON })).toBeDisabled();
  });

  it("顯示目前最低與典型價格，隱藏原本的參考價提示", async () => {
    mockCommon();
    const bodies = mockCheck(PRICES);
    renderApp("/watches/new");
    await fillValid();
    expect(await screen.findByText(/這個行程還沒有價格資料/)).toBeInTheDocument();
    await press();
    expect(
      await screen.findByText("目前最低 NT$ 9,200｜典型價格 NT$ 8,200～NT$ 11,500"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/這個行程還沒有價格資料/)).not.toBeInTheDocument();
    expect(bodies).toEqual([
      {
        origin: "TPE",
        destination: "NRT",
        depart_date: DEPART,
        return_date: RETURN,
        cabin: "economy",
        adults: 1,
        airlines: [],
      },
    ]);
  });

  it("沒有區間時只顯示最低價，沒有快速選項", async () => {
    mockCommon();
    mockCheck({ ...PRICES, typical_low: null, typical_high: null });
    renderApp("/watches/new");
    await fillValid();
    await press();
    expect(await screen.findByText("目前最低 NT$ 9,200")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /典型低價/ })).not.toBeInTheDocument();
  });

  it("查不到航班但有區間", async () => {
    mockCommon();
    mockCheck({ ...PRICES, result: "no_result", lowest_price: null });
    renderApp("/watches/new");
    await fillValid();
    await press();
    expect(
      await screen.findByText("目前查不到航班｜典型價格 NT$ 8,200～NT$ 11,500"),
    ).toBeInTheDocument();
  });

  it.each(["no_result", "already_checked"])("%s 且沒有任何價格", async (result) => {
    mockCommon();
    mockCheck({ result, ...NO_PRICES });
    renderApp("/watches/new");
    await fillValid();
    await press();
    expect(await screen.findByText("這組條件目前查不到航班")).toBeInTheDocument();
  });

  it("點典型低價填入目標價", async () => {
    mockCommon();
    mockCheck(PRICES);
    renderApp("/watches/new");
    await fillValid();
    await press();
    await userEvent.click(await screen.findByRole("button", { name: "典型低價 NT$ 8,200" }));
    expect(screen.getByLabelText("目標價（TWD）")).toHaveValue("8200");
  });

  it("改條件後結果消失，按鈕可再按", async () => {
    mockCommon();
    mockCheck(PRICES);
    renderApp("/watches/new");
    await fillValid();
    await press();
    await screen.findByText(/目前最低/);
    await userEvent.selectOptions(screen.getByLabelText("目的地"), "KIX");
    expect(screen.queryByText(/目前最低/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: BUTTON })).toBeEnabled();
  });

  it("查價中改條件，回來的舊結果不顯示；連按只發一個請求", async () => {
    mockCommon();
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post(URL, async () => {
        calls += 1;
        await gate;
        return HttpResponse.json(PRICES);
      }),
    );
    renderApp("/watches/new");
    await fillValid();
    await press();
    const pending = await screen.findByRole("button", { name: "查價中…" });
    expect(pending).toBeDisabled();
    await userEvent.click(pending);
    await userEvent.selectOptions(screen.getByLabelText("目的地"), "KIX");
    release();
    await screen.findByRole("button", { name: BUTTON });
    expect(calls).toBe(1);
    expect(screen.queryByText(/目前最低/)).not.toBeInTheDocument();
  });

  it("user_limit 提示並停用按鈕，表單仍可送出", async () => {
    mockCommon();
    mockCheck({ result: "user_limit", ...NO_PRICES });
    const created = makeWatch();
    mockDetail(created);
    server.use(http.post("/api/v1/watches", () => HttpResponse.json(created, { status: 201 })));
    renderApp("/watches/new");
    await fillValid();
    await press();
    expect(
      await screen.findByText("今天的查價次數已用完，可以直接填目標價建立追蹤"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: BUTTON })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("目的地"), "KIX");
    expect(screen.getByRole("button", { name: BUTTON })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "建立追蹤" }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(`/watches/${created.public_id}`),
    );
  });

  it.each(["site_limit", "quota_exhausted"])("%s 的提示", async (result) => {
    mockCommon();
    mockCheck({ result, ...NO_PRICES });
    renderApp("/watches/new");
    await fillValid();
    await press();
    expect(await screen.findByText("目前無法查價，可以直接填目標價建立追蹤")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: BUTTON })).toBeEnabled();
  });

  it("failed 可以再試一次", async () => {
    mockCommon();
    mockCheck({ result: "failed", ...NO_PRICES });
    renderApp("/watches/new");
    await fillValid();
    await press();
    expect(await screen.findByText("查價暫時失敗，可以再試一次")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: BUTTON })).toBeEnabled();
  });

  it("請求失敗時顯示失敗提示", async () => {
    mockCommon();
    server.use(http.post(URL, () => HttpResponse.error()));
    renderApp("/watches/new");
    await fillValid();
    await press();
    expect(await screen.findByText("查價暫時失敗，可以再試一次")).toBeInTheDocument();
  });

  it("回 422 時顯示後端訊息", async () => {
    mockCommon();
    server.use(
      http.post(URL, () =>
        HttpResponse.json({ detail: "depart_date：出發日必須在範圍內" }, { status: 422 }),
      ),
    );
    renderApp("/watches/new");
    await fillValid();
    await press();
    expect(await screen.findByText(/出發日必須在範圍內/)).toBeInTheDocument();
    expect(screen.queryByText("查價暫時失敗，可以再試一次")).not.toBeInTheDocument();
  });

  it("修改追蹤的表單也能查價", async () => {
    mockCommon();
    mockCheck(PRICES);
    const watch = makeWatch({ depart_date: DEPART, return_date: RETURN });
    mockGetWatch(watch);
    renderApp(`/watches/${watch.public_id}/edit`);
    await screen.findByLabelText("目標價（TWD）");
    await press();
    expect(await screen.findByText(/目前最低/)).toBeInTheDocument();
  });
});
