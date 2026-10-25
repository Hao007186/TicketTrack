import createClient from "openapi-fetch";

import { emitAuthLost, getAccessToken, refreshAccessToken } from "../auth/token";
import { toApiError } from "./errors";
import type { paths } from "./schema";

const AUTH_PREFIX = "/api/v1/auth/";

function withToken(request: Request, token: string | null): Request {
  if (token !== null) request.headers.set("Authorization", `Bearer ${token}`);
  return request;
}

/** 所有 API 請求都經過這裡：帶上 token，過期（401）時 refresh 一次再重送。 */
export async function authFetch(request: Request): Promise<Response> {
  // body 只能讀一次，重送要用送出前先複製的那份
  const retry = request.clone();
  const sentWith = getAccessToken();
  const res = await fetch(withToken(request, sentWith));
  if (res.status !== 401 || new URL(request.url).pathname.startsWith(AUTH_PREFIX)) return res;

  // 等回應的期間別的請求可能已經換好新 token，直接用就好，不必再 refresh
  const current = getAccessToken();
  const token = current !== null && current !== sentWith ? current : await refreshAccessToken();
  if (token === null) {
    emitAuthLost();
    return res;
  }
  return fetch(withToken(retry, token));
}

export const api = createClient<paths>({ baseUrl: window.location.origin, fetch: authFetch });

/** 把 openapi-fetch 的結果轉成資料；失敗時丟出 ApiError。 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    throw toApiError(result.response.status, result.error);
  }
  return result.data as T;
}
