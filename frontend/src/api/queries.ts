import { useQuery } from "@tanstack/react-query";

import { api, unwrap } from "./client";
import type { components } from "./schema";

export type Watch = components["schemas"]["WatchOut"];
export type Baseline = components["schemas"]["BaselineOut"];
export type Airport = components["schemas"]["AirportOut"];
export type Airline = components["schemas"]["AirlineOut"];

// 寫入成功後用這些 key 讓相關資料重新抓取；前綴相同的 key 會一起失效
export const keys = {
  airports: ["airports"] as const,
  airlines: ["airlines"] as const,
  watches: ["watches"] as const,
  watch: (id: string) => ["watches", id] as const,
  baseline: (id: string) => ["watches", id, "baseline"] as const,
  prices: (id: string, range: string) => ["watches", id, "prices", range] as const,
  notifications: ["notifications"] as const,
  unread: ["notifications", "unread"] as const,
  settings: ["notification-settings"] as const,
};

export function useAirports() {
  return useQuery({
    queryKey: keys.airports,
    queryFn: async () => unwrap(await api.GET("/api/v1/airports")),
    staleTime: Infinity,
  });
}

export function useAirlines() {
  return useQuery({
    queryKey: keys.airlines,
    queryFn: async () => unwrap(await api.GET("/api/v1/airlines")),
    staleTime: Infinity,
  });
}

export function useWatches() {
  return useQuery({
    queryKey: keys.watches,
    queryFn: async () => unwrap(await api.GET("/api/v1/watches")),
  });
}

export function useBaseline(id: string) {
  return useQuery({
    queryKey: keys.baseline(id),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/watches/{public_id}/baseline", {
          params: { path: { public_id: id } },
        }),
      ),
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: keys.unread,
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/notifications", { params: { query: { limit: 1 } } }))
        .unread_count,
    refetchInterval: 60_000,
  });
}
