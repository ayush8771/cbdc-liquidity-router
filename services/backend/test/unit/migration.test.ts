import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// Checks the committed migration against the schema without a database:
// `prisma migrate diff --from-empty` prints the SQL Prisma would generate from
// schema.prisma, which must equal migration.sql apart from the one documented
// manual edit (Comparison.policies NOT NULL).

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = path.join(backendDir, "prisma", "migrations");
const MANUAL_EDIT = [
  '    -- Manual edit: NOT NULL added. Prisma emits list columns without it, but',
  "    -- policies is a required field in schema.prisma (Step 5C decision).",
  '    "policies" "Policy"[] NOT NULL,',
].join("\n");
const GENERATED_LINE = '    "policies" "Policy"[],';

const lf = (text: string) => text.replace(/\r\n/g, "\n");
const migrationDirs = readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory());

describe("prisma migrations", () => {
  it("has exactly one migration, the initial one", () => {
    assert.equal(migrationDirs.length, 1);
    assert.match(migrationDirs[0]!.name, /^\d{14}_init$/);
  });

  it("locks the provider to postgresql", () => {
    const lock = lf(readFileSync(path.join(migrationsDir, "migration_lock.toml"), "utf8"));
    assert.match(lock, /^provider = "postgresql"$/m);
  });

  it("makes Comparison.policies NOT NULL", () => {
    const sql = lf(readFileSync(path.join(migrationsDir, migrationDirs[0]!.name, "migration.sql"), "utf8"));
    assert.ok(sql.includes(MANUAL_EDIT));
  });

  it("matches the SQL Prisma generates from schema.prisma, apart from the documented edit", () => {
    const committed = lf(readFileSync(path.join(migrationsDir, migrationDirs[0]!.name, "migration.sql"), "utf8"));
    const result = spawnSync(
      process.execPath,
      [path.join(backendDir, "node_modules", "prisma", "build", "index.js"), "migrate", "diff", "--from-empty",
        "--to-schema-datamodel", "prisma/schema.prisma", "--script"],
      {
        cwd: backendDir,
        // No database is contacted; the URL only satisfies env("DATABASE_URL").
        env: { ...process.env, CHECKPOINT_DISABLE: "1", DATABASE_URL: "postgresql://placeholder@localhost:5432/placeholder" },
        encoding: "utf8",
        timeout: 60000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const generated = lf(result.stdout);
    assert.ok(generated.includes(GENERATED_LINE), "Prisma's output changed; re-check the manual edit");
    assert.equal(committed.trimEnd(), generated.replace(GENERATED_LINE, MANUAL_EDIT).trimEnd());
  });
});
