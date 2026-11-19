import type { RouteObject } from "react-router-dom";
import { RequireAuth } from "../auth/RequireAuth";
import { AppShell } from "../components/layout/AppShell";
import { BridgeMonitorPage } from "../pages/BridgeMonitorPage";
import { ComparePage } from "../pages/ComparePage";
import { DashboardPage } from "../pages/DashboardPage";
import { HistoryPage } from "../pages/HistoryPage";
import { NetworkPage } from "../pages/NetworkPage";
import { NewTransactionPage } from "../pages/NewTransactionPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { PendingScreen } from "../pages/PendingScreen";
import { SCREENS } from "../pages/screens";
import { SignInPage } from "../pages/SignInPage";
import { TransactionDetailPage } from "../pages/TransactionDetailPage";

// Every screen except sign-in needs a session (arch §8.3): RequireAuth sends
// anyone without one to /sign-in. Sign-in sits outside the guard and the shell.
export const routes: RouteObject[] = [
  { path: "/sign-in", element: <SignInPage /> },
  {
    element: <RequireAuth />,
    children: [
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
          // /compare is the placeholder below 1024px and in preview mode (ComparePage decides); /compare/:id is a saved comparison.
          { path: "/compare", element: <ComparePage /> },
          { path: "/compare/:id", element: <ComparePage /> },
          ...SCREENS.map((spec) => ({ path: spec.path, element: <PendingScreen spec={spec} /> })),
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
