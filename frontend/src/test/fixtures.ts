import type { Me } from "../auth/context";

export const alice: Me = {
  public_id: "00000000-0000-0000-0000-00000000a11c",
  email: "alice@example.com",
  display_name: "Alice",
  role: "user",
  is_demo: false,
};

export const demo: Me = {
  public_id: "00000000-0000-0000-0000-0000000000de",
  email: "demo@farewatch.example",
  display_name: "示範帳號",
  role: "user",
  is_demo: true,
};
