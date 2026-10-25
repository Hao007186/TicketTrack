import { describe, expect, it } from "vitest";

import { ApiError, errorMessage, toApiError } from "./errors";

describe("toApiError", () => {
  it("detail 是字串時直接顯示", () => {
    const e = toApiError(409, { detail: "每人最多 3 個追蹤" });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(e.message).toBe("每人最多 3 個追蹤");
  });

  it("422 的 detail 陣列取每項的 msg", () => {
    expect(toApiError(422, { detail: [{ msg: "A" }, { msg: "B" }] }).message).toBe("A；B");
  });

  it("5xx 一律顯示連線失敗，不露出後端的內部訊息", () => {
    expect(toApiError(500, { detail: "boom" }).message).toBe("連線失敗，請稍後再試");
    expect(toApiError(503, { detail: "示範帳號尚未建立" }).status).toBe(503);
  });

  it("沒有 detail 時依 status 給預設訊息", () => {
    expect(toApiError(403, undefined).message).toBe("示範帳號無法修改");
    expect(toApiError(404, {}).message).toBe("找不到資料");
    expect(toApiError(500, "Internal Server Error").message).toBe("連線失敗，請稍後再試");
  });
});

describe("errorMessage", () => {
  it("ApiError 用它的訊息，其他錯誤視為連線失敗", () => {
    expect(errorMessage(toApiError(409, { detail: "x" }))).toBe("x");
    expect(errorMessage(new TypeError("Failed to fetch"))).toBe("連線失敗，請稍後再試");
  });
});
