import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  // StrictMode double-mounts effects in dev — deliberate here: it proves the
  // player tears its socket and decoders down and comes back cleanly.
  <StrictMode>
    <App />
  </StrictMode>,
);
