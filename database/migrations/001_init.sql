-- 001: initial schema (runs, events, ledger, actions, snapshots, chain jobs, replays)
CREATE TABLE IF NOT EXISTS users (
     user_id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,             -- 'guest' (no personal data stored)
     created_at TEXT NOT NULL
   );

CREATE TABLE IF NOT EXISTS sessions (
     session_id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(user_id),
     token_hash TEXT NOT NULL UNIQUE, -- sha256(token); the raw token is never stored
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   );

CREATE TABLE IF NOT EXISTS runs (
     run_id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL,
     seed INTEGER NOT NULL,
     scenario_id TEXT NOT NULL,
     scenario_version TEXT NOT NULL,
     mode TEXT NOT NULL,
     chain_mode TEXT NOT NULL,
     created_at TEXT NOT NULL,
     finished INTEGER NOT NULL DEFAULT 0,
     score INTEGER
   );

CREATE INDEX IF NOT EXISTS runs_owner ON runs(owner_id);

CREATE TABLE IF NOT EXISTS snapshots (
     run_id TEXT NOT NULL,
     kind TEXT NOT NULL,              -- 'latest' | 'day' | 'wave'
     tick INTEGER NOT NULL,
     state_version INTEGER NOT NULL,
     action_seq INTEGER NOT NULL,     -- number of actions applied when taken
     state_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (run_id, kind, tick)
   );

CREATE TABLE IF NOT EXISTS actions (
     run_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     tick INTEGER NOT NULL,
     idempotency_key TEXT NOT NULL,
     source TEXT NOT NULL,            -- 'player' | 'chain_worker'
     action_json TEXT NOT NULL,
     ok INTEGER NOT NULL,
     result_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (run_id, seq),
     UNIQUE (run_id, idempotency_key)
   );

CREATE TABLE IF NOT EXISTS events (
     run_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     type TEXT NOT NULL,
     day INTEGER NOT NULL,
     tick INTEGER NOT NULL,
     event_json TEXT NOT NULL,
     server_time TEXT NOT NULL,
     PRIMARY KEY (run_id, seq)
   );

CREATE TABLE IF NOT EXISTS ledger (
     run_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     entry_json TEXT NOT NULL,
     PRIMARY KEY (run_id, seq)
   );

CREATE TABLE IF NOT EXISTS chain_jobs (
     trade_key TEXT PRIMARY KEY,      -- "<runId>:<tradeId>", also the on-chain trade_id (idempotent)
     run_id TEXT NOT NULL,
     trade_id TEXT NOT NULL,
     merchant_id TEXT NOT NULL,
     token_id TEXT NOT NULL,
     amount TEXT NOT NULL,            -- U128 string
     status TEXT NOT NULL,            -- pending | submitted | confirmed | failed | timeout
     tx_hash TEXT,
     signer_id TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     updated_at TEXT NOT NULL
   );

CREATE TABLE IF NOT EXISTS replays (
     replay_id TEXT PRIMARY KEY,
     summary_json TEXT NOT NULL,
     events_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );

CREATE TABLE IF NOT EXISTS leaderboard (
     run_id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL,
     seed INTEGER NOT NULL,
     scenario_id TEXT NOT NULL,
     score INTEGER NOT NULL,
     net_worth_cc INTEGER NOT NULL,
     reliability_bps INTEGER NOT NULL,
     created_at TEXT NOT NULL
   );
