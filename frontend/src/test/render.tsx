import { render } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter, useLocation } from "react-router";

import { AppProviders } from "../AppProviders";
import type { Me } from "../auth/context";
import { setAccessToken } from "../auth/token";
import { AppRoutes } from "../routes";
import { alice } from "./fixtures";
import { server } from "./server";

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{pathname + search}</div>;
}

/** 從指定網址渲染整個 App；user 為 null 代表沒登入（refresh 回 401）。 */
export function renderApp(path: string, { user = alice }: { user?: Me | null } = {}) {
  setAccessToken(null);
  server.use(
    http.post("/api/v1/auth/refresh", () =>
      user
        ? HttpResponse.json({ access_token: "test-token", token_type: "bearer" })
        : HttpResponse.json({ detail: "請重新登入" }, { status: 401 }),
    ),
    http.get("/api/v1/me", () =>
      user ? HttpResponse.json(user) : HttpResponse.json({ detail: "請重新登入" }, { status: 401 }),
    ),
  );
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders retry={false}>
        <AppRoutes />
        <LocationProbe />
      </AppProviders>
    </MemoryRouter>,
  );
}
