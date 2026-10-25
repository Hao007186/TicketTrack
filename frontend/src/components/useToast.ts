import { createContext, useContext } from "react";

export type ToastApi = { show(message: string): void };

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const toast = useContext(ToastContext);
  if (toast === null) throw new Error("useToast 必須在 ToastProvider 裡使用");
  return toast;
}
