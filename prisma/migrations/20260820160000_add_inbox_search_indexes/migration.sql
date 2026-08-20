-- Trigram indexes for inbox search.
--
-- The inbox searches names and message bodies with ILIKE '%term%'. A leading
-- wildcard cannot use a normal B-tree index, so without these every search is a
-- sequential scan over the whole store. Trigrams index substrings and make the
-- wildcard usable.
--
-- Chosen over Postgres full-text search deliberately: full-text search matches
-- whole words after stemming, so "strom" would not find "Allgemeinstrom" and a
-- partially typed name would find nothing. Both are exactly what gets typed
-- into a search box.
--
-- These indexes are declared here rather than in schema.prisma — expressing
-- operator classes there needs the postgresqlExtensions preview feature. Only
-- `migrate deploy` runs against this database, which leaves them alone.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Message_text_trgm_idx" ON "Message" USING GIN ("text" gin_trgm_ops);

CREATE INDEX "Conversation_contactUsername_trgm_idx" ON "Conversation" USING GIN ("contactUsername" gin_trgm_ops);
