import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "@/styles.css";
import { initTheme } from "@/lib/theme";
import "../shared/edit-context-menu.browser.js";

// A tray or recovery window does not need to parse and initialize the manager.
const App = lazy(() => import("./App.js").then(module => ({ default: module.App })));
const TrayMenu = lazy(() => import("./features/shell/TrayMenu.js").then(module => ({ default: module.TrayMenu })));
const StartupRecovery = lazy(() => import("./features/shell/StartupRecovery.js").then(module => ({ default: module.StartupRecovery })));

initTheme();

const container = document.getElementById("root");
if (!container) throw new Error("root container missing");
createRoot(container).render(
  <StrictMode>
    <Suspense fallback={<span className="sr-only">加载中…</span>}>
      {document.documentElement.dataset.surface === 'tray' ? <TrayMenu /> : document.documentElement.dataset.surface === 'recovery' ? <StartupRecovery /> : <App />}
    </Suspense>
  </StrictMode>,
);
