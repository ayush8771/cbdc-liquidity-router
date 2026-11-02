import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import type { DevUser } from "../config/devTokens.js";
import { ApiError } from "../middleware/errors.js";

// Development-only bearer-token auth (arch §8.2, API contract §3.0).
// The token is hashed with SHA-256 and compared with crypto.timingSafeEqual
// against every stored hash. Neither the token nor a hash is ever logged,
// returned or attached to the request.

export type AuthUser = Omit<DevUser, "tokenSha256">;

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

// "Bearer" in any letter case, then exactly one 64-character hex token.
const BEARER = /^bearer +([^ ]+)$/i;
const TOKEN = /^[0-9a-fA-F]{64}$/;

/** Returns the token from an Authorization header, or undefined if malformed. */
export function parseBearerToken(header: string | undefined): string | undefined {
  const token = header === undefined ? undefined : BEARER.exec(header)?.[1];
  return token !== undefined && TOKEN.test(token) ? token : undefined;
}

export type Authenticator = (authorizationHeader: string | undefined) => AuthUser | undefined;

export function createAuthenticator(users: readonly DevUser[]): Authenticator {
  const entries = users.map(({ tokenSha256, ...user }) => ({
    hash: Buffer.from(tokenSha256, "hex"),
    user: Object.freeze(user),
  }));

  return (authorizationHeader) => {
    // Malformed tokens are rejected before any lookup (arch §8.2).
    const token = parseBearerToken(authorizationHeader);
    if (token === undefined) return undefined;

    // The token is hashed exactly as sent, so its letter case matters.
    const hash = createHash("sha256").update(token).digest();
    let match: AuthUser | undefined;
    // Compare against every entry, without stopping early, so the time taken
    // doesn't reveal which entry matched.
    for (const entry of entries) {
      if (timingSafeEqual(hash, entry.hash) && match === undefined) match = entry.user;
    }
    return match;
  };
}

export function requireAuth(authenticate: Authenticator): RequestHandler {
  return (req, _res, next) => {
    const user = authenticate(req.get("Authorization"));
    if (user === undefined) {
      // One message for missing, malformed and unknown tokens alike.
      next(new ApiError(401, "UNAUTHENTICATED", "Missing or invalid bearer token."));
      return;
    }
    req.user = user;
    next();
  };
}

/** The authenticated caller. Only valid on routes behind requireAuth. */
export function authenticatedUser(req: Request): AuthUser {
  if (req.user === undefined) throw new Error("route is not protected by requireAuth");
  return req.user;
}
