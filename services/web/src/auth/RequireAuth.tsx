import { Navigate, Outlet, useLocation } from "react-router-dom";
import { LoadingState } from "../components/ui/LoadingState";
import { useAuth } from "./AuthContext";

/**
 * Route guard. Signed-in visitors see the page; others go to /sign-in and are
 * sent back afterwards. Only the path is remembered (in router state, not the
 * URL), and the token is never part of it.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "restoring") {
    return (
      <div className="mx-auto w-full max-w-content px-4 py-10 sm:px-6 lg:px-10">
        <LoadingState label="Checking your session" rows={3} />
      </div>
    );
  }
  if (status === "signedOut") {
    return <Navigate to="/sign-in" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return <Outlet />;
}

/** Where to go after sign-in: the page the guard turned away, if it is a plain in-app path. */
export function returnPath(state: unknown): string {
  const from = typeof state === "object" && state !== null ? (state as { from?: unknown }).from : undefined;
  if (typeof from === "string" && from.startsWith("/") && !from.startsWith("//") && !from.startsWith("/sign-in")) {
    return from;
  }
  return "/";
}
