import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import { queryClient } from "./lib/queryClient";
import { Layout } from "./components/Layout";
import { modules } from "./modules/registry";
import "./index.css";

// Routes are generated from the module registry: "/" redirects to the first
// module, and each module mounts at "/{id}".
const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to={`/${modules[0].id}`} replace /> },
      ...modules.map((m) => ({ path: m.id, element: <m.Component /> })),
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
