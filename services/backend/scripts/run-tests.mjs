// Runs every test/**/*.test.ts file with Node's built-in test runner.
// Node 20's `--test` doesn't expand globs and Windows cmd doesn't either,
// so the file list is built here to behave the same on every platform.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const testDir = path.resolve("test");
const files = readdirSync(testDir, { recursive: true })
  .map(String)
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => path.join(testDir, file));

if (files.length === 0) {
  console.error("No test files found under test/");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
