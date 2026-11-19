import { readFileSync } from "node:fs";

// Development-only token file (arch §8.2). It holds the SHA-256 of each
// developer's token, never the token itself:
//   {"users": [{"userId", "email", "role", "tokenSha256"}]}
// Problem messages name fields and entry positions only. They never echo
// file contents, because the file holds token hashes.

export type Role = "viewer" | "analyst";

export interface DevUser {
  userId: string;
  email: string;
  role: Role;
  tokenSha256: string;
}

export interface DevTokensResult {
  users: DevUser[];
  problems: string[];
}

const ROLES: readonly string[] = ["viewer", "analyst"];
const ENTRY_FIELDS: readonly string[] = ["userId", "email", "role", "tokenSha256"];
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const EXAMPLE_TEST_EMAIL = /^[^@\s]+@([A-Za-z0-9-]+\.)*example\.test$/i;

export function readDevTokensFile(filePath: string): DevTokensResult {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const problem =
      code === "ENOENT"
        ? `token file not found: ${filePath}`
        : `token file could not be read (${code ?? "unknown error"}): ${filePath}`;
    return { users: [], problems: [problem] };
  }
  return parseDevTokens(text);
}

export function parseDevTokens(text: string): DevTokensResult {
  // Windows editors may save UTF-8 with a byte-order mark.
  const body = text.replace(/^﻿/, "");
  if (body.trim() === "") {
    return { users: [], problems: ["token file is empty"] };
  }

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    // The parser's message can quote file contents, so it is not passed on.
    return { users: [], problems: ["token file is not valid JSON"] };
  }

  if (!isPlainObject(data)) {
    return { users: [], problems: ['token file must be a JSON object with a "users" array'] };
  }
  const problems: string[] = [];
  for (const key of Object.keys(data)) {
    if (key !== "users") problems.push(`token file has an unknown top-level field "${key}"`);
  }
  const entries = data.users;
  if (!Array.isArray(entries) || entries.length === 0) {
    problems.push('token file must contain a non-empty "users" array');
    return { users: [], problems };
  }

  const users: DevUser[] = [];
  const firstIndex = { userId: new Map<string, number>(), tokenSha256: new Map<string, number>() };

  entries.forEach((entry: unknown, i) => {
    const at = `users[${i}]`;
    if (!isPlainObject(entry)) {
      problems.push(`${at} must be an object`);
      return;
    }
    const entryProblems: string[] = [];
    for (const key of Object.keys(entry)) {
      if (!ENTRY_FIELDS.includes(key)) entryProblems.push(`${at} has an unknown field "${key}"`);
    }
    const { userId, email, role, tokenSha256 } = entry;
    if (typeof userId !== "string" || userId.length === 0) {
      entryProblems.push(`${at}.userId must be a non-empty string`);
    }
    if (typeof email !== "string" || !EXAMPLE_TEST_EMAIL.test(email)) {
      entryProblems.push(`${at}.email must be an address ending in example.test`);
    }
    if (typeof role !== "string" || !ROLES.includes(role)) {
      entryProblems.push(`${at}.role must be "viewer" or "analyst"`);
    }
    if (typeof tokenSha256 !== "string" || !SHA256_HEX.test(tokenSha256)) {
      entryProblems.push(`${at}.tokenSha256 must be a SHA-256 hash: 64 hexadecimal characters`);
    }
    if (entryProblems.length > 0) {
      problems.push(...entryProblems);
      return;
    }

    // Hashes are stored lower-case so later comparisons don't depend on case.
    const user = { userId, email, role, tokenSha256: (tokenSha256 as string).toLowerCase() } as DevUser;
    for (const field of ["userId", "tokenSha256"] as const) {
      const previous = firstIndex[field].get(user[field]);
      if (previous !== undefined) {
        problems.push(`${at}.${field} duplicates users[${previous}].${field}`);
      } else {
        firstIndex[field].set(user[field], i);
      }
    }
    users.push(user);
  });

  return problems.length > 0 ? { users: [], problems } : { users, problems };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
