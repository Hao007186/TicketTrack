import { describe, expect, it } from "vitest";

import { validateNewPassword } from "./password";

describe("validateNewPassword", () => {
  it("少於 8 字", () => {
    expect(validateNewPassword("short", "short")).toBe("密碼至少 8 個字");
  });
  it("兩次不同", () => {
    expect(validateNewPassword("new-password-1", "new-password-2")).toBe("兩次輸入的密碼不一樣");
  });
  it("通過", () => {
    expect(validateNewPassword("new-password-1", "new-password-1")).toBeNull();
  });
});
