-- 003: weekly challenge runs (one per player per ISO week) for a fair, same-seed leaderboard.
CREATE TABLE IF NOT EXISTS challenge_runs (
  player_id TEXT NOT NULL,
  week TEXT NOT NULL,           -- e.g. 2026-W45
  run_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (player_id, week)
);
CREATE INDEX IF NOT EXISTS challenge_runs_week ON challenge_runs(week);
