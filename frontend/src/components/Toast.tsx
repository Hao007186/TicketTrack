import { useCallback, useMemo, useState, type ReactNode } from "react";

import { ToastContext } from "./useToast";

const DURATION_MS = 4000;

type Message = { id: number; text: string };

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<Message[]>([]);

  const show = useCallback((text: string) => {
    const id = nextId++;
    setMessages((list) => [...list, { id, text }]);
    setTimeout(() => {
      setMessages((list) => list.filter((m) => m.id !== id));
    }, DURATION_MS);
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2" role="status">
        {messages.map((m) => (
          <div
            key={m.id}
            className="rounded-lg bg-slate-900 px-4 py-3 text-sm text-white shadow-lg"
          >
            {m.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
