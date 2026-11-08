-- 002: players own saves; auth identities map provider subjects to players.
-- A player is created once per identity and never duplicated on later logins.
CREATE TABLE IF NOT EXISTS players (
  player_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- 'guest' | 'registered'
  active_run_id TEXT,                        -- the player's current save
  near_account_mode TEXT NOT NULL DEFAULT 'custodial_vault',
  near_account_id TEXT,                      -- set only when a real testnet account/vault exists
  near_provisioning_state TEXT NOT NULL DEFAULT 'not_configured',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_identities (
  provider TEXT NOT NULL,                    -- 'guest' | 'supabase'
  subject TEXT NOT NULL,                     -- guest player id, or the provider's stable user id (JWT sub)
  player_id TEXT NOT NULL REFERENCES players(player_id),
  login_method TEXT,                         -- e.g. 'google', 'email' (from the provider's amr/app_metadata)
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS auth_identities_player ON auth_identities(player_id);

-- existing guest users become guest players (idempotent)
INSERT OR IGNORE INTO players (player_id, display_name, kind, created_at, updated_at)
  SELECT user_id, 'Guest operator', 'guest', created_at, created_at FROM users;
INSERT OR IGNORE INTO auth_identities (provider, subject, player_id, login_method, created_at, last_login_at)
  SELECT 'guest', user_id, user_id, 'guest', created_at, created_at FROM users;

CREATE INDEX IF NOT EXISTS events_run_type ON events(run_id, type);
CREATE INDEX IF NOT EXISTS chain_jobs_status ON chain_jobs(status, updated_at);
