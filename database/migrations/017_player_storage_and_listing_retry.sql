-- Tracks verified NEP-245 storage registration before a player wallet can hold resources or credits.
ALTER TABLE player_wallets ADD COLUMN storage_verified_at TEXT;

-- A declined NPC offer can be evaluated again with another deterministic chain operation and buyer.
ALTER TABLE resource_sales ADD COLUMN fill_attempt INTEGER NOT NULL DEFAULT 0;

-- A player can retry a withdrawal after a definitive contract refusal.
ALTER TABLE resource_sales ADD COLUMN cancel_attempt INTEGER NOT NULL DEFAULT 0;
