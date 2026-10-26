import { describe, expect, it } from "vitest";

import {
  addDays,
  formatDate,
  formatDateTime,
  formatMonthDay,
  formatPrice,
  todayInTaipei,
} from "./format";

describe("format", () => {
  it("金額加上 NT$ 和千分位", () => {
    expect(formatPrice(10372)).toBe("NT$ 10,372");
    expect(formatPrice(0)).toBe("NT$ 0");
  });

  it("時間顯示成台灣時間", () => {
    expect(formatDateTime("2026-10-25T00:00:00Z")).toBe("10/25 08:00");
  });

  it("月日顯示成台灣時間、不補零", () => {
    expect(formatMonthDay("2026-10-19T16:30:00Z")).toBe("10/20");
    expect(formatMonthDay("2026-03-05T01:00:00Z")).toBe("3/5");
  });

  it("日期不做時區換算", () => {
    expect(formatDate("2026-12-19")).toBe("2026/12/19");
  });

  it("今天以台灣時間為準", () => {
    // UTC 17 點已經是台灣隔天凌晨 1 點
    expect(todayInTaipei(new Date("2026-10-25T17:00:00Z"))).toBe("2026-10-26");
  });

  it("加天數會跨月跨年", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
  });
});
