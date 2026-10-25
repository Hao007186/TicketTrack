import { setupServer } from "msw/node";

// 每個測試用 server.use(...) 加上自己需要的回應；沒有處理到的請求直接讓測試失敗
export const server = setupServer();
