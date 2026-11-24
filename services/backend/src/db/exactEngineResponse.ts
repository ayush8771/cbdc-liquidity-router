import type { Prisma, PrismaClient } from "@prisma/client";

/*
 * Stores an inference response's jsonb column with the engine's own numbers.
 *
 * Prisma Client serialises a `Json` field by reducing every double to 16
 * significant decimal digits, so the engine's 163200.33073425293 is stored as
 * 163200.3307342529: a different double, one unit in the last place away.
 * Measured on Prisma 6.19.3 against PostgreSQL 18.6, every affected value was
 * exactly the original rounded to 16 significant digits. The API then returned
 * the engine's value from a POST and the rounded value from a later GET, which
 * breaks "returns the same body as the 201 response" (contract §3.4), the same
 * rule for a stored comparison (§3.6) and the requirement to store the
 * inference response **verbatim** (§6.1).
 *
 * Neither end of the write is at fault:
 *   - `JSON.stringify` prints the shortest text that reads back as the same
 *     double, so the text is exact;
 *   - PostgreSQL parses jsonb from text without losing a digit (checked for
 *     jsonb, json and float8 on 18.6, with extra_float_digits = 1).
 * So the text is written and PostgreSQL parses it, which keeps every digit.
 *
 * Each statement updates the row the preceding insert created, inside the same
 * database transaction, so no reader ever sees the rounded value and the record
 * stays append-only (§6.1). The column type does not change, so there is no
 * migration, and nothing about the engine or its output changes.
 *
 * The three statements are written out in full rather than built from a table
 * name, so no identifier is ever interpolated into SQL. The values are bound
 * parameters.
 */

/** A client, or the transactional client inside `$transaction`. */
type Client = PrismaClient | Prisma.TransactionClient;

/** `RoutingDecision.engineResponse` for the decision with this id. */
export function exactRoutingDecisionResponse(client: Client, id: string, engineResponse: unknown) {
  return client.$executeRaw`UPDATE "RoutingDecision" SET "engineResponse" = ${JSON.stringify(engineResponse)}::jsonb WHERE "id" = ${id}::uuid`;
}

/** `Comparison.engineResponse` for the comparison with this id. */
export function exactComparisonResponse(client: Client, id: string, engineResponse: unknown) {
  return client.$executeRaw`UPDATE "Comparison" SET "engineResponse" = ${JSON.stringify(engineResponse)}::jsonb WHERE "id" = ${id}::uuid`;
}

/** `Explanation.engineResponse` for the explanation with this id. */
export function exactExplanationResponse(client: Client, id: string, engineResponse: unknown) {
  return client.$executeRaw`UPDATE "Explanation" SET "engineResponse" = ${JSON.stringify(engineResponse)}::jsonb WHERE "id" = ${id}::uuid`;
}
