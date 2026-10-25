import { createContext, useContext } from "react";

import type { components } from "../api/schema";

export type Me = components["schemas"]["UserOut"];

export type Auth = {
  user: Me | null;
  isDemo: boolean;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string, displayName?: string): Promise<void>;
  loginDemo(): Promise<void>;
  logout(): Promise<void>;
};

export const AuthContext = createContext<Auth | null>(null);

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (auth === null) throw new Error("useAuth 必須在 AuthProvider 裡使用");
  return auth;
}
