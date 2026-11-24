import { useEffect, useState } from "react";

export type ApiQueryState<T> =
  | { status: "idle"; data: undefined; error: undefined }
  | { status: "loading"; data: undefined; error: undefined }
  | { status: "success"; data: T; error: undefined }
  | { status: "error"; data: undefined; error: unknown };

type Settled<T> = { requestKey: string; outcome: { ok: true; data: T } | { ok: false; error: unknown } };

/**
 * Runs one read request while `enabled`, and again when `key` changes or
 * `retry()` is called. Nothing is retried automatically. An answer that arrives
 * after the key changed (or the screen left) is ignored, so a slow old page can
 * never replace a newer one. While a new request is running the state is
 * `loading`, not the previous data.
 *
 * `settledOnce` is true once any request of this query has finished, whatever
 * its outcome, and stays true while a retry runs: a screen can wait for a first
 * answer without going back to waiting every time it asks again.
 *
 * `key` must name everything the request depends on (the fetcher is not compared).
 */
export function useApiQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  enabled: boolean,
): ApiQueryState<T> & { retry: () => void; settledOnce: boolean } {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const requestKey = `${key}#${attempt}`;

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    fetcher().then(
      (data) => {
        if (current) setSettled({ requestKey, outcome: { ok: true, data } });
      },
      (error: unknown) => {
        if (current) setSettled({ requestKey, outcome: { ok: false, error } });
      },
    );
    return () => {
      current = false;
    };
    // The key stands for the fetcher's inputs; a new fetcher every render must not restart the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, enabled]);

  const retry = () => setAttempt((n) => n + 1);
  const settledOnce = settled !== null;
  if (!enabled) return { status: "idle", data: undefined, error: undefined, retry, settledOnce };
  if (settled === null || settled.requestKey !== requestKey) {
    return { status: "loading", data: undefined, error: undefined, retry, settledOnce };
  }
  return settled.outcome.ok
    ? { status: "success", data: settled.outcome.data, error: undefined, retry, settledOnce }
    : { status: "error", data: undefined, error: settled.outcome.error, retry, settledOnce };
}
