-- 013: the on-chain economy. Additive only: no existing table changes, so rolling back is dropping these three.
--   DROP TABLE chain_ops; DROP TABLE player_wallets; DROP TABLE economy_state;
-- Player wallets are real NEAR testnet accounts under the player-parent account. The private key is stored
-- encrypted (AES-256-GCM, key from WALLET_KEY_SECRET) and never leaves the server.
CREATE TABLE IF NOT EXISTS player_wallets (
     player_id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL UNIQUE,
     public_key TEXT NOT NULL,
     enc_private_key TEXT NOT NULL,
     -- creating -> opening -> active | failed
     status TEXT NOT NULL,
     region_id TEXT,
     opened_interval INTEGER,
     opened_town_tick INTEGER,
     opening_cash_cc INTEGER,
     detail TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
-- Every chain operation, once. op_id is deterministic (grant:start:<player>, order:<id>, confirm:<id>, batch:town:<n>),
-- so a retry, a refresh or a restart can never submit the same thing twice.
CREATE TABLE IF NOT EXISTS chain_ops (
     op_id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     subject TEXT,
     signer TEXT NOT NULL,
     method TEXT NOT NULL,
     args_json TEXT NOT NULL,
     -- created -> submitted -> settled | failed ; local when no chain is configured
     status TEXT NOT NULL,
     tx_hash TEXT,
     detail TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     effects_applied INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
CREATE INDEX IF NOT EXISTS chain_ops_status ON chain_ops (status, created_at);
CREATE INDEX IF NOT EXISTS chain_ops_subject ON chain_ops (subject);
CREATE TABLE IF NOT EXISTS economy_state (
     key TEXT PRIMARY KEY,
     value_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
