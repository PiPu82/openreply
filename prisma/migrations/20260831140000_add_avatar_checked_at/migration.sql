-- When a contact's profile picture was last looked for.
--
-- Kept apart from followStatusAt: that one gates threads somebody wrote in,
-- which is a much smaller set than the rows the inbox draws a picture for.
-- Stamped on every attempt, including the ones that come back empty, so a
-- contact Instagram has no picture for is not retried on every run forever.
ALTER TABLE "Conversation" ADD COLUMN "avatarCheckedAt" TIMESTAMP(3);

-- Partial index: the sync only ever asks for the ones still outstanding.
CREATE INDEX "Conversation_avatarCheckedAt_idx"
    ON "Conversation"("instagramAccountId", "avatarCheckedAt");
