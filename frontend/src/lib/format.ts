import type { components } from "../api/schema";

export type WatchStatus = components["schemas"]["WatchOut"]["status"];
export type Cabin = components["schemas"]["WatchCreate"]["cabin"] & string;

const TZ = "Asia/Taipei";
const priceFormat = new Intl.NumberFormat("zh-TW");
const dateTimeFormat = new Intl.DateTimeFormat("zh-TW", {
  timeZone: TZ,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
// en-CA 的日期格式剛好是 YYYY-MM-DD
const isoDateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });

export function formatPrice(n: number): string {
  return `NT$ ${priceFormat.format(n)}`;
}

export function formatDateTime(iso: string): string {
  const parts = Object.fromEntries(
    dateTimeFormat.formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

/** 時間點的台灣日期，M/D 不補零 */
export function formatMonthDay(iso: string): string {
  const [, month, day] = todayInTaipei(new Date(iso)).split("-");
  return `${Number(month)}/${Number(day)}`;
}

export function formatDate(isoDate: string): string {
  return isoDate.replaceAll("-", "/");
}

export function todayInTaipei(now: Date = new Date()): string {
  return isoDateFormat.format(now);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const CABIN_LABELS: Record<Cabin, string> = {
  economy: "經濟艙",
  premium_economy: "豪華經濟艙",
  business: "商務艙",
  first: "頭等艙",
};

export const STATUS_LABELS: Record<WatchStatus, string> = {
  active: "查價中",
  queued: "排隊中",
  paused: "已暫停",
  expired: "已過期",
};
