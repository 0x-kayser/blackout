-- A player who took self-custody of their exchange warehouse (phase 6). The server stops acting for them.
ALTER TABLE player_chain_ids ADD COLUMN self_custody INTEGER NOT NULL DEFAULT 0;
