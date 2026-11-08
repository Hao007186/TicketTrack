import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderApp } from "../test/render";

describe("首頁", () => {
  it("說明價格的更新時間", async () => {
    renderApp("/", { user: null });
    expect(await screen.findByText("價格每天早上 8 點更新")).toBeInTheDocument();
  });
});
