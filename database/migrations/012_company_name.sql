-- 012: players name their power company. Until they do, the shared market never shows a personal name.
ALTER TABLE players ADD COLUMN company_named INTEGER NOT NULL DEFAULT 0;
