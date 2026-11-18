import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import type { DevUser } from "../../src/config/devTokens.js";
import { seedDevUsers, toUserRecords, type UserUpsertClient } from "../../src/db/seedDevUsers.js";
import { makeTempDir, newToken, sha256Hex, validTokenFile } from "../helpers/devTokens.js";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = makeTempDir();

const users: DevUser[] = [
  { userId: "u-analyst-1", email: "Analyst@Example.Test", role: "analyst", tokenSha256: sha256Hex(newToken()) },
  { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(newToken()) },
];

/** Records upsert calls, and fails on any other property access on the client. */
function fakeClient(options: { failOn?: string } = {}) {
  const calls: Array<Parameters<UserUpsertClient["user"]["upsert"]>[0]> = [];
  const user = {
    upsert: async (args: (typeof calls)[number]) => {
      if (args.where.id === options.failOn) throw new Error("database unavailable");
      calls.push(args);
      return args.create;
    },
  };
  const client = new Proxy({ user } as UserUpsertClient, {
    get(target, prop) {
      if (prop !== "user") throw new Error(`unexpected client access: ${String(prop)}`);
      return target.user;
    },
  });
  return { client, calls };
}

describe("toUserRecords", () => {
  it("keeps id, email (as written) and role, and drops the hash", () => {
    assert.deepEqual(toUserRecords(users), [
      { id: "u-analyst-1", email: "Analyst@Example.Test", role: "analyst" },
      { id: "u-viewer-1", email: "viewer@example.test", role: "viewer" },
    ]);
  });
});

describe("seedDevUsers", () => {
  it("upserts each user by id with only id, email and role", async () => {
    const { client, calls } = fakeClient();
    assert.equal(await seedDevUsers(client, users), 2);
    assert.deepEqual(calls, [
      {
        where: { id: "u-analyst-1" },
        create: { id: "u-analyst-1", email: "Analyst@Example.Test", role: "analyst" },
        update: { email: "Analyst@Example.Test", role: "analyst" },
      },
      {
        where: { id: "u-viewer-1" },
        create: { id: "u-viewer-1", email: "viewer@example.test", role: "viewer" },
        update: { email: "viewer@example.test", role: "viewer" },
      },
    ]);
  });

  it("never passes a token hash to the database client", async () => {
    const { client, calls } = fakeClient();
    await seedDevUsers(client, users);
    const sent = JSON.stringify(calls);
    for (const user of users) assert.ok(!sent.includes(user.tokenSha256));
    assert.ok(!sent.includes("tokenSha256"));
  });

  it("only upserts: no delete or other calls (the fake client throws on any)", async () => {
    const { client } = fakeClient();
    await assert.doesNotReject(seedDevUsers(client, users));
  });

  it("does nothing for an empty list", async () => {
    const { client, calls } = fakeClient();
    assert.equal(await seedDevUsers(client, []), 0);
    assert.equal(calls.length, 0);
  });

  it("stops and rejects when an upsert fails", async () => {
    const { client, calls } = fakeClient({ failOn: "u-analyst-1" });
    await assert.rejects(seedDevUsers(client, users), /database unavailable/);
    assert.equal(calls.length, 0);
  });
});

describe("prisma/seed.ts token-file validation (no database)", () => {
  after(() => tmp.cleanup());

  function runSeed(env: Record<string, string>) {
    const base: NodeJS.ProcessEnv = { ...process.env };
    delete base.DATABASE_URL;
    delete base.DEV_TOKENS_FILE;
    const result = spawnSync(process.execPath, ["--import", "tsx", "prisma/seed.ts"], {
      cwd: backendDir,
      env: { ...base, ...env },
      encoding: "utf8",
      timeout: 30000,
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it("refuses an invalid token file before connecting, without printing hashes", () => {
    const file = validTokenFile();
    const hash = file.users[0]!.tokenSha256 as string;
    file.users[1] = { ...file.users[0] }; // duplicate id and hash
    const result = runSeed({ DEV_TOKENS_FILE: tmp.write("dupes.json", file) });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Seed aborted\. Invalid development token file:/);
    assert.match(result.output, /users\[1\]\.userId duplicates users\[0\]\.userId/);
    assert.ok(!result.output.includes(hash), "hash printed");
    assert.ok(!result.output.includes("Seeded"), result.output);
  });

  it("resolves a relative DEV_TOKENS_FILE against the working directory", () => {
    const result = runSeed({ DEV_TOKENS_FILE: "no-such-dir/tokens.json" });
    assert.equal(result.status, 1, result.output);
    assert.ok(result.output.includes(`token file not found: ${path.join(backendDir, "no-such-dir", "tokens.json")}`), result.output);
  });
});
