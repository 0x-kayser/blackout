-- 009: the regional power game. One live region per player plus weekly challenge runs; idempotent actions;
-- settlement epochs (unique epoch id, stored once, submitted at most once); last-known world inputs.
CREATE TABLE IF NOT EXISTS regions (
     region_id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL,
     mode TEXT NOT NULL,              -- 'live' | 'challenge'
     week TEXT,                       -- ISO week for challenge runs
     seed INTEGER NOT NULL,
     state_json TEXT NOT NULL,
     state_version INTEGER NOT NULL,
     interval_no INTEGER NOT NULL,
     ended INTEGER NOT NULL DEFAULT 0,
     score INTEGER,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
CREATE INDEX IF NOT EXISTS regions_owner ON regions(owner_id, mode);
CREATE INDEX IF NOT EXISTS regions_board ON regions(mode, week, ended, score);

CREATE TABLE IF NOT EXISTS region_actions (
     region_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     interval_no INTEGER NOT NULL,
     idempotency_key TEXT NOT NULL,
     source TEXT NOT NULL,            -- 'player' | 'system'
     action_json TEXT NOT NULL,
     ok INTEGER NOT NULL,
     result_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (region_id, seq),
     UNIQUE (region_id, idempotency_key)
   );

CREATE TABLE IF NOT EXISTS settlement_epochs (
     epoch_id TEXT PRIMARY KEY,
     region_id TEXT NOT NULL,
     epoch_no INTEGER NOT NULL,
     from_interval INTEGER NOT NULL,
     to_interval INTEGER NOT NULL,
     hash TEXT NOT NULL,
     body_json TEXT NOT NULL,
     status TEXT NOT NULL,            -- 'local' | 'pending' | 'submitted' | 'confirmed' | 'failed'
     tx_hash TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
CREATE INDEX IF NOT EXISTS settlement_status ON settlement_epochs(status, created_at);
CREATE INDEX IF NOT EXISTS settlement_region ON settlement_epochs(region_id, epoch_no);

CREATE TABLE IF NOT EXISTS world_snapshots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     captured_at TEXT NOT NULL,
     source TEXT NOT NULL,
     snapshot_json TEXT NOT NULL
   );
