import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { alice, demo } from "../test/fixtures";
import { mockCommon, mockWatches } from "../test/data";
import { renderApp } from "../test/render";

describe("WriteButton", () => {
  it("示範帳號時不能按並說明原因", async () => {
    mockCommon();
    renderApp("/watches/new", { user: demo });
    const button = await screen.findByRole("button", { name: "建立追蹤" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("示範帳號無法修改");
  });

  it("一般帳號時可以按", async () => {
    mockCommon();
    mockWatches([]);
    renderApp("/watches", { user: alice });
    const button = await screen.findByRole("button", { name: "新增追蹤" });
    // 列表載入完、確定名額之前按鈕是停用的
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(screen.getByTestId("location")).toHaveTextContent("/watches/new");
  });
});
