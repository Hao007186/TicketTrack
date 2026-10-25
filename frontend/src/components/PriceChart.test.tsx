import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PriceChart } from "./PriceChart";

const points = [
  { observed_at: "2026-10-20T00:00:00Z", price: 10200, airline_iata: "BR" },
  { observed_at: "2026-10-21T00:00:00Z", price: 9800, airline_iata: "CI" },
  { observed_at: "2026-10-22T00:00:00Z", price: 9100, airline_iata: null },
];

describe("PriceChart", () => {
  it("有資料時畫出圖表", () => {
    const { container } = render(
      <PriceChart points={points} targetPrice={9500} typicalLow={6400} typicalHigh={12500} />,
    );
    expect(container.querySelector(".recharts-wrapper")).not.toBeNull();
    expect(screen.queryByText(/每天查價一次/)).not.toBeInTheDocument();
  });

  it("沒有資料時顯示提示", () => {
    const { container } = render(
      <PriceChart points={[]} targetPrice={9500} typicalLow={null} typicalHigh={null} />,
    );
    expect(container.querySelector(".recharts-wrapper")).toBeNull();
    expect(screen.getByText("每天查價一次，第一筆價格出來後就會顯示")).toBeInTheDocument();
  });
});
