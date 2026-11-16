import type { Logger } from "../logger.js";
import { InvalidVersionResponseError, validateVersionResponse } from "../mappers/versionResponse.js";
import type { InferenceClient, JsonObject } from "./client.js";

// The shared inference GET cache (API contract §3.1 "(cached)", §5 Caching).
// One per createApp instance, in memory, filled lazily (nothing at startup).
//
// - /v1/version is re-fetched once VERSION_REFRESH_MS has passed since it was
//   last fetched. The interval is a backend constant, not configuration.
// - Each refresh computes the §5 fingerprint. When it differs from the last
//   one, the cached network, calendar and scenarios entries are dropped.
// - Every resource read first makes sure the version is fresh. A failed
//   version refresh propagates its inference error, so a resource is never
//   served past a failed refresh.
// - Each /v1/version body is validated (mappers/versionResponse.ts) before it
//   is stored. A malformed 200 is 502 INFERENCE_ERROR and is not stored, so
//   the next call fetches /v1/version again at once.
// - Failures are never cached: the next call fetches again.
// - Concurrent callers share one in-flight version fetch, and one in-flight
//   fetch per resource. A shared fetch forwards the first caller's request ID.
// - Live and mock mode are treated alike; the client decides where answers
//   come from.

/** The fixed version refresh interval (milliseconds). */
export const VERSION_REFRESH_MS = 30_000;

/** The GET paths cached under the version fingerprint, besides /v1/version itself. */
export type CachedResourcePath = "/v1/network" | "/v1/replay/calendar" | "/v1/scenarios";

export interface InferenceCache {
  /** The /v1/version body, refreshed after VERSION_REFRESH_MS. */
  version(requestId?: string): Promise<JsonObject>;
  /** A cached resource body, valid for the current version fingerprint. */
  get(path: CachedResourcePath, requestId?: string): Promise<JsonObject>;
}

export interface InferenceCacheOptions {
  /** Milliseconds clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** Logs a rejected /v1/version body (field paths only). */
  logger?: Logger;
}

export function createInferenceCache(client: InferenceClient, options: InferenceCacheOptions = {}): InferenceCache {
  const now = options.now ?? Date.now;

  let version: { body: JsonObject; fingerprint: string; fetchedAt: number } | undefined;
  let versionInFlight: Promise<JsonObject> | undefined;
  // Bumped whenever the fingerprint changes; resources are tagged with it.
  let generation = 0;
  const resources = new Map<CachedResourcePath, { generation: number; body: JsonObject }>();
  const resourcesInFlight = new Map<
    CachedResourcePath,
    { generation: number; promise: Promise<JsonObject>; token: symbol }
  >();

  const refreshVersion = (requestId: string | undefined): Promise<JsonObject> => {
    if (versionInFlight !== undefined) return versionInFlight;
    const promise = (async () => {
      try {
        const body = await client.get("/v1/version", { requestId });
        try {
          validateVersionResponse(body);
        } catch (error) {
          if (error instanceof InvalidVersionResponseError) {
            options.logger?.warn("inference response rejected", {
              requestId,
              path: "/v1/version",
              problems: error.problems,
            });
          }
          throw error;
        }
        const fingerprint = versionFingerprint(body);
        if (version !== undefined && version.fingerprint !== fingerprint) {
          generation += 1;
          resources.clear();
        }
        version = { body, fingerprint, fetchedAt: now() };
        return body;
      } finally {
        versionInFlight = undefined;
      }
    })();
    versionInFlight = promise;
    return promise;
  };

  const currentVersion = async (requestId: string | undefined): Promise<JsonObject> => {
    if (version !== undefined && now() - version.fetchedAt < VERSION_REFRESH_MS) return version.body;
    return refreshVersion(requestId);
  };

  return {
    async version(requestId) {
      return structuredClone(await currentVersion(requestId));
    },

    async get(path, requestId) {
      await currentVersion(requestId);
      const current = generation;
      const hit = resources.get(path);
      if (hit !== undefined && hit.generation === current) return structuredClone(hit.body);

      const pending = resourcesInFlight.get(path);
      if (pending !== undefined && pending.generation === current) return structuredClone(await pending.promise);

      // Identifies this fetch, so a later fetch's entry is never removed by it.
      const token = Symbol(path);
      const promise = (async () => {
        try {
          const body = await client.get(path, { requestId });
          // Stored only if the fingerprint didn't change during the fetch.
          if (generation === current) resources.set(path, { generation: current, body });
          return body;
        } finally {
          if (resourcesInFlight.get(path)?.token === token) resourcesInFlight.delete(path);
        }
      })();
      resourcesInFlight.set(path, { generation: current, promise, token });
      return structuredClone(await promise);
    },
  };
}

/**
 * The §5 invalidation fingerprint of a /v1/version body: git_commit,
 * engine_version, the whole reward_weights object, knowledge.sha256, the six
 * data hashes and checkpoint.sha256 (null when checkpoint is null). A missing
 * field is kept distinct from null. Object keys are sorted, so key order never
 * counts as a change.
 */
export function versionFingerprint(body: JsonObject): string {
  const knowledge = asObject(body.knowledge);
  const data = asObject(body.data);
  const checkpoint = body.checkpoint === null ? null : asObject(body.checkpoint)?.sha256;
  return canonical([
    body.git_commit,
    body.engine_version,
    body.reward_weights,
    knowledge?.sha256,
    data?.daily_state_sha256,
    data?.bridge_network_sha256,
    data?.normalization_stats_sha256,
    data?.macro_risk_proxy_sha256,
    data?.rpw_corridor_quarterly_sha256,
    data?.scenarios_sha256,
    checkpoint,
  ]);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Canonical text of a JSON value, with sorted keys and undefined as its own token.
function canonical(value: unknown): string {
  if (value === undefined) return "~";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = asObject(value);
  if (object !== undefined) {
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
