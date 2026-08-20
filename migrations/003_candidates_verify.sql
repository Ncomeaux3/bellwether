-- Fix round 1: qualify --verify records the outcome of a real extraction
-- against a candidate currently at verdict='pass'. 002 is already applied to
-- the real archive and checksummed, so this is a new file rather than an
-- edit — migrations are immutable once applied.
ALTER TABLE candidates ADD COLUMN priced_tiers INTEGER;
ALTER TABLE candidates ADD COLUMN verified_at TEXT;
