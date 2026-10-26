// 新增／編輯追蹤表單的狀態、驗證與轉成 API body；不碰 React，方便單獨測試
import type { components } from "../api/schema";
import type { Watch } from "../api/queries";
import { addDays, type Cabin } from "./format";

type WatchCreate = components["schemas"]["WatchCreate"];
type WatchUpdate = components["schemas"]["WatchUpdate"];

// 和後端 watches/service.py 的 MIN_DAYS_AHEAD、MAX_DAYS_AHEAD 相同
export const MIN_DAYS_AHEAD = 3;
export const MAX_DAYS_AHEAD = 330;
const MAX_TARGET_PRICE = 1_000_000;

export type WatchFormValues = {
  origin: string;
  destination: string;
  tripType: "one_way" | "round_trip";
  departDate: string;
  returnDate: string;
  cabin: Cabin;
  adults: number;
  targetPrice: string;
  airlines: string[];
};

export type FormErrors = Partial<Record<keyof WatchFormValues, string>>;

export function emptyForm(): WatchFormValues {
  return {
    origin: "TPE",
    destination: "",
    tripType: "round_trip",
    departDate: "",
    returnDate: "",
    cabin: "economy",
    adults: 1,
    targetPrice: "",
    airlines: [],
  };
}

export function fromWatch(w: Watch): WatchFormValues {
  return {
    origin: w.origin,
    destination: w.destination,
    tripType: w.return_date ? "round_trip" : "one_way",
    departDate: w.depart_date,
    returnDate: w.return_date ?? "",
    cabin: w.cabin as Cabin,
    adults: w.adults,
    targetPrice: String(w.target_price),
    airlines: [...w.airlines],
  };
}

export function dateRange(today: string): { earliest: string; latest: string } {
  return { earliest: addDays(today, MIN_DAYS_AHEAD), latest: addDays(today, MAX_DAYS_AHEAD) };
}

function parseTargetPrice(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_TARGET_PRICE ? n : null;
}

/**
 * today 是台灣時間的 YYYY-MM-DD；日期字串格式固定，直接比字串就是比日期。
 * 編輯時（有 original）日期沒改就不檢查範圍：快出發的追蹤仍要能改目標價，後端也只在條件有變時才檢查。
 */
export function validate(v: WatchFormValues, today: string, original?: Watch): FormErrors {
  const errors: FormErrors = {};
  const { earliest, latest } = dateRange(today);
  const departUnchanged = original !== undefined && v.departDate === original.depart_date;
  const returnUnchanged = original !== undefined && v.returnDate === (original.return_date ?? "");

  if (!v.destination) errors.destination = "請選擇目的地";
  else if (v.destination === v.origin) errors.destination = "目的地不能和出發地相同";

  if (!v.departDate || (!departUnchanged && (v.departDate < earliest || v.departDate > latest))) {
    errors.departDate = `出發日必須在 ${earliest} 到 ${latest} 之間`;
  }

  if (v.tripType === "round_trip") {
    if (!v.returnDate) errors.returnDate = "請選擇回程日";
    else if (v.departDate && v.returnDate < v.departDate)
      errors.returnDate = "回程日不能早於出發日";
    else if (!returnUnchanged && v.returnDate > latest)
      errors.returnDate = `回程日不能晚於 ${latest}`;
  }

  if (parseTargetPrice(v.targetPrice) === null) {
    errors.targetPrice = "目標價必須是 1 到 1,000,000 的整數";
  }
  return errors;
}

/** 呼叫前要先通過 validate。 */
export function toCreateBody(v: WatchFormValues): WatchCreate {
  return {
    origin: v.origin,
    destination: v.destination,
    depart_date: v.departDate,
    return_date: v.tripType === "round_trip" ? v.returnDate : null,
    cabin: v.cabin,
    adults: v.adults,
    airlines: v.airlines,
    target_price: parseTargetPrice(v.targetPrice)!,
  };
}

export type ReferenceConditions = {
  origin: string;
  destination: string;
  depart_date: string;
  return_date?: string;
  cabin: Cabin;
  adults: number;
  airlines: string[];
};

/** 查參考價用的條件；條件不完整（後端會回 422 或一定查不到）時回 null。目標價不需要填。 */
export function referenceConditions(v: WatchFormValues): ReferenceConditions | null {
  if (!v.destination || v.destination === v.origin || !v.departDate) return null;
  const cond: ReferenceConditions = {
    origin: v.origin,
    destination: v.destination,
    depart_date: v.departDate,
    cabin: v.cabin,
    adults: v.adults,
    airlines: v.airlines,
  };
  if (v.tripType === "round_trip") {
    if (!v.returnDate || v.returnDate < v.departDate) return null;
    cond.return_date = v.returnDate;
  }
  return cond;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/** 只放有改的欄位；改成單程時明確送 return_date: null（沒送代表不改）。 */
export function toUpdateBody(v: WatchFormValues, original: Watch): WatchUpdate {
  const next = toCreateBody(v);
  const body: WatchUpdate = {};
  if (next.origin !== original.origin) body.origin = next.origin;
  if (next.destination !== original.destination) body.destination = next.destination;
  if (next.depart_date !== original.depart_date) body.depart_date = next.depart_date;
  if ((next.return_date ?? null) !== original.return_date) body.return_date = next.return_date;
  if (next.cabin !== original.cabin) body.cabin = next.cabin;
  if (next.adults !== original.adults) body.adults = next.adults;
  if (!sameSet(next.airlines, original.airlines)) body.airlines = next.airlines;
  if (next.target_price !== original.target_price) body.target_price = next.target_price;
  return body;
}

const RESET_FIELDS: (keyof WatchUpdate)[] = [
  "origin",
  "destination",
  "depart_date",
  "return_date",
  "cabin",
  "adults",
  "airlines",
  "target_price",
];

/** 改了查價條件或目標價時，後端會重置通知狀態。 */
export function resetsAlertState(body: WatchUpdate): boolean {
  return RESET_FIELDS.some((field) => field in body);
}
