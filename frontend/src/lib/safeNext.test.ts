import { describe, expect, it } from "vitest";

import { safeNext } from "./safeNext";

describe("safeNext", () => {
  it("站內路徑照用", () => {
    expect(safeNext("/watches/1")).toBe("/watches/1");
    expect(safeNext("/notifications?x=1")).toBe("/notifications?x=1");
  });

  it("站外網址或沒有值時回我的追蹤", () => {
    for (const next of ["//evil.com", "https://evil.com", "/\\evil.com", "watches", "", null]) {
      expect(safeNext(next)).toBe("/watches");
    }
  });
});
