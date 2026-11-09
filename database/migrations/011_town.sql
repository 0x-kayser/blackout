-- 011: Vesper Market, the shared market town. One state row; idempotent player trades and investments.
CREATE TABLE IF NOT EXISTS town_state (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     state_json TEXT NOT NULL,
     tick INTEGER NOT NULL,
     updated_at TEXT NOT NULL
   );
CREATE TABLE IF NOT EXISTS town_actions (
     user_id TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     request_json TEXT NOT NULL,
     result_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (user_id, idempotency_key)
   );
