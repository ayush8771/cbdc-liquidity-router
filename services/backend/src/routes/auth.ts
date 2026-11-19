import type { RequestHandler } from "express";
import { authenticatedUser } from "../auth/devAuth.js";
import { canUseExperimentalPolicies } from "../auth/policies.js";

// GET /api/v1/auth/me (API contract §3.0).
export const authMe: RequestHandler = (req, res) => {
  const user = authenticatedUser(req);
  res.json({
    userId: user.userId,
    email: user.email,
    role: user.role,
    authMode: "dev",
    permissions: { experimentalPolicies: canUseExperimentalPolicies(user.role) },
  });
};
