import { describe, expect, it } from "vitest";

import { makeWatch } from "../test/data";
import {
  emptyForm,
  fromWatch,
  resetsAlertState,
  toCreateBody,
  toUpdateBody,
  validate,
  type WatchFormValues,
} from "./watchForm";

const TODAY = "2026-10-25";

function valid(overrides: Partial<WatchFormValues> = {}): WatchFormValues {
  return {
    ...emptyForm(),
    destination: "NRT",
    departDate: "2026-12-19",
    returnDate: "2026-12-24",
    targetPrice: "9500",
    ...overrides,
  };
}

describe("validate", () => {
  it("合法的表單沒有錯誤", () => {
    expect(validate(valid(), TODAY)).toEqual({});
  });

  it("目的地不能空白或等於出發地", () => {
    expect(validate(valid({ destination: "" }), TODAY).destination).toBe("請選擇目的地");
    expect(validate(valid({ destination: "TPE" }), TODAY).destination).toBe(
      "目的地不能和出發地相同",
    );
  });

  it("出發日要在 3～330 天內", () => {
    const message = "出發日必須在 2026-10-28 到 2027-09-20 之間";
    expect(validate(valid({ departDate: "2026-10-27" }), TODAY).departDate).toBe(message);
    expect(
      validate(valid({ departDate: "2027-09-21", returnDate: "", tripType: "one_way" }), TODAY)
        .departDate,
    ).toBe(message);
    expect(validate(valid({ departDate: "2026-10-28" }), TODAY).departDate).toBeUndefined();
    expect(
      validate(valid({ departDate: "2027-09-20", tripType: "one_way" }), TODAY).departDate,
    ).toBeUndefined();
  });

  it("來回時檢查回程日", () => {
    expect(validate(valid({ returnDate: "" }), TODAY).returnDate).toBe("請選擇回程日");
    expect(validate(valid({ returnDate: "2026-12-18" }), TODAY).returnDate).toBe(
      "回程日不能早於出發日",
    );
    expect(validate(valid({ returnDate: "2027-09-21" }), TODAY).returnDate).toBe(
      "回程日不能晚於 2027-09-20",
    );
    // 單程時不管回程日
    expect(validate(valid({ tripType: "one_way", returnDate: "" }), TODAY)).toEqual({});
  });

  it("目標價要是 1 到 1,000,000 的整數", () => {
    for (const targetPrice of ["0", "9.5", "", "abc", "1000001"]) {
      expect(validate(valid({ targetPrice }), TODAY).targetPrice).toBe(
        "目標價必須是 1 到 1,000,000 的整數",
      );
    }
  });
});

describe("toCreateBody", () => {
  it("單程時不送回程日，目標價轉成數字", () => {
    const body = toCreateBody(valid({ tripType: "one_way", airlines: ["CI", "BR"] }));
    expect(body).toEqual({
      origin: "TPE",
      destination: "NRT",
      depart_date: "2026-12-19",
      return_date: null,
      cabin: "economy",
      adults: 1,
      airlines: ["CI", "BR"],
      target_price: 9500,
    });
  });
});

describe("toUpdateBody", () => {
  const original = makeWatch({
    destination: "NRT",
    depart_date: "2026-12-19",
    return_date: "2026-12-24",
    airlines: ["BR", "CI"],
    target_price: 9500,
  });

  it("只改目標價時只送目標價", () => {
    expect(toUpdateBody({ ...fromWatch(original), targetPrice: "8000" }, original)).toEqual({
      target_price: 8000,
    });
  });

  it("來回改單程時送出 return_date: null", () => {
    expect(toUpdateBody({ ...fromWatch(original), tripType: "one_way" }, original)).toEqual({
      return_date: null,
    });
  });

  it("沒有改就是空的", () => {
    expect(toUpdateBody(fromWatch(original), original)).toEqual({});
  });

  it("航空公司只是順序不同不算改", () => {
    expect(toUpdateBody({ ...fromWatch(original), airlines: ["CI", "BR"] }, original)).toEqual({});
  });
});

describe("resetsAlertState", () => {
  it("只有改查價條件或目標價才會重置", () => {
    expect(resetsAlertState({ status: "paused" })).toBe(false);
    expect(resetsAlertState({})).toBe(false);
    expect(resetsAlertState({ target_price: 1 })).toBe(true);
    expect(resetsAlertState({ return_date: null })).toBe(true);
  });
});
