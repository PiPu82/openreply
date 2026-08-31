-- How often the attachment repair has gone looking for a message's file.
--
-- Bounded on purpose. Most of what the repair cannot fetch it will never
-- fetch — the message has passed out of Meta's twenty-message window, or the
-- file was never one Meta hands back. Without a count those rows come round on
-- every single run, forever, at one Graph call apiece.
ALTER TABLE "Message" ADD COLUMN "attachmentTries" INTEGER NOT NULL DEFAULT 0;
