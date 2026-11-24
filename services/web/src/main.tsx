import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/playfair-display/400.css";
import "@fontsource/playfair-display/500.css";
import "./styles/globals.css";
import { routes } from "./app/routes";
import { DataModeContext, dataModeFromEnv } from "./api/dataMode";
import { AuthProvider } from "./auth/AuthProvider";

const router = createBrowserRouter(routes);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <DataModeContext.Provider value={dataModeFromEnv(import.meta.env.VITE_API_MODE)}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </DataModeContext.Provider>
  </StrictMode>,
);
