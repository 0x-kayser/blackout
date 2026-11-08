-- Which settlement the saved exchange state belongs to. A sandbox exchange must never silently continue
-- as a Testnet one: its balances were never on-chain.
ALTER TABLE exchange_state ADD COLUMN mode TEXT NOT NULL DEFAULT 'sandbox';
