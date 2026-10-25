import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { ApiError, errorMessage } from "./api/errors";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { useToast } from "./components/useToast";

declare module "@tanstack/react-query" {
  interface Register {
    // silent：錯誤由畫面自己顯示（例如表單），不跳全域提示
    mutationMeta: { silent?: boolean };
  }
}

function shouldRetry(failureCount: number, error: unknown): boolean {
  // 4xx 重試也不會變好；只有連線問題和 5xx 才重試
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 2;
}

function QueryLayer({ children, retry }: { children: ReactNode; retry: boolean }) {
  const toast = useToast();
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: retry ? shouldRetry : false } },
        mutationCache: new MutationCache({
          onError: (error, _variables, _result, mutation) => {
            if (!mutation.meta?.silent) toast.show(errorMessage(error));
          },
        }),
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function AppProviders({ children, retry = true }: { children: ReactNode; retry?: boolean }) {
  return (
    <ToastProvider>
      <QueryLayer retry={retry}>
        <AuthProvider>{children}</AuthProvider>
      </QueryLayer>
    </ToastProvider>
  );
}
