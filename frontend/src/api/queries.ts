import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ReferenceConditions } from "../lib/watchForm";
import { api, unwrap } from "./client";
import type { components } from "./schema";

export type Watch = components["schemas"]["WatchOut"];
export type Baseline = components["schemas"]["BaselineOut"];
export type Airport = components["schemas"]["AirportOut"];
export type Airline = components["schemas"]["AirlineOut"];
export type WatchCreate = components["schemas"]["WatchCreate"];
export type WatchUpdate = components["schemas"]["WatchUpdate"];
export type PricePoint = components["schemas"]["PricePoint"];
export type PriceRange = "30d" | "90d" | "all";
export type Notification = components["schemas"]["NotificationOut"];
export type PriceReference = components["schemas"]["PriceReferenceOut"];

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

export function useDeleteWatch(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      unwrap(
        await api.DELETE("/api/v1/watches/{public_id}", { params: { path: { public_id: id } } }),
      ),
    onSuccess: () => {
      // 只重抓列表；詳情直接移除，否則開著的詳情頁會先重抓到 404
      queryClient.removeQueries({ queryKey: keys.watch(id) });
      return queryClient.invalidateQueries({ queryKey: keys.watches, exact: true });
    },
  });
}

export function useSetPaused(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (paused: boolean) =>
      unwrap(
        await api.PATCH("/api/v1/watches/{public_id}", {
          params: { path: { public_id: id } },
          body: { status: paused ? "paused" : "active" },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.watches }),
  });
}

export function usePrices(id: string, range: PriceRange) {
  return useQuery({
    queryKey: keys.prices(id, range),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/watches/{public_id}/prices", {
          params: { path: { public_id: id }, query: { range } },
        }),
      ),
  });
}

export function useWatchNotifications(id: string) {
  return useQuery({
    queryKey: [...keys.notifications, "watch", id],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/notifications", { params: { query: { watch_id: id, limit: 5 } } }),
      ).items,
  });
}

export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(
        await api.PATCH("/api/v1/notifications/{public_id}/read", {
          params: { path: { public_id: id } },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.notifications }),
  });
}

const NOTIFICATION_PAGE_SIZE = 20;

export function useNotificationPages() {
  return useInfiniteQuery({
    queryKey: [...keys.notifications, "list"],
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET("/api/v1/notifications", {
          params: { query: { limit: NOTIFICATION_PAGE_SIZE, before: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    // 剛好滿一頁才可能還有下一頁；用最後一則的 id 當 before
    getNextPageParam: (last) =>
      last.items.length === NOTIFICATION_PAGE_SIZE ? last.items.at(-1)?.id : undefined,
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => unwrap(await api.POST("/api/v1/notifications/read-all")),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.notifications }),
  });
}

export function useNotificationSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: async () => unwrap(await api.GET("/api/v1/me/notification-settings")),
  });
}

export function useUpdateNotificationSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (emailEnabled: boolean) =>
      unwrap(
        await api.PATCH("/api/v1/me/notification-settings", {
          body: { email_enabled: emailEnabled },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.settings }),
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

export function usePriceReference(cond: ReferenceConditions | null) {
  return useQuery({
    queryKey: ["price-reference", cond],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/price-reference", { params: { query: cond! } })),
    enabled: cond !== null,
    staleTime: 5 * 60_000,
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
