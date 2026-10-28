-- AlterEnum
ALTER TYPE "PostingSource" ADD VALUE 'APIFY_LINKEDIN';
ALTER TYPE "PostingSource" ADD VALUE 'APIFY_INDEED';

-- AlterTable
ALTER TABLE "AgentCandidate" ADD COLUMN     "agentId" TEXT;

-- CreateTable
CREATE TABLE "JobAgent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "source" "PostingSource" NOT NULL,
    "query" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "hour" INTEGER NOT NULL DEFAULT 7,
    "minScore" INTEGER NOT NULL DEFAULT 70,
    "maxScores" INTEGER NOT NULL DEFAULT 15,
    "maxDrafts" INTEGER NOT NULL DEFAULT 3,
    "autoDraft" BOOLEAN NOT NULL DEFAULT false,
    "runs" JSONB NOT NULL DEFAULT '[]',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobAgent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobAgent_position_idx" ON "JobAgent"("position");

-- CreateIndex
CREATE INDEX "AgentCandidate_agentId_idx" ON "AgentCandidate"("agentId");

-- AddForeignKey
ALTER TABLE "AgentCandidate" ADD CONSTRAINT "AgentCandidate_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "JobAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The single agent's settings (agent* rows in "Setting") become the first
-- JobAgent the first time the agents are listed (src/lib/agent/agents.ts),
-- where the same schema that read them still applies.
