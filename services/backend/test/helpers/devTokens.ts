import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export function validTokenFile(): { users: Array<Record<string, unknown>> } {
  return {
    users: [
      { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(newToken()) },
      { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(newToken()) },
    ],
  };
}

/** A temporary directory that tests write token files into. */
export function makeTempDir(): { dir: string; write: (name: string, content: unknown) => string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cbdc-backend-test-"));
  return {
    dir,
    write(name, content) {
      const file = path.join(dir, name);
      writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
      return file;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
