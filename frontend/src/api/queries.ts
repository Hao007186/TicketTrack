import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, unwrap } from "./client";
import type { components } from "./schema";

export type Watch = components["schemas"]["WatchOut"];
export type Baseline = components["schemas"]["BaselineOut"];
export type Airport = components["schemas"]["AirportOut"];
export type Airline = components["schemas"]["AirlineOut"];
export type WatchCreate = components["schemas"]["WatchCreate"];
export type WatchUpdate = components["schemas"]["WatchUpdate"];

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

export function useWatch(id: string) {
  return useQuery({
    queryKey: keys.watch(id),
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/watches/{public_id}", { params: { path: { public_id: id } } })),
  });
}

// 表單自己顯示錯誤，所以設 silent，不跳全域提示
export function useCreateWatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: WatchCreate) => unwrap(await api.POST("/api/v1/watches", { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.watches }),
    meta: { silent: true },
  });
}

export function useUpdateWatch(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: WatchUpdate) =>
      unwrap(
        await api.PATCH("/api/v1/watches/{public_id}", {
          params: { path: { public_id: id } },
          body,
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.watches }),
    meta: { silent: true },
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
