-- 016: player-owned resource listings backed by NEP-245 escrow on the root economy contract.
CREATE TABLE IF NOT EXISTS resource_sales (
  sale_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  seller_region TEXT NOT NULL,
  seller_account_id TEXT,
  item_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_cc INTEGER NOT NULL,
  status TEXT NOT NULL,
  buyer_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (seller_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS resource_sales_active ON resource_sales (status, updated_at);
CREATE INDEX IF NOT EXISTS resource_sales_seller ON resource_sales (seller_id, status);
