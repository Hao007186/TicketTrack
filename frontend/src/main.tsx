import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <h1 className="p-6 text-2xl font-bold">FareWatch</h1>
  </StrictMode>,
);
