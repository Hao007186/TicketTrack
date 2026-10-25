import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";

import { server } from "./server";

// MSW 3 遇到沒有處理到的請求只會印錯誤；收集起來，在測試結束時讓它失敗，才不會漏掉少假造的 API
const unhandled: string[] = [];

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
  server.events.on("request:unhandled", ({ request }) => {
    unhandled.push(`${request.method} ${new URL(request.url).pathname}`);
  });
});

afterEach(async () => {
  cleanup();
  // 等卸載前已經送出的請求跑完，再換掉 handler；否則會算到下一個測試頭上
  await new Promise((resolve) => setTimeout(resolve, 20));
  server.resetHandlers();
  const found = unhandled.splice(0);
  if (found.length > 0) throw new Error(`沒有假造的 API 請求：${[...new Set(found)].join("、")}`);
});

afterAll(() => {
  server.close();
});

// jsdom 沒有 ResizeObserver，也量不到尺寸；Recharts 的 ResponsiveContainer 靠它決定圖表大小，
// 這裡一開始觀察就回報固定的 800×320，讓圖表在測試裡畫得出來
class FakeResizeObserver {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    const entry = { target, contentRect: { width: 800, height: 320 } } as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= FakeResizeObserver as unknown as typeof ResizeObserver;
