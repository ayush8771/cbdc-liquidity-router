-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('viewer', 'analyst');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('routed', 'failed');

-- CreateEnum
CREATE TYPE "StateMode" AS ENUM ('historicalReplay', 'scenario', 'explicit');

-- CreateEnum
CREATE TYPE "Policy" AS ENUM ('waterfall', 'cheapestFeasible', 'ppoProjected');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('default', 'baseline', 'experimental');

-- CreateEnum
CREATE TYPE "ValuesProvenance" AS ENUM ('synthetic_simulation', 'synthetic_scenario', 'user_supplied_synthetic');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionRequest" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "senderCountry" TEXT NOT NULL,
    "receiverCountry" TEXT NOT NULL,
    "corridor" TEXT,
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "stateMode" "StateMode" NOT NULL,
    "stateSpec" JSONB NOT NULL,
    "simulationDate" DATE NOT NULL,
    "requestedPolicy" "Policy" NOT NULL,
    "status" "TransactionStatus" NOT NULL,
    "clientReference" TEXT,

    CONSTRAINT "TransactionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingDecision" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "decisionId" TEXT NOT NULL,
    "policy" "Policy" NOT NULL,
    "policyStatus" "PolicyStatus" NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "completed" BOOLEAN NOT NULL,
    "completionRatio" DOUBLE PRECISION NOT NULL,
    "executedUsd" DOUBLE PRECISION NOT NULL,
    "unroutedEnvUsd" DOUBLE PRECISION NOT NULL,
    "unroutedAmountBasedUsd" DOUBLE PRECISION NOT NULL,
    "rewardEnv" DOUBLE PRECISION,
    "rewardAmountBased" DOUBLE PRECISION,
    "latencyTerm" DOUBLE PRECISION,
    "riskTerm" DOUBLE PRECISION,
    "valuesProvenance" "ValuesProvenance" NOT NULL,
    "stateFrameSha256" TEXT NOT NULL,
    "checkpointSha256" TEXT,
    "knowledgeSha256" TEXT NOT NULL,
    "gitCommit" TEXT NOT NULL,
    "engineResponse" JSONB NOT NULL,

    CONSTRAINT "RoutingDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Allocation" (
    "id" UUID NOT NULL,
    "routingDecisionId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "bridgeUid" TEXT NOT NULL,
    "shareRequested" DOUBLE PRECISION NOT NULL,
    "amountRequestedUsd" DOUBLE PRECISION NOT NULL,
    "amountExecutedUsd" DOUBLE PRECISION NOT NULL,
    "amountClippedUsd" DOUBLE PRECISION NOT NULL,
    "liquidityUsd" DOUBLE PRECISION NOT NULL,
    "congestion" DOUBLE PRECISION NOT NULL,
    "risk" DOUBLE PRECISION NOT NULL,
    "shareBeforeProjection" DOUBLE PRECISION,

    CONSTRAINT "Allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comparison" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "senderCountry" TEXT NOT NULL,
    "receiverCountry" TEXT NOT NULL,
    "corridor" TEXT,
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "simulationDate" DATE NOT NULL,
    "clientReference" TEXT,
    "stateMode" "StateMode" NOT NULL,
    "stateSpec" JSONB NOT NULL,
    -- Manual edit: NOT NULL added. Prisma emits list columns without it, but
    -- policies is a required field in schema.prisma (Step 5C decision).
    "policies" "Policy"[] NOT NULL,
    "engineResponse" JSONB NOT NULL,

    CONSTRAINT "Comparison_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Explanation" (
    "id" UUID NOT NULL,
    "routingDecisionId" UUID NOT NULL,
    "engineResponse" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Explanation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "outcome" TEXT NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransactionRequest_createdAt_idx" ON "TransactionRequest"("createdAt");

-- CreateIndex
CREATE INDEX "TransactionRequest_corridor_createdAt_idx" ON "TransactionRequest"("corridor", "createdAt");

-- CreateIndex
CREATE INDEX "TransactionRequest_requestedPolicy_createdAt_idx" ON "TransactionRequest"("requestedPolicy", "createdAt");

-- CreateIndex
CREATE INDEX "TransactionRequest_stateMode_createdAt_idx" ON "TransactionRequest"("stateMode", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RoutingDecision_transactionId_key" ON "RoutingDecision"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Allocation_routingDecisionId_slot_key" ON "Allocation"("routingDecisionId", "slot");

-- CreateIndex
CREATE INDEX "Comparison_createdAt_idx" ON "Comparison"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Explanation_routingDecisionId_key" ON "Explanation"("routingDecisionId");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "AuditLog_requestId_idx" ON "AuditLog"("requestId");

-- AddForeignKey
ALTER TABLE "TransactionRequest" ADD CONSTRAINT "TransactionRequest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoutingDecision" ADD CONSTRAINT "RoutingDecision_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "TransactionRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_routingDecisionId_fkey" FOREIGN KEY ("routingDecisionId") REFERENCES "RoutingDecision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Comparison" ADD CONSTRAINT "Comparison_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Explanation" ADD CONSTRAINT "Explanation_routingDecisionId_fkey" FOREIGN KEY ("routingDecisionId") REFERENCES "RoutingDecision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
