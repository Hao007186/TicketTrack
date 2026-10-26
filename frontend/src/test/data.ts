import { http, HttpResponse } from "msw";

import type { components } from "../api/schema";
import { server } from "./server";

type Watch = components["schemas"]["WatchOut"];
type Baseline = components["schemas"]["BaselineOut"];

let seq = 0;

export function makeWatch(overrides: Partial<Watch> = {}): Watch {
  seq += 1;
  return {
    public_id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    origin: "TPE",
    destination: "NRT",
    depart_date: "2026-12-19",
    return_date: "2026-12-24",
    trip_type: "round_trip",
    cabin: "economy",
    adults: 1,
    airlines: [],
    target_price: 9500,
    status: "active",
    created_at: "2026-10-20T02:00:00Z",
    updated_at: "2026-10-20T02:00:00Z",
    ...overrides,
  };
}

export const emptyBaseline: Baseline = {
  latest_price: null,
  latest_observed_at: null,
  latest_booking_url: null,
  last_checked_at: null,
  typical_low: null,
  typical_high: null,
  record_low: null,
  history_ready: false,
};

export const airports: components["schemas"]["AirportOut"][] = [
  { iata: "TPE", name_zh: "台北桃園", city_zh: "台北", country: "TW", is_origin: true },
  { iata: "KHH", name_zh: "高雄", city_zh: "高雄", country: "TW", is_origin: true },
  { iata: "NRT", name_zh: "東京成田", city_zh: "東京", country: "JP", is_origin: false },
  { iata: "KIX", name_zh: "大阪關西", city_zh: "大阪", country: "JP", is_origin: false },
  { iata: "ICN", name_zh: "首爾仁川", city_zh: "首爾", country: "KR", is_origin: false },
];

export const airlines: components["schemas"]["AirlineOut"][] = [
  { iata: "BR", name_zh: "長榮航空" },
  { iata: "CI", name_zh: "中華航空" },
  { iata: "JX", name_zh: "星宇航空" },
];

/** 共用的參考資料、通知未讀數；各測試再用 server.use 加上自己需要的 */
export function mockCommon({ unread = 0 }: { unread?: number } = {}) {
  server.use(
    http.get("/api/v1/airports", () => HttpResponse.json(airports)),
    http.get("/api/v1/airlines", () => HttpResponse.json(airlines)),
    http.get("/api/v1/notifications", () => HttpResponse.json({ items: [], unread_count: unread })),
    http.get("/api/v1/price-reference", () =>
      HttpResponse.json({ typical_low: null, typical_high: null, updated_at: null }),
    ),
  );
}

/** 詳情頁需要的 API（追蹤、baseline、價格）；回傳記錄 prices 請求 range 的陣列 */
export function mockDetail(watch: Watch, baseline: Partial<Baseline> = {}) {
  const ranges: string[] = [];
  server.use(
    http.get(`/api/v1/watches/${watch.public_id}`, () => HttpResponse.json(watch)),
    http.get(`/api/v1/watches/${watch.public_id}/baseline`, () =>
      HttpResponse.json({ ...emptyBaseline, ...baseline }),
    ),
    http.get(`/api/v1/watches/${watch.public_id}/prices`, ({ request }) => {
      ranges.push(new URL(request.url).searchParams.get("range") ?? "");
      return HttpResponse.json([
        { observed_at: "2026-10-22T00:00:00Z", price: 9100, airline_iata: "BR" },
      ]);
    }),
  );
  return ranges;
}

export function mockWatches(watches: Watch[], baselines: Record<string, Partial<Baseline>> = {}) {
  server.use(
    http.get("/api/v1/watches", () => HttpResponse.json(watches)),
    http.get("/api/v1/watches/:id/baseline", ({ params }) =>
      HttpResponse.json({ ...emptyBaseline, ...baselines[params.id as string] }),
    ),
  );
}
