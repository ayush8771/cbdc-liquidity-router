import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

declare module "express-serve-static-core" {
  interface Request {
    requestId: string;
  }
}

export const REQUEST_ID_HEADER = "X-Request-Id";

// API contract §1: use the caller's X-Request-Id, or generate one, and echo it
// in the response header. An empty value counts as missing.
export const requestId: RequestHandler = (req, res, next) => {
  const supplied = req.get(REQUEST_ID_HEADER);
  req.requestId = supplied && supplied.trim() !== "" ? supplied : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, req.requestId);
  next();
};
