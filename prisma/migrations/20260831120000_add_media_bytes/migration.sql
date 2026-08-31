-- Media people send in a thread, and contact profile pictures.
--
-- The bytes are stored rather than Meta's URL: Instagram hands out signed CDN
-- links that expire, so a stored address becomes a broken image days later —
-- silently, with nothing left to re-fetch. Both tables are therefore filled at
-- the moment the file is still reachable, and served from here afterwards.
CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageAttachment_messageId_key" ON "MessageAttachment"("messageId");
CREATE INDEX "MessageAttachment_workspaceId_idx" ON "MessageAttachment"("workspaceId");

ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContactAvatar" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactAvatar_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContactAvatar_conversationId_key" ON "ContactAvatar"("conversationId");
CREATE INDEX "ContactAvatar_workspaceId_idx" ON "ContactAvatar"("workspaceId");

ALTER TABLE "ContactAvatar" ADD CONSTRAINT "ContactAvatar_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactAvatar" ADD CONSTRAINT "ContactAvatar_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
