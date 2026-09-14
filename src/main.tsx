import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import { queryClient } from "./lib/queryClient";
import { initLogCapture } from "./lib/logCapture";
import { Layout } from "./components/Layout";
import { modules } from "./modules/registry";
import { STORAGE_KEYS } from "./lib/storageKeys";
import { resolveStartModule } from "./lib/startModule";
import { ScriptsRunnerProvider } from "./modules/scripts/runner";
import { InfoAlertsProvider } from "./modules/info/InfoAlertsProvider";
import { FightOverlayProvider } from "./modules/pvp/FightOverlayProvider";
import "./index.css";

// Sentry: DSN is baked in at build time via VITE_SENTRY_DSN; absent = disabled.
// Initialised before initLogCapture so Sentry's global handlers are chained first.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    release: __APP_VERSION__,
    environment: import.meta.env.MODE,
    sendDefaultPii: true,
  });
}

// Routes are generated from the module registry: "/" redirects to the
// last-visited module (persisted in localStorage), falling back to the first
// module. The module pages themselves are rendered by Layout's keep-alive host
// (see ModuleHost), so these child routes exist only for path matching — the
// active page is chosen from the URL and kept mounted across navigation.
initLogCapture();
let savedModule = modules[0].id;
try {
  savedModule = resolveStartModule(
    localStorage.getItem(STORAGE_KEYS.lastVisited),
    modules.map((m) => m.id),
    modules[0].id,
  );
} catch {
  // localStorage unavailable — fall back to the first module.
}
const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to={`/${savedModule}`} replace /> },
      // One catch-all segment; the active module (built-in or an active plugin
      // UI) is chosen from the URL by Layout's ModuleHost, not enumerated here.
      { path: ":moduleId" },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ScriptsRunnerProvider>
        <InfoAlertsProvider>
          <FightOverlayProvider>
            <RouterProvider router={router} />
          </FightOverlayProvider>
        </InfoAlertsProvider>
      </ScriptsRunnerProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
