// Global styles first, so component styles (imported by the components) override the primitives.
import "./styles/tokens.css";
import "./styles/base.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";

const container = document.getElementById("root");
if (container === null) throw new Error("#root element missing from index.html");

// Test builds only (`electron-vite build --mode test`): the e2e suite mounts the 3D viewer on a synthetic scene.
if (import.meta.env.MODE === "test")
  (
    window as unknown as { __slabyrinthMountView3d: (side?: number) => Promise<void> }
  ).__slabyrinthMountView3d = (side) =>
    import("./features/view3d/harness").then((m) => m.mountView3dHarness(side));

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
