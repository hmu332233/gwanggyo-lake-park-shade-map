import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ShadeMapApp from "./components/ShadeMapApp";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ShadeMapApp />
  </StrictMode>,
);
