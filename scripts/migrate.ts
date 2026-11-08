/** pnpm db:migrate — applies database/migrations to DATABASE_PATH (default apps/api/data/blackout.sqlite). */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "../apps/api/src/db.ts";

const path = process.env.DATABASE_PATH ?? "apps/api/data/blackout.sqlite";
mkdirSync(dirname(path), { recursive: true });
const db = new DatabaseSync(path);
const applied = migrate(db);
console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
db.close();
