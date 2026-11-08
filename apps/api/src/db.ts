/**
 * SQLite persistence via Node's built-in node:sqlite (no native build step).
 * Append-only events/ledger, idempotent actions, snapshots, chain bookkeeping.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = DatabaseSync;

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../database/migrations/", import.meta.url));

/** Applies database/migrations/NNN_*.sql in order, each once, inside a transaction. */
export function migrate(db: Db, dir = MIGRATIONS_DIR): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);");
  const done = new Set((db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
      db.exec("COMMIT");
      applied.push(f);
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return applied;
}

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const nowIso = () => new Date().toISOString();
