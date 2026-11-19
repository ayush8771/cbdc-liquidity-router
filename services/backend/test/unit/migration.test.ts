import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

// Checks the committed migrations against the schema without a database.
// `prisma migrate diff` prints the SQL Prisma would generate between two
// datamodels; each committed migration must equal it apart from its
// documented manual edits.
//
// 1. init: from empty to the schema before the second migration. That schema
//    is rebuilt from schema.prisma by removing exactly what the second
//    migration added (asserted present, so a stale rule fails loudly).
// 2. failure_code_fee_cost_usd: from that schema to schema.prisma, then two
//    manual edits appended (a CHECK constraint and a backfill).

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = path.join(backendDir, "prisma", "migrations");
const lf = (text: string) => text.replace(/\r\n/g, "\n");

const INIT_MANUAL_EDIT = [
  '    -- Manual edit: NOT NULL added. Prisma emits list columns without it, but',
  "    -- policies is a required field in schema.prisma (Step 5C decision).",
  '    "policies" "Policy"[] NOT NULL,',
].join("\n");
const INIT_GENERATED_LINE = '    "policies" "Policy"[],';

// What the second migration added to schema.prisma.
const SECOND_ADDITIONS = [
  /\n\/\/ The codes a failed POST[^\n]*\n\/\/[^\n]*\nenum FailureCode \{[^}]*\}\n/,
  /\n  failureCode {5}FailureCode\?\n/,
  /\n  feeCostUsd {13}Float\?\n/,
];
const SECOND_MANUAL_EDITS_START = "-- Manual edit 1:";

const migrationDirs = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const migrationSql = (name: string) => lf(readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"));

const scratch = mkdtempSync(path.join(tmpdir(), "cbdc-migration-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function previousSchemaFile(): string {
  let schema = lf(readFileSync(path.join(backendDir, "prisma", "schema.prisma"), "utf8"));
  for (const addition of SECOND_ADDITIONS) {
    assert.match(schema, addition, `schema.prisma no longer contains ${addition}`);
    schema = schema.replace(addition, "\n");
  }
  const file = path.join(scratch, "schema.previous.prisma");
  writeFileSync(file, schema);
  return file;
}

function migrateDiff(from: string[], to: string[]): string {
  const result = spawnSync(
    process.execPath,
    [path.join(backendDir, "node_modules", "prisma", "build", "index.js"), "migrate", "diff", ...from, ...to, "--script"],
    {
      cwd: backendDir,
      // No database is contacted; the URL only satisfies env("DATABASE_URL").
      env: { ...process.env, CHECKPOINT_DISABLE: "1", DATABASE_URL: "postgresql://placeholder@localhost:5432/placeholder" },
      encoding: "utf8",
      timeout: 60000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return lf(result.stdout);
}

describe("prisma migrations", () => {
  it("has the init migration, then the failureCode/feeCostUsd migration, in order", () => {
    assert.equal(migrationDirs.length, 2);
    assert.match(migrationDirs[0]!, /^\d{14}_init$/);
    assert.match(migrationDirs[1]!, /^\d{14}_failure_code_fee_cost_usd$/);
  });

  it("locks the provider to postgresql", () => {
    const lock = lf(readFileSync(path.join(migrationsDir, "migration_lock.toml"), "utf8"));
    assert.match(lock, /^provider = "postgresql"$/m);
  });

  it("makes Comparison.policies NOT NULL", () => {
    assert.ok(migrationSql(migrationDirs[0]!).includes(INIT_MANUAL_EDIT));
  });

  it("init matches the SQL Prisma generates for the schema before the second migration", () => {
    const generated = migrateDiff(["--from-empty"], ["--to-schema-datamodel", previousSchemaFile()]);
    assert.ok(generated.includes(INIT_GENERATED_LINE), "Prisma's output changed; re-check the manual edit");
    assert.equal(
      migrationSql(migrationDirs[0]!).trimEnd(),
      generated.replace(INIT_GENERATED_LINE, INIT_MANUAL_EDIT).trimEnd(),
    );
  });

  it("the second migration matches Prisma's generated SQL, followed by its manual edits", () => {
    const committed = migrationSql(migrationDirs[1]!);
    const start = committed.indexOf(SECOND_MANUAL_EDITS_START);
    assert.ok(start > 0, "the manual edits are missing");
    const generated = migrateDiff(
      ["--from-schema-datamodel", previousSchemaFile()],
      ["--to-schema-datamodel", "prisma/schema.prisma"],
    );
    assert.equal(committed.slice(0, start).trimEnd(), generated.trimEnd());
  });

  it("only adds: no DROP, no NOT NULL column, no default, no data rewrite beyond the feeCostUsd backfill", () => {
    const sql = migrationSql(migrationDirs[1]!);
    assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bRENAME\b/i);
    assert.doesNotMatch(sql, /ADD COLUMN[^;]*NOT NULL/i);
    assert.doesNotMatch(sql, /\bDEFAULT\b/i);
    const updates = sql.match(/\bUPDATE\s+"(\w+)"/gi) ?? [];
    assert.deepEqual(updates, ['UPDATE "RoutingDecision"']);
    assert.match(sql, /SET "feeCostUsd" = /);
  });

  it("allows a failure code only on failed rows, one-directionally", () => {
    assert.ok(
      migrationSql(migrationDirs[1]!).includes(`CHECK ("failureCode" IS NULL OR "status" = 'failed')`),
    );
  });
});
