-- Durable NEP-245 player listing operations. A submitted hash is never blindly re-broadcast.
CREATE TABLE IF NOT EXISTS marketplace_jobs (
  job_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- list | cancel | fill
  seller_id TEXT NOT NULL,             -- opaque authenticated player id, not a chain key
  merchant_id TEXT,
  token_id TEXT NOT NULL,
  amount TEXT NOT NULL,                -- U128 NEP-245 units (100 mL each)
  unit_price_cc TEXT NOT NULL,         -- informational on-chain ask, credits remain off-chain
  status TEXT NOT NULL,                -- pending | submitted | confirmed | failed | timeout
  tx_hash TEXT,
  signer_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS marketplace_jobs_status ON marketplace_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS marketplace_jobs_run ON marketplace_jobs(run_id, listing_id);
