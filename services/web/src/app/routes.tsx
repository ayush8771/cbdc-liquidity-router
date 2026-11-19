import type { RouteObject } from "react-router-dom";
import { AppShell } from "../components/layout/AppShell";
import { BridgeMonitorPage } from "../pages/BridgeMonitorPage";
import { DashboardPage } from "../pages/DashboardPage";
import { HistoryPage } from "../pages/HistoryPage";
import { NetworkPage } from "../pages/NetworkPage";
import { NewTransactionPage } from "../pages/NewTransactionPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { PendingScreen } from "../pages/PendingScreen";
import { SCREENS } from "../pages/screens";
import { SignInPage } from "../pages/SignInPage";
import { TransactionDetailPage } from "../pages/TransactionDetailPage";

// Routes are not guarded yet: there is no auth to check against until the
// API client exists. Sign-in sits outside the shell.
export const routes: RouteObject[] = [
  { path: "/sign-in", element: <SignInPage /> },
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <DashboardPage /> },
      { path: "/transactions", element: <HistoryPage /> },
      { path: "/transactions/:id", element: <TransactionDetailPage /> },
      // Listed before the placeholders below, so they win for /transactions/new, /network and /bridges.
      { path: "/transactions/new", element: <NewTransactionPage /> },
      { path: "/network", element: <NetworkPage /> },
      { path: "/bridges", element: <BridgeMonitorPage /> },
      ...SCREENS.map((spec) => ({ path: spec.path, element: <PendingScreen spec={spec} /> })),
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
