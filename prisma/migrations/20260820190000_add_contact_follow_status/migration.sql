-- Where a message lands in Instagram — inbox or message requests — is decided
-- by who follows whom. Meta does not expose the folder itself, but it does
-- expose both follow directions, which is the same information one step earlier.
ALTER TABLE "Conversation" ADD COLUMN "contactFollowsUs" BOOLEAN;
ALTER TABLE "Conversation" ADD COLUMN "weFollowContact" BOOLEAN;
ALTER TABLE "Conversation" ADD COLUMN "followStatusAt" TIMESTAMP(3);
