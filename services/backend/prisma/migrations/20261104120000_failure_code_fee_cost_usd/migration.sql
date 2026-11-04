-- CreateEnum
CREATE TYPE "FailureCode" AS ENUM ('INFERENCE_ERROR', 'INFERENCE_UNAVAILABLE', 'ENGINE_BUSY', 'ENGINE_TIMEOUT');

-- AlterTable
ALTER TABLE "TransactionRequest" ADD COLUMN     "failureCode" "FailureCode";

-- AlterTable
ALTER TABLE "RoutingDecision" ADD COLUMN     "feeCostUsd" DOUBLE PRECISION;

-- Manual edit 1: a failure code only on a failed row (§6.3). One-directional,
-- because failed rows saved before this migration have no recorded code and
-- stay NULL. Prisma can't express CHECK constraints.
ALTER TABLE "TransactionRequest" ADD CONSTRAINT "TransactionRequest_failureCode_failed_only"
    CHECK ("failureCode" IS NULL OR "status" = 'failed');

-- Manual edit 2: backfill feeCostUsd for existing decisions from the verbatim
-- engine response (§6.1), copying metrics.fee_cost_usd where it is a JSON
-- number within DOUBLE PRECISION range. Other rows keep NULL. CASE, not AND:
-- PostgreSQL may evaluate AND operands in any order, and the cast must never
-- see a non-number.
UPDATE "RoutingDecision"
SET "feeCostUsd" = ("engineResponse" #>> '{metrics,fee_cost_usd}')::DOUBLE PRECISION
WHERE CASE
    WHEN jsonb_typeof("engineResponse" #> '{metrics,fee_cost_usd}') = 'number'
        THEN abs(("engineResponse" #>> '{metrics,fee_cost_usd}')::NUMERIC) <= 1.7976931348623157e308
    ELSE FALSE
END;
