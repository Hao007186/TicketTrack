const FALLBACK = "/watches";

/** 登入後要回去的網址。只接受站內路徑，避免 ?next= 被拿來把人導到別的網站。 */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/")) return FALLBACK;
  // "//evil.com" 和 "/\evil.com" 都會被瀏覽器當成別的網域
  if (next[1] === "/" || next[1] === "\\") return FALLBACK;
  return next;
}
