import type { RequestHandler } from "express";
import { ApiError } from "./errors.js";

// 405 METHOD_NOT_ALLOWED (API contract §4): the path exists, but not with this
// method. The response has an Allow header listing the path's methods
// (RFC 9110 §15.5.6), and details stay empty.
//
// - Mounted after every route and before notFound, so it sees only requests
//   no route answered. A path in the table therefore reaching it means the
//   method isn't registered there.
// - Paths match as Express matches them: case-insensitively, with one
//   optional trailing slash. Query strings are ignored.
// - HEAD is listed wherever GET is: Express answers HEAD with the GET route.
// - The message names the method and the registered path, never the raw URL,
//   so no caller-supplied text (query, odd casing, an :id value) is echoed:
//   e.g. "Method DELETE is not allowed on /api/v1/transactions/:id."
// - It runs before authentication, because no route (and so no auth) matched
//   the method (contract §10 Q14: 405 is checked before authentication).

export type RouteMethods = Readonly<Record<string, readonly string[]>>;

/** The 405 for a method on a registered path, with its Allow header. */
export function methodNotAllowedError(method: string, path: string, allow: string): ApiError {
  return new ApiError(405, "METHOD_NOT_ALLOWED", `Method ${method} is not allowed on ${path}.`, {}, { Allow: allow });
}

/**
 * Registered GET paths that do not support HEAD. Express would answer HEAD
 * with the GET handler, so each such path also needs an explicit HEAD route
 * that returns methodNotAllowedError (see app.ts). Their Allow lists GET only.
 */
export interface MethodNotAllowedOptions {
  getWithoutHead?: readonly string[];
}

export function methodNotAllowed(routes: RouteMethods, options: MethodNotAllowedOptions = {}): RequestHandler {
  const table: Array<{ pattern: RegExp; path: string; allow: string }> = [];
  for (const [path, methods] of Object.entries(routes)) {
    const upper = methods.map((m) => m.toUpperCase());
    const implicitHead = !(options.getWithoutHead ?? []).includes(path);
    // HEAD right after GET, e.g. "GET, HEAD, POST".
    const allow = upper.flatMap((m) =>
      m === "GET" && implicitHead && !upper.includes("HEAD") ? ["GET", "HEAD"] : [m],
    );
    table.push({ pattern: toPattern(path), path, allow: allow.join(", ") });
  }
  return (req, _res, next) => {
    const path = normalise(req.path);
    const route = table.find((r) => r.pattern.test(path));
    if (route === undefined) return next();
    next(methodNotAllowedError(req.method, route.path, route.allow));
  };
}

// A registered path as a pattern: each ":name" segment matches one non-empty
// segment, as Express's route parameters do; everything else is literal.
function toPattern(path: string): RegExp {
  const segments = normalise(path)
    .split("/")
    .map((s) => (s.startsWith(":") ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return new RegExp(`^${segments.join("/")}$`);
}

function normalise(path: string): string {
  const lower = path.toLowerCase();
  return lower.length > 1 && lower.endsWith("/") ? lower.slice(0, -1) : lower;
}
