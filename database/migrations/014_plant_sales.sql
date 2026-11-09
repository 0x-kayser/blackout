-- 014: player-to-player plant sales. Additive (rollback: DROP TABLE plant_sales).
-- listing -> listed -> buying -> sold ; or cancelled / failed. On NEAR the sale itself is one atomic plant_buy_for.
CREATE TABLE IF NOT EXISTS plant_sales (
     sale_id TEXT PRIMARY KEY,
     seller_id TEXT NOT NULL,
     seller_region TEXT NOT NULL,
     plant_id TEXT NOT NULL,
     token_id TEXT,
     name TEXT NOT NULL,
     tech TEXT NOT NULL,
     node_id TEXT NOT NULL,
     capacity_kw INTEGER NOT NULL,
     price_cc INTEGER NOT NULL,
     status TEXT NOT NULL,
     buyer_id TEXT,
     detail TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
CREATE INDEX IF NOT EXISTS plant_sales_status ON plant_sales (status);
