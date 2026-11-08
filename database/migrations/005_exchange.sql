-- Shared Vesper Fuel Exchange: one order book for every city.

-- The exchange engine state (single row), saved in the same transaction as its events and jobs.
CREATE TABLE IF NOT EXISTS exchange_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exchange_events (
  seq INTEGER PRIMARY KEY,
  tick INTEGER NOT NULL,
  type TEXT NOT NULL,
  actors TEXT NOT NULL,                -- JSON array, e.g. ["player:abc","trader:kettle"]
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS exchange_events_type ON exchange_events(type, seq);

CREATE TABLE IF NOT EXISTS exchange_ledger (
  seq INTEGER PRIMARY KEY,
  entry_json TEXT NOT NULL
);

-- On-chain work. (op, op_id) is the contract's single-use id; a submitted hash is never re-broadcast.
CREATE TABLE IF NOT EXISTS exchange_jobs (
  op TEXT NOT NULL,                    -- deposit | redeem | ask | cancel | fill | import
  op_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,                -- pending | submitted | confirmed | failed | timeout
  tx_hash TEXT,
  signer_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (op, op_id)
);
CREATE INDEX IF NOT EXISTS exchange_jobs_status ON exchange_jobs(status, updated_at);

-- Settled exchange outcomes that must reach a player's city save exactly once.
CREATE TABLE IF NOT EXISTS exchange_city_effects (
  effect_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,                -- pending | applied | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS exchange_city_effects_status ON exchange_city_effects(status, created_at);

-- Request-level idempotency for exchange routes (survives pruning of old engine records).
CREATE TABLE IF NOT EXISTS exchange_requests (
  request_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Each player's exchange balance lives under a namespaced id on the contract: p<hash>.<vault account>.
CREATE TABLE IF NOT EXISTS player_chain_ids (
  player_id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
