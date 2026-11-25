import { useAuth, type AuthContextValue } from "./AuthContext";

/**
 * The only part of the session observation code may read (AD-6 B-8): no `api`, no `signIn`. Observation files
 * may import this module but not `AuthContext` (lint), so the normal API client is out of reach by type and by lint.
 */
export type ObservationSession = Pick<AuthContextValue, "status" | "openObservationStream">;

export function useObservationSession(): ObservationSession {
  const { status, openObservationStream } = useAuth();
  return { status, openObservationStream };
}
