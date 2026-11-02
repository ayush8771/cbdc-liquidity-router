import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import { parseDevTokens, readDevTokensFile } from "../../src/config/devTokens.js";
import { makeTempDir, newToken, sha256Hex, validTokenFile } from "../helpers/devTokens.js";

const tmp = makeTempDir();
after(() => tmp.cleanup());

function problemsFor(content: unknown): string[] {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return parseDevTokens(text).problems;
}

function withEntry(overrides: Record<string, unknown>): unknown {
  const file = validTokenFile();
  file.users[0] = { ...file.users[0], ...overrides };
  return file;
}

describe("dev token file: valid", () => {
  it("parses users and preserves emails as written", () => {
    const file = validTokenFile();
    file.users[0]!.email = "Analyst@Example.Test";
    const result = parseDevTokens(JSON.stringify(file));
    assert.deepEqual(result.problems, []);
    assert.equal(result.users.length, 2);
    assert.deepEqual(result.users[0], file.users[0]);
    assert.equal(result.users[1]!.role, "viewer");
  });

  it("accepts an upper-case hash and stores it lower-case", () => {
    const hash = sha256Hex(newToken());
    const result = parseDevTokens(JSON.stringify(withEntry({ tokenSha256: hash.toUpperCase() })));
    assert.deepEqual(result.problems, []);
    assert.equal(result.users[0]!.tokenSha256, hash);
  });

  for (const userId of ["has space", "x".repeat(65), "Ünïcode"]) {
    it(`accepts userId ${JSON.stringify(userId)}`, () => {
      assert.deepEqual(problemsFor(withEntry({ userId })), []);
    });
  }

  it("allows the same email on two users", () => {
    const file = validTokenFile();
    file.users[1]!.email = file.users[0]!.email;
    assert.deepEqual(problemsFor(file), []);
  });

  it("accepts a UTF-8 byte-order mark", () => {
    const result = parseDevTokens(`﻿${JSON.stringify(validTokenFile())}`);
    assert.deepEqual(result.problems, []);
  });

  it("accepts subdomains of example.test", () => {
    assert.deepEqual(problemsFor(withEntry({ email: "dev@team.example.test" })), []);
  });

  it("reads a file from disk", () => {
    const file = tmp.write("valid.json", validTokenFile());
    const result = readDevTokensFile(file);
    assert.deepEqual(result.problems, []);
    assert.equal(result.users.length, 2);
  });
});

describe("dev token file: missing, empty or malformed", () => {
  it("rejects a missing file", () => {
    const missing = path.join(tmp.dir, "does-not-exist.json");
    assert.deepEqual(readDevTokensFile(missing).problems, [`token file not found: ${missing}`]);
  });

  it("rejects a directory in place of a file", () => {
    const [problem] = readDevTokensFile(tmp.dir).problems;
    assert.match(problem ?? "", /^token file could not be read \(E[A-Z]+\)/);
  });

  for (const [name, content] of [["empty", ""], ["whitespace only", "  \n\t "]] as const) {
    it(`rejects an ${name} file`, () => {
      assert.deepEqual(problemsFor(content), ["token file is empty"]);
    });
  }

  it("rejects invalid JSON without quoting the file contents", () => {
    const secretish = sha256Hex("do-not-echo");
    const problems = problemsFor(`{"users": [{"tokenSha256": "${secretish}"`);
    assert.deepEqual(problems, ["token file is not valid JSON"]);
  });

  for (const [name, content] of [
    ["an array", "[]"],
    ["a string", '"x"'],
    ["null", "null"],
  ] as const) {
    it(`rejects a top-level ${name}`, () => {
      assert.deepEqual(problemsFor(content), ['token file must be a JSON object with a "users" array']);
    });
  }

  for (const [name, content] of [
    ["missing users", {}],
    ["empty users", { users: [] }],
    ["non-array users", { users: {} }],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.deepEqual(problemsFor(content), ['token file must contain a non-empty "users" array']);
    });
  }

  it("rejects unknown top-level fields", () => {
    assert.deepEqual(problemsFor({ ...validTokenFile(), version: 1 }), [
      'token file has an unknown top-level field "version"',
    ]);
  });

  it("rejects a non-object entry", () => {
    assert.deepEqual(problemsFor({ users: ["u-1"] }), ["users[0] must be an object"]);
  });

  const malformedHashes: Array<[string, unknown]> = [
    ["too short", "abc123"],
    ["too long", `${sha256Hex("x")}0`],
    ["non-hex", "z".repeat(64)],
    ["surrounding spaces", ` ${sha256Hex("x")} `],
    ["placeholder text", "<replace with the SHA-256 of your own token: 64 lowercase hex characters>"],
    ["a number", 12345],
    ["missing", undefined],
  ];
  for (const [name, value] of malformedHashes) {
    it(`rejects a malformed hash (${name})`, () => {
      assert.deepEqual(problemsFor(withEntry({ tokenSha256: value })), [
        "users[0].tokenSha256 must be a SHA-256 hash: 64 hexadecimal characters",
      ]);
    });
  }

  it("rejects a bad role", () => {
    assert.deepEqual(problemsFor(withEntry({ role: "admin" })), ['users[0].role must be "viewer" or "analyst"']);
  });

  for (const email of ["analyst@example.com", "analyst@gmail.com", "no-at-sign.example.test", ""]) {
    it(`rejects email ${JSON.stringify(email)}`, () => {
      assert.deepEqual(problemsFor(withEntry({ email })), ["users[0].email must be an address ending in example.test"]);
    });
  }

  for (const [name, userId] of [["empty", ""], ["a number", 7], ["null", null], ["missing", undefined]] as const) {
    it(`rejects a userId that is ${name}`, () => {
      assert.deepEqual(problemsFor(withEntry({ userId })), ["users[0].userId must be a non-empty string"]);
    });
  }

  it("rejects unknown entry fields, such as a raw token", () => {
    const token = newToken();
    const problems = problemsFor(withEntry({ token }));
    assert.deepEqual(problems, ['users[0] has an unknown field "token"']);
    assert.ok(!problems.join("\n").includes(token));
  });

  it("rejects duplicate user IDs and hashes", () => {
    const file = validTokenFile();
    file.users[1] = { ...file.users[0], role: "viewer" };
    assert.deepEqual(problemsFor(file), [
      "users[1].userId duplicates users[0].userId",
      "users[1].tokenSha256 duplicates users[0].tokenSha256",
    ]);
  });

  it("treats hashes differing only in case as duplicates", () => {
    const file = validTokenFile();
    file.users[1]!.tokenSha256 = (file.users[0]!.tokenSha256 as string).toUpperCase();
    assert.deepEqual(problemsFor(file), ["users[1].tokenSha256 duplicates users[0].tokenSha256"]);
  });

  it("treats user IDs as case-sensitive", () => {
    const file = validTokenFile();
    file.users[1]!.userId = (file.users[0]!.userId as string).toUpperCase();
    assert.deepEqual(problemsFor(file), []);
  });

  it("reports every problem and returns no users", () => {
    const file = validTokenFile();
    file.users[0] = { ...file.users[0], role: "root" };
    file.users[1] = { ...file.users[1], tokenSha256: "bad" };
    const result = parseDevTokens(JSON.stringify(file));
    assert.deepEqual(result.users, []);
    assert.equal(result.problems.length, 2);
  });

  it("never echoes a hash in any problem message", () => {
    const file = validTokenFile();
    const hash = file.users[0]!.tokenSha256 as string;
    file.users[1] = { ...file.users[0] };
    file.users.push({ extra: hash });
    assert.ok(!problemsFor(file).join("\n").includes(hash));
  });
});
