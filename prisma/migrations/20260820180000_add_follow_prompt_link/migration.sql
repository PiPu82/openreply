-- A link button for the follow prompt, shown before the "I'm following" button.
-- Being asked to follow without being given the profile is a dead end; Meta
-- allows a link button and a postback button in the same template.
ALTER TABLE "Automation" ADD COLUMN "followPromptLinkUrl" TEXT;
ALTER TABLE "Automation" ADD COLUMN "followPromptLinkLabel" TEXT;
