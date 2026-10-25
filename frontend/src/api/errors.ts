const NETWORK_ERROR = "連線失敗，請稍後再試";

const DEFAULT_MESSAGES: Record<number, string> = {
  403: "示範帳號無法修改",
  404: "找不到資料",
};

/** 後端回傳的錯誤；message 就是要顯示給使用者的中文。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function detailMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("detail" in body)) return null;
  const { detail } = body;
  if (typeof detail === "string") return detail;
  // FastAPI 的 422：[{ loc, msg, type }, ...]
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item: unknown) =>
        typeof item === "object" && item !== null && "msg" in item ? String(item.msg) : null,
      )
      .filter((m): m is string => m !== null);
    return messages.length > 0 ? messages.join("；") : null;
  }
  return null;
}

export function toApiError(status: number, body: unknown): ApiError {
  return new ApiError(status, detailMessage(body) ?? DEFAULT_MESSAGES[status] ?? NETWORK_ERROR);
}

export function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : NETWORK_ERROR;
}
