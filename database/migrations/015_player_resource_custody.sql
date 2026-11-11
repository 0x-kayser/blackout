-- One-time on-chain resource reconciliation and the boundary after which market/region epochs belong to a wallet.
-- NULL means this wallet still needs a safe bootstrap from current game inventory to its NEP-245 account.
ALTER TABLE player_wallets ADD COLUMN resource_opened_interval INTEGER;
ALTER TABLE player_wallets ADD COLUMN resource_opened_town_tick INTEGER;
ALTER TABLE player_wallets ADD COLUMN resource_pending_interval INTEGER;
ALTER TABLE player_wallets ADD COLUMN resource_pending_town_tick INTEGER;
ALTER TABLE player_wallets ADD COLUMN resource_pending_op_id TEXT;
