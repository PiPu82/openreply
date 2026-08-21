-- Every comment, inbound DM and button tap, for ranking the most active
-- contacts. Fed from webhook deliveries that already arrive; no API calls.
CREATE TYPE "InteractionType" AS ENUM ('COMMENT', 'DM', 'BUTTON_TAP');

CREATE TABLE "Interaction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "contactUsername" TEXT,
    "type" "InteractionType" NOT NULL,
    "externalId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Interaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Interaction_externalId_key" ON "Interaction"("externalId");
CREATE INDEX "Interaction_workspaceId_at_idx" ON "Interaction"("workspaceId", "at");
CREATE INDEX "Interaction_contactId_idx" ON "Interaction"("contactId");

ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
