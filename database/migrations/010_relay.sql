-- 010: NEP-366 relayer requests (persisted for idempotency, rate limits and audit).
CREATE TABLE IF NOT EXISTS relay_requests (
     request_id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     sender_id TEXT NOT NULL,
     receiver_id TEXT NOT NULL,
     methods TEXT NOT NULL,
     payload_hash TEXT NOT NULL,
     status TEXT NOT NULL,            -- 'rejected' | 'submitted' | 'succeeded' | 'failed'
     tx_hash TEXT,
     error TEXT,
     created_at TEXT NOT NULL,
     created_ms INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (user_id, idempotency_key)
   );
CREATE INDEX IF NOT EXISTS relay_user_time ON relay_requests(user_id, created_ms);
