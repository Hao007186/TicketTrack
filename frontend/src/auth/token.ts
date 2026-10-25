// access token 只放在這個模組的變數裡（分頁的記憶體），不寫進 localStorage：
// 網頁被插入惡意程式碼時偷不走能長期使用的 token。重新整理後靠 refresh cookie 換一張新的。

const REFRESH_URL = "/api/v1/auth/refresh";
const LOCK_NAME = "farewatch-refresh";

let accessToken: string | null = null;
let inflight: Promise<string | null> | null = null;
const authLostHandlers = new Set<() => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/**
 * 用 refresh cookie 換新的 access token；登入已失效時回傳 null。
 *
 * 後端每次 refresh 都會換一張新的 refresh token，舊的那張再被使用就視為被偷、全部作廢。
 * 所以同一個分頁共用同一個請求，不同分頁用 Web Locks 排隊：前一個分頁換完後
 * 瀏覽器的 cookie 已經是新的，下一個分頁送出的就是新 token。
 */
export function refreshAccessToken(): Promise<string | null> {
  inflight ??= withRefreshLock(requestRefresh).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function withRefreshLock(fn: () => Promise<string | null>): Promise<string | null> {
  // 不支援 Web Locks 的瀏覽器只做同分頁共用
  if (!("locks" in navigator) || !navigator.locks) return fn();
  // DOM 型別把回傳值標成 Promise<Promise<…>>；await 會攤平成實際的結果
  return await navigator.locks.request(LOCK_NAME, fn);
}

async function requestRefresh(): Promise<string | null> {
  const res = await fetch(new URL(REFRESH_URL, window.location.origin), {
    method: "POST",
    credentials: "same-origin",
  });
  if (res.status === 401) {
    accessToken = null;
    return null;
  }
  if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
  const body = (await res.json()) as { access_token: string };
  accessToken = body.access_token;
  return accessToken;
}

/** 註冊「登入已失效」時要做的事；回傳取消註冊的函式。 */
export function onAuthLost(handler: () => void): () => void {
  authLostHandlers.add(handler);
  return () => {
    authLostHandlers.delete(handler);
  };
}

export function emitAuthLost(): void {
  for (const handler of authLostHandlers) handler();
}
